import {
  AgentRecordSchema,
  CreatorQuotaRecordSchema,
  DecisionRecordSchema,
  GoalRecordSchema,
  IdempotencyRecordSchema,
  LeaseRecordSchema,
  LineageNodeRecordSchema,
  LineageRecordSchema,
  MaterialRecordSchema,
  MemoryRecordSchema,
  OrganismRecordSchema,
  RegionRecordSchema,
  ResourceNodeRecordSchema,
  SignalRecordSchema,
  StoredRecordInvalid,
  StructureRecordSchema,
  WatermarkRecordSchema,
  WorldEventSchema,
  WorldRecordSchema,
  upconvert,
  type DecisionRecord,
  type GoalRecord,
  type LeaseRecord,
  type StoredWorldEvent,
} from '@autocosm/domain';
import { RestError, TableClient, TableServiceClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import type { z } from 'zod';
import { assertProductionSafeStorage } from './guardrails.js';
import { eventEpochOf } from './memory-repository.js';
import {
  ConcurrencyConflict,
  boundedLimit,
  type AgentStore,
  type ControlStore,
  type DecisionClaim,
  type DecisionStore,
  type ETag,
  type EventStore,
  type GoalStore,
  type LineageStore,
  type MaterialStore,
  type MemoryStore,
  type OrganismStore,
  type Page,
  type PageRequest,
  type RegionStore,
  type ResourceStore,
  type SignalStore,
  type StructureStore,
  type WorldRepository,
  type WorldStore,
} from './ports.js';

/**
 * Azure Table Storage adapter.
 *
 * Constraints that shape every decision here:
 *
 * - Authentication is managed identity only. No account key, connection string or SAS is ever
 *   accepted, produced or logged; `assertProductionSafeStorage` enforces that at construction.
 * - A Table entity is capped at 1 MiB and a string property at 64 KiB, so each record is stored
 *   as one bounded JSON `body` property and nothing unbounded (a whole world, a full event
 *   history, an entire memory transcript) is ever a single entity.
 * - Partition keys are chosen so ordinary reads are single-partition or a narrow key range:
 *   world, world+region, world+agent, world+lineage, world+event-epoch.
 * - Every conditional write carries an ETag and surfaces HTTP 409/412 as `ConcurrencyConflict`.
 */

export const TABLE_NAMES = {
  worlds: 'worlds',
  regions: 'regions',
  agents: 'agents',
  lineages: 'lineages',
  lineageNodes: 'lineagenodes',
  organisms: 'organisms',
  structures: 'structures',
  materials: 'materials',
  resources: 'resources',
  memories: 'memories',
  signals: 'signals',
  goals: 'goals',
  events: 'events',
  decisions: 'decisions',
  control: 'control',
} as const;

export interface AzureTableRepositoryOptions {
  /** Bare service endpoint, e.g. `https://acct.table.core.windows.net`. Never a SAS URL. */
  readonly tableEndpoint: string;
  readonly isProduction: boolean;
  /** Workload identity client id, so credential selection is unambiguous in production. */
  readonly managedIdentityClientId?: string | undefined;
  /** Injected for tests. Production always constructs `DefaultAzureCredential`. */
  readonly credential?: TokenCredential | undefined;
}

/** Stored shape. `rv` is duplicated out of the body so a scan can filter by record version. */
interface Envelope {
  partitionKey: string;
  rowKey: string;
  rv: number;
  body: string;
  etag?: string;
}

/** Azure caps a string property at 64 KiB of UTF-16; refuse well before that. */
const MAX_BODY_CHARS = 30_000;

function envelope(partitionKey: string, rowKey: string, record: unknown, rv: number): Envelope {
  const body = JSON.stringify(record);
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(
      `Record ${partitionKey}/${rowKey} serialises to ${body.length} chars, above the ${MAX_BODY_CHARS} bound`,
    );
  }
  return { partitionKey, rowKey, rv, body };
}

function decode<T extends { rv: number }>(entity: Envelope, schema: z.ZodType<T>): T {
  return upconvert(JSON.parse(entity.body), schema);
}

function decodeEvent(entity: Envelope): StoredWorldEvent {
  const parsed = WorldEventSchema.safeParse(JSON.parse(entity.body));
  if (parsed.success) return parsed.data;
  throw new StoredRecordInvalid(
    parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
  );
}

function isConflict(error: unknown): boolean {
  return error instanceof RestError && (error.statusCode === 409 || error.statusCode === 412);
}

function isNotFound(error: unknown): boolean {
  return error instanceof RestError && error.statusCode === 404;
}

const worldPartition = (worldId: string): string => `w~${worldId}`;
const regionPartition = (worldId: string, regionId: string): string => `w~${worldId}~r~${regionId}`;
const agentPartition = (worldId: string, agentId: string): string => `w~${worldId}~a~${agentId}`;
const lineagePartition = (worldId: string, lineageId: string): string =>
  `w~${worldId}~l~${lineageId}`;
const epochPartition = (worldId: string, epoch: number): string =>
  `w~${worldId}~e~${String(epoch).padStart(6, '0')}`;

/**
 * Half-open key range covering every partition with the given discriminator.
 *
 * `~` is the highest-sorting character we use, so the exclusive upper bound is simply the next
 * letter after the discriminator: partitions `w~x~r~…` end strictly before `w~x~s`.
 */
function partitionRange(worldId: string, discriminator: string): { low: string; high: string } {
  const next = String.fromCharCode(discriminator.charCodeAt(0) + 1);
  return { low: `w~${worldId}~${discriminator}~`, high: `w~${worldId}~${next}` };
}

const rangeFilter = (range: { low: string; high: string }): string =>
  odata`PartitionKey ge ${range.low} and PartitionKey lt ${range.high}`;

/** Row keys sort lexicographically, so ticks are zero-padded to keep chronological order. */
const eventRowKey = (event: StoredWorldEvent): string =>
  `${String(event.tick).padStart(12, '0')}~${event.id}`;

/** Continuation tokens are opaque to callers; encode so they survive a query string round trip. */
const encodeToken = (token: string): string => Buffer.from(token, 'utf8').toString('base64url');
const decodeToken = (token: string): string => Buffer.from(token, 'base64url').toString('utf8');

export class AzureTableWorldRepository implements WorldRepository {
  readonly #clients = new Map<string, TableClient>();
  readonly #service: TableServiceClient;
  readonly #endpoint: string;
  readonly #credential: TokenCredential;
  readonly #isProduction: boolean;

  constructor(options: AzureTableRepositoryOptions) {
    assertProductionSafeStorage({
      mode: 'managedIdentity',
      isProduction: options.isProduction,
      tableEndpoint: options.tableEndpoint,
    });
    this.#endpoint = options.tableEndpoint.replace(/\/+$/u, '');
    this.#isProduction = options.isProduction;
    this.#credential =
      options.credential ??
      new DefaultAzureCredential(
        options.managedIdentityClientId === undefined
          ? {}
          : { managedIdentityClientId: options.managedIdentityClientId },
      );
    this.#service = new TableServiceClient(this.#endpoint, this.#credential);
  }

  #table(name: string): TableClient {
    const existing = this.#clients.get(name);
    if (existing) return existing;
    const client = new TableClient(this.#endpoint, name, this.#credential);
    this.#clients.set(name, client);
    return client;
  }

  /**
   * Creating a table is a *control-plane* action
   * (`Microsoft.Storage/storageAccounts/tableServices/tables/write`); the data-plane roles the
   * workloads hold deliberately do not include it. So in production the tables are declared in
   * Bicep and this only verifies the account is reachable and the credential works — attempting
   * `createTable` there would fail with 403 and mask a genuine connectivity or RBAC problem.
   *
   * Locally (Azurite, or a developer's own account) nothing has declared the tables, so they are
   * created on demand.
   */
  async initialise(): Promise<void> {
    if (this.#isProduction) {
      await this.ping();
      return;
    }
    for (const name of Object.values(TABLE_NAMES)) {
      try {
        await this.#service.createTable(name);
      } catch (error) {
        // 409 means the table already exists, which is the normal steady state.
        if (!isConflict(error)) throw error;
      }
    }
  }

  async ping(): Promise<void> {
    // A point read of a row that will never exist is the cheapest authenticated round trip.
    try {
      await this.#table(TABLE_NAMES.control).getEntity('ping', 'ping');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async #upsert(table: string, entity: Envelope): Promise<ETag> {
    const result = await this.#table(table).upsertEntity(entity, 'Replace');
    return result.etag ?? '';
  }

  async #conditionalPut(
    table: string,
    entity: Envelope,
    etag: ETag | undefined,
    label: string,
  ): Promise<ETag> {
    try {
      if (etag === undefined) {
        const created = await this.#table(table).createEntity(entity);
        return created.etag ?? '';
      }
      const updated = await this.#table(table).updateEntity(entity, 'Replace', { etag });
      return updated.etag ?? '';
    } catch (error) {
      if (isConflict(error)) throw new ConcurrencyConflict(label);
      throw error;
    }
  }

  async #get(table: string, pk: string, rk: string): Promise<Envelope | undefined> {
    try {
      return await this.#table(table).getEntity<Envelope>(pk, rk);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  #list(table: string, filter: string | undefined): AsyncIterable<Envelope> {
    return this.#table(table).listEntities<Envelope>(
      filter === undefined ? {} : { queryOptions: { filter } },
    );
  }

  /**
   * Page a filtered query. `maxPageSize` bounds the round trip and the continuation token is
   * handed straight back to Azure, so nothing is buffered without bound.
   */
  async #pageRaw(
    table: string,
    filter: string | undefined,
    request: PageRequest | undefined,
  ): Promise<{ entities: readonly Envelope[]; continuation?: string }> {
    const limit = boundedLimit(request?.limit);
    const iterator = this.#table(table)
      .listEntities<Envelope>(filter === undefined ? {} : { queryOptions: { filter } })
      .byPage({
        maxPageSize: limit,
        ...(request?.continuation === undefined
          ? {}
          : { continuationToken: decodeToken(request.continuation) }),
      });
    const first = await iterator.next();
    if (first.done === true) return { entities: [] };
    const page = first.value;
    const token = page.continuationToken;
    return token === undefined || token === ''
      ? { entities: page }
      : { entities: page, continuation: encodeToken(token) };
  }

  async #page<T extends { rv: number }>(
    table: string,
    filter: string | undefined,
    schema: z.ZodType<T>,
    request: PageRequest | undefined,
  ): Promise<Page<T>> {
    const { entities, continuation } = await this.#pageRaw(table, filter, request);
    const items = entities.map((entity) => decode(entity, schema));
    return continuation === undefined ? { items } : { items, continuation };
  }

  /** Collect a bounded number of entities across pages. Used only where the set is known small. */
  async #collect<T extends { rv: number }>(
    table: string,
    filter: string | undefined,
    schema: z.ZodType<T>,
    cap: number,
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const entity of this.#list(table, filter)) {
      out.push(decode(entity, schema));
      if (out.length >= cap) break;
    }
    return out;
  }

  async #putMany(table: string, entities: readonly Envelope[]): Promise<void> {
    // Table transactions require a single partition and cap at 100 operations, and a partial
    // failure must remain repairable, so writes are individual idempotent upserts.
    for (const entity of entities) await this.#upsert(table, entity);
  }

  async #deleteIfPresent(table: string, pk: string, rk: string): Promise<void> {
    try {
      await this.#table(table).deleteEntity(pk, rk);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  readonly worlds: WorldStore = {
    get: async (worldId) => {
      const entity = await this.#get(TABLE_NAMES.worlds, 'worlds', worldId);
      if (entity === undefined) return undefined;
      return { value: decode(entity, WorldRecordSchema), etag: entity.etag ?? '' };
    },
    list: async () => this.#collect(TABLE_NAMES.worlds, undefined, WorldRecordSchema, 50),
    put: async (record, etag) => {
      const v = WorldRecordSchema.parse(record);
      return this.#conditionalPut(
        TABLE_NAMES.worlds,
        envelope('worlds', v.id, v, v.rv),
        etag,
        'world',
      );
    },
  };

  readonly regions: RegionStore = {
    get: async (worldId, regionId) => {
      const entity = await this.#get(TABLE_NAMES.regions, worldPartition(worldId), regionId);
      return entity === undefined ? undefined : decode(entity, RegionRecordSchema);
    },
    listByWorld: async (worldId) =>
      this.#collect(
        TABLE_NAMES.regions,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
        RegionRecordSchema,
        4096,
      ),
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.regions,
        records.map((r) => {
          const v = RegionRecordSchema.parse(r);
          return envelope(worldPartition(v.worldId), v.id, v, v.rv);
        }),
      );
    },
  };

  readonly agents: AgentStore = {
    get: async (worldId, agentId) => {
      const entity = await this.#get(TABLE_NAMES.agents, worldPartition(worldId), agentId);
      if (entity === undefined) return undefined;
      return { value: decode(entity, AgentRecordSchema), etag: entity.etag ?? '' };
    },
    listByWorld: async (worldId, page) =>
      this.#page(
        TABLE_NAMES.agents,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
        AgentRecordSchema,
        page,
      ),
    put: async (record, etag) => {
      const v = AgentRecordSchema.parse(record);
      return this.#conditionalPut(
        TABLE_NAMES.agents,
        envelope(worldPartition(v.worldId), v.id, v, v.rv),
        etag,
        'agent',
      );
    },
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.agents,
        records.map((r) => {
          const v = AgentRecordSchema.parse(r);
          return envelope(worldPartition(v.worldId), v.id, v, v.rv);
        }),
      );
    },
  };

  readonly lineages: LineageStore = {
    get: async (worldId, lineageId) => {
      const entity = await this.#get(TABLE_NAMES.lineages, worldPartition(worldId), lineageId);
      return entity === undefined ? undefined : decode(entity, LineageRecordSchema);
    },
    listByWorld: async (worldId, page) =>
      this.#page(
        TABLE_NAMES.lineages,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
        LineageRecordSchema,
        page,
      ),
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.lineages,
        records.map((r) => {
          const v = LineageRecordSchema.parse(r);
          return envelope(worldPartition(v.worldId), v.id, v, v.rv);
        }),
      );
    },
    listNodes: async (worldId, lineageId, page) =>
      this.#page(
        TABLE_NAMES.lineageNodes,
        odata`PartitionKey eq ${lineagePartition(worldId, lineageId)}`,
        LineageNodeRecordSchema,
        page,
      ),
    putNodes: async (worldId, records) => {
      await this.#putMany(
        TABLE_NAMES.lineageNodes,
        records.map((r) => {
          const v = LineageNodeRecordSchema.parse(r);
          return envelope(
            lineagePartition(worldId, v.lineageId),
            `${String(v.bornAtTick).padStart(12, '0')}~${v.organismId}`,
            v,
            v.rv,
          );
        }),
      );
    },
  };

  readonly organisms: OrganismStore = {
    get: async (worldId, organismId) => {
      const found = await this.#collect(
        TABLE_NAMES.organisms,
        `${rangeFilter(partitionRange(worldId, 'r'))} and ${odata`RowKey eq ${organismId}`}`,
        OrganismRecordSchema,
        1,
      );
      return found[0];
    },
    listByRegion: async (worldId, regionId, page) =>
      this.#page(
        TABLE_NAMES.organisms,
        odata`PartitionKey eq ${regionPartition(worldId, regionId)}`,
        OrganismRecordSchema,
        page,
      ),
    listByWorld: async (worldId, page) =>
      this.#page(
        TABLE_NAMES.organisms,
        rangeFilter(partitionRange(worldId, 'r')),
        OrganismRecordSchema,
        page,
      ),
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.organisms,
        records.map((r) => {
          const v = OrganismRecordSchema.parse(r);
          return envelope(regionPartition(v.worldId, v.regionId), v.id, v, v.rv);
        }),
      );
    },
    deleteMany: async (worldId, keys) => {
      for (const key of keys) {
        await this.#deleteIfPresent(
          TABLE_NAMES.organisms,
          regionPartition(worldId, key.regionId),
          key.organismId,
        );
      }
    },
  };

  readonly structures: StructureStore = {
    get: async (worldId, structureId) => {
      const found = await this.#collect(
        TABLE_NAMES.structures,
        `${rangeFilter(partitionRange(worldId, 'r'))} and ${odata`RowKey eq ${structureId}`}`,
        StructureRecordSchema,
        1,
      );
      return found[0];
    },
    listByRegion: async (worldId, regionId, page) =>
      this.#page(
        TABLE_NAMES.structures,
        odata`PartitionKey eq ${regionPartition(worldId, regionId)}`,
        StructureRecordSchema,
        page,
      ),
    listByWorld: async (worldId, page) =>
      this.#page(
        TABLE_NAMES.structures,
        rangeFilter(partitionRange(worldId, 'r')),
        StructureRecordSchema,
        page,
      ),
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.structures,
        records.map((r) => {
          const v = StructureRecordSchema.parse(r);
          return envelope(regionPartition(v.worldId, v.regionId), v.id, v, v.rv);
        }),
      );
    },
    deleteMany: async (worldId, keys) => {
      for (const key of keys) {
        await this.#deleteIfPresent(
          TABLE_NAMES.structures,
          regionPartition(worldId, key.regionId),
          key.structureId,
        );
      }
    },
  };

  readonly materials: MaterialStore = {
    listByWorld: async (worldId) =>
      this.#collect(
        TABLE_NAMES.materials,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
        MaterialRecordSchema,
        512,
      ),
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.materials,
        records.map((r) => {
          const v = MaterialRecordSchema.parse(r);
          return envelope(worldPartition(v.worldId), v.id, v, v.rv);
        }),
      );
    },
  };

  readonly resources: ResourceStore = {
    listByRegion: async (worldId, regionId, page) =>
      this.#page(
        TABLE_NAMES.resources,
        odata`PartitionKey eq ${regionPartition(worldId, regionId)}`,
        ResourceNodeRecordSchema,
        page,
      ),
    listByWorld: async (worldId, page) =>
      this.#page(
        TABLE_NAMES.resources,
        rangeFilter(partitionRange(worldId, 'r')),
        ResourceNodeRecordSchema,
        page,
      ),
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.resources,
        records.map((r) => {
          const v = ResourceNodeRecordSchema.parse(r);
          return envelope(regionPartition(v.worldId, v.regionId), v.id, v, v.rv);
        }),
      );
    },
  };

  readonly memories: MemoryStore = {
    listByAgent: async (worldId, agentId, page) =>
      this.#page(
        TABLE_NAMES.memories,
        odata`PartitionKey eq ${agentPartition(worldId, agentId)}`,
        MemoryRecordSchema,
        page,
      ),
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.memories,
        records.map((r) => {
          const v = MemoryRecordSchema.parse(r);
          return envelope(agentPartition(v.worldId, v.agentId), v.id, v, v.rv);
        }),
      );
    },
    deleteMany: async (worldId, keys) => {
      for (const key of keys) {
        await this.#deleteIfPresent(
          TABLE_NAMES.memories,
          agentPartition(worldId, key.agentId),
          key.memoryId,
        );
      }
    },
  };

  readonly signals: SignalStore = {
    listByWorld: async (worldId) =>
      this.#collect(
        TABLE_NAMES.signals,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
        SignalRecordSchema,
        2048,
      ),
    replaceAll: async (worldId, records) => {
      // Signals are ephemeral per-tick state, so the whole partition is swapped rather than
      // diffed. The partition is bounded by the living population of one world.
      const pk = worldPartition(worldId);
      for await (const entity of this.#list(TABLE_NAMES.signals, odata`PartitionKey eq ${pk}`)) {
        await this.#deleteIfPresent(TABLE_NAMES.signals, entity.partitionKey, entity.rowKey);
      }
      await this.#putMany(
        TABLE_NAMES.signals,
        records.map((r) => {
          const v = SignalRecordSchema.parse(r);
          return envelope(pk, `${v.organismId}~${v.channel}`, v, v.rv);
        }),
      );
    },
  };

  readonly goals: GoalStore = {
    get: async (worldId, agentId, goalId) => {
      const entity = await this.#get(TABLE_NAMES.goals, agentPartition(worldId, agentId), goalId);
      if (entity === undefined) return undefined;
      return { value: decode(entity, GoalRecordSchema), etag: entity.etag ?? '' };
    },
    listByAgent: async (worldId, agentId, page) =>
      this.#page(
        TABLE_NAMES.goals,
        odata`PartitionKey eq ${agentPartition(worldId, agentId)}`,
        GoalRecordSchema,
        page,
      ),
    listPending: async (worldId, limit) => {
      const bound = boundedLimit(limit);
      const out: GoalRecord[] = [];
      for await (const entity of this.#list(
        TABLE_NAMES.goals,
        rangeFilter(partitionRange(worldId, 'a')),
      )) {
        const record = decode(entity, GoalRecordSchema);
        if (record.status !== 'pending') continue;
        out.push(record);
        if (out.length >= bound) break;
      }
      return out;
    },
    put: async (record, etag) => {
      const v = GoalRecordSchema.parse(record);
      return this.#conditionalPut(
        TABLE_NAMES.goals,
        envelope(agentPartition(v.worldId, v.agentId), v.id, v, v.rv),
        etag,
        'goal',
      );
    },
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.goals,
        records.map((r) => {
          const v = GoalRecordSchema.parse(r);
          return envelope(agentPartition(v.worldId, v.agentId), v.id, v, v.rv);
        }),
      );
    },
  };

  readonly events: EventStore = {
    append: async (events) => {
      let written = 0;
      let skipped = 0;
      for (const event of events) {
        const v = WorldEventSchema.parse(event);
        const entity = envelope(
          epochPartition(v.worldId, eventEpochOf(v.tick)),
          eventRowKey(v),
          v,
          v.version,
        );
        try {
          // createEntity returns 409 when the deterministic event id is already present, which
          // is exactly the idempotency guarantee a retried tick execution needs.
          await this.#table(TABLE_NAMES.events).createEntity(entity);
          written += 1;
        } catch (error) {
          if (isConflict(error)) {
            skipped += 1;
            continue;
          }
          throw error;
        }
      }
      return { written, skipped };
    },
    query: async (query) => {
      // Epoch partitioning keeps a bounded tick window inside a bounded key range.
      const lowEpoch = query.sinceTick === undefined ? 0 : eventEpochOf(query.sinceTick);
      const highEpoch = query.untilTick === undefined ? 999_999 : eventEpochOf(query.untilTick);
      const filter = [
        odata`PartitionKey ge ${epochPartition(query.worldId, lowEpoch)}`,
        odata`PartitionKey le ${`${epochPartition(query.worldId, highEpoch)}~`}`,
      ].join(' and ');
      const { entities, continuation } = await this.#pageRaw(TABLE_NAMES.events, filter, query);
      const items = entities
        .map(decodeEvent)
        .filter((event) => {
          if (query.regionId !== undefined && event.regionId !== query.regionId) return false;
          if (query.lineageId !== undefined && event.lineageId !== query.lineageId) return false;
          if (query.sinceTick !== undefined && event.tick < query.sinceTick) return false;
          if (query.untilTick !== undefined && event.tick > query.untilTick) return false;
          return true;
        })
        .sort((a, b) => b.tick - a.tick || (a.id < b.id ? 1 : -1));
      return continuation === undefined ? { items } : { items, continuation };
    },
    compact: async (worldId, beforeTick, limit) => {
      const bound = boundedLimit(limit);
      let removed = 0;
      const lastEpoch = eventEpochOf(Math.max(0, beforeTick - 1));
      const filter = [
        odata`PartitionKey ge ${epochPartition(worldId, 0)}`,
        odata`PartitionKey le ${`${epochPartition(worldId, lastEpoch)}~`}`,
      ].join(' and ');
      for await (const entity of this.#list(TABLE_NAMES.events, filter)) {
        if (removed >= bound) break;
        const tick = Number.parseInt(entity.rowKey.slice(0, 12), 10);
        if (!Number.isFinite(tick) || tick >= beforeTick) continue;
        await this.#deleteIfPresent(TABLE_NAMES.events, entity.partitionKey, entity.rowKey);
        removed += 1;
      }
      return removed;
    },
  };

  readonly decisions: DecisionStore = {
    put: async (record, etag) => {
      const v = DecisionRecordSchema.parse(record);
      return this.#conditionalPut(
        TABLE_NAMES.decisions,
        envelope(worldPartition(v.worldId), v.id, v, v.rv),
        etag,
        'decision',
      );
    },
    putMany: async (records) => {
      await this.#putMany(
        TABLE_NAMES.decisions,
        records.map((r) => {
          const v = DecisionRecordSchema.parse(r);
          return envelope(worldPartition(v.worldId), v.id, v, v.rv);
        }),
      );
    },
    get: async (worldId, decisionId) => {
      const entity = await this.#get(TABLE_NAMES.decisions, worldPartition(worldId), decisionId);
      if (entity === undefined) return undefined;
      return { value: decode(entity, DecisionRecordSchema), etag: entity.etag ?? '' };
    },
    claimPending: async ({ worldId, holder, limit, nowEpochMs, claimTtlMs }) => {
      const bound = boundedLimit(limit);
      const claimed: DecisionClaim[] = [];
      for await (const entity of this.#list(
        TABLE_NAMES.decisions,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
      )) {
        if (claimed.length >= bound) break;
        const record = decode(entity, DecisionRecordSchema);
        const claimable =
          record.status === 'pending' ||
          (record.status === 'claimed' && (record.claimExpiresAtEpochMs ?? 0) <= nowEpochMs);
        if (!claimable) continue;
        const updated: DecisionRecord = DecisionRecordSchema.parse({
          ...record,
          status: 'claimed',
          claimedBy: holder,
          claimExpiresAtEpochMs: nowEpochMs + claimTtlMs,
          attempts: record.attempts + 1,
        });
        try {
          const result = await this.#table(TABLE_NAMES.decisions).updateEntity(
            envelope(entity.partitionKey, entity.rowKey, updated, updated.rv),
            'Replace',
            { etag: entity.etag ?? '' },
          );
          claimed.push({ record: updated, etag: result.etag ?? '' });
        } catch (error) {
          // Another think execution won the race for this row; keep scanning.
          if (!isConflict(error)) throw error;
        }
      }
      return claimed;
    },
    listProposed: async (worldId, limit) => {
      const bound = boundedLimit(limit);
      const out: DecisionRecord[] = [];
      for await (const entity of this.#list(
        TABLE_NAMES.decisions,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
      )) {
        if (out.length >= bound) break;
        const record = decode(entity, DecisionRecordSchema);
        if (record.status === 'proposed') out.push(record);
      }
      return out;
    },
    countByStatus: async (worldId) => {
      const counts: Record<string, number> = {};
      for await (const entity of this.#list(
        TABLE_NAMES.decisions,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
      )) {
        const record = decode(entity, DecisionRecordSchema);
        counts[record.status] = (counts[record.status] ?? 0) + 1;
      }
      return counts;
    },
    expireStaleClaims: async (worldId, nowEpochMs, limit) => {
      const bound = boundedLimit(limit);
      let released = 0;
      for await (const entity of this.#list(
        TABLE_NAMES.decisions,
        odata`PartitionKey eq ${worldPartition(worldId)}`,
      )) {
        if (released >= bound) break;
        const record = decode(entity, DecisionRecordSchema);
        if (record.status !== 'claimed') continue;
        if ((record.claimExpiresAtEpochMs ?? 0) > nowEpochMs) continue;
        const { claimedBy: _claimedBy, claimExpiresAtEpochMs: _expiry, ...rest } = record;
        const reopened = DecisionRecordSchema.parse({ ...rest, status: 'pending' });
        try {
          await this.#table(TABLE_NAMES.decisions).updateEntity(
            envelope(entity.partitionKey, entity.rowKey, reopened, reopened.rv),
            'Replace',
            { etag: entity.etag ?? '' },
          );
          released += 1;
        } catch (error) {
          if (!isConflict(error)) throw error;
        }
      }
      return released;
    },
    deleteMany: async (worldId, decisionIds) => {
      for (const id of decisionIds) {
        await this.#deleteIfPresent(TABLE_NAMES.decisions, worldPartition(worldId), id);
      }
    },
  };

  readonly control: ControlStore = {
    getWatermark: async (worldId, name) => {
      const entity = await this.#get(TABLE_NAMES.control, `${worldPartition(worldId)}~wm`, name);
      if (entity === undefined) return undefined;
      return { value: decode(entity, WatermarkRecordSchema), etag: entity.etag ?? '' };
    },
    putWatermark: async (record, etag) => {
      const v = WatermarkRecordSchema.parse(record);
      return this.#conditionalPut(
        TABLE_NAMES.control,
        envelope(`${worldPartition(v.worldId)}~wm`, v.name, v, v.rv),
        etag,
        'watermark',
      );
    },
    acquireLease: async ({ worldId, name, holder, nowEpochMs, ttlMs }) => {
      const pk = `${worldPartition(worldId)}~lease`;
      const lease: LeaseRecord = LeaseRecordSchema.parse({
        rv: 1,
        worldId,
        name,
        holder,
        expiresAtEpochMs: nowEpochMs + ttlMs,
      });
      const existing = await this.#get(TABLE_NAMES.control, pk, name);
      try {
        if (existing === undefined) {
          await this.#table(TABLE_NAMES.control).createEntity(envelope(pk, name, lease, lease.rv));
          return lease;
        }
        const current = decode(existing, LeaseRecordSchema);
        if (current.expiresAtEpochMs > nowEpochMs && current.holder !== holder) return undefined;
        await this.#table(TABLE_NAMES.control).updateEntity(
          envelope(pk, name, lease, lease.rv),
          'Replace',
          { etag: existing.etag ?? '' },
        );
        return lease;
      } catch (error) {
        // Losing the race is a normal outcome for a lease, not a failure.
        if (isConflict(error)) return undefined;
        throw error;
      }
    },
    releaseLease: async (worldId, name, holder) => {
      const pk = `${worldPartition(worldId)}~lease`;
      const existing = await this.#get(TABLE_NAMES.control, pk, name);
      if (existing === undefined) return;
      if (decode(existing, LeaseRecordSchema).holder !== holder) return;
      try {
        await this.#table(TABLE_NAMES.control).deleteEntity(pk, name, {
          etag: existing.etag ?? '',
        });
      } catch (error) {
        if (!isConflict(error) && !isNotFound(error)) throw error;
      }
    },
    getQuota: async (worldId, creatorId, dayKey) => {
      const entity = await this.#get(
        TABLE_NAMES.control,
        `${worldPartition(worldId)}~quota`,
        `${creatorId}~${dayKey}`,
      );
      if (entity === undefined) return undefined;
      return { value: decode(entity, CreatorQuotaRecordSchema), etag: entity.etag ?? '' };
    },
    putQuota: async (record, etag) => {
      const v = CreatorQuotaRecordSchema.parse(record);
      return this.#conditionalPut(
        TABLE_NAMES.control,
        envelope(`${worldPartition(v.worldId)}~quota`, `${v.creatorId}~${v.dayKey}`, v, v.rv),
        etag,
        'quota',
      );
    },
    getIdempotency: async (worldId, key) => {
      const entity = await this.#get(TABLE_NAMES.control, `${worldPartition(worldId)}~idem`, key);
      return entity === undefined ? undefined : decode(entity, IdempotencyRecordSchema);
    },
    putIdempotency: async (record) => {
      const v = IdempotencyRecordSchema.parse(record);
      await this.#upsert(
        TABLE_NAMES.control,
        envelope(`${worldPartition(v.worldId)}~idem`, v.key, v, v.rv),
      );
    },
  };
}

export function createAzureTableRepository(
  options: AzureTableRepositoryOptions,
): AzureTableWorldRepository {
  return new AzureTableWorldRepository(options);
}
