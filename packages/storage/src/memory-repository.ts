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
  StructureRecordSchema,
  WatermarkRecordSchema,
  WorldEventSchema,
  WorldRecordSchema,
  upconvert,
  type DecisionRecord,
  type GoalRecord,
  type LeaseRecord,
  type StoredWorldEvent,
  type WorldRecord,
} from '@autocosm/domain';
import type { z } from 'zod';
import { decodeEventCursor, pageEventsNewestFirst } from './event-paging.js';
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
  type Tagged,
  type WorldRepository,
  type WorldStore,
} from './ports.js';

/**
 * In-memory storage adapter.
 *
 * This is not a stub: it enforces the same contract as the Azure adapter — record validation on
 * write and read, ETag optimistic concurrency, claim expiry, idempotent event append, and
 * bounded paging. That is what makes it a legitimate substrate for the local demo and for the
 * storage contract tests that both adapters must pass.
 *
 * Records are stored as JSON strings, so a caller cannot mutate a stored object by holding a
 * reference to it — the same isolation the network gives the real adapter.
 */

interface Cell {
  json: string;
  etag: ETag;
}

class Table {
  readonly #rows = new Map<string, Map<string, Cell>>();
  #version = 0;

  #partition(pk: string): Map<string, Cell> {
    const existing = this.#rows.get(pk);
    if (existing) return existing;
    const created = new Map<string, Cell>();
    this.#rows.set(pk, created);
    return created;
  }

  nextETag(): ETag {
    this.#version += 1;
    return `W/"mem-${this.#version}"`;
  }

  get(pk: string, rk: string): Cell | undefined {
    return this.#rows.get(pk)?.get(rk);
  }

  set(pk: string, rk: string, json: string): ETag {
    const etag = this.nextETag();
    this.#partition(pk).set(rk, { json, etag });
    return etag;
  }

  /** Conditional write. `expected` of `undefined` means "create only if absent". */
  setIf(pk: string, rk: string, json: string, expected: ETag | undefined, entity: string): ETag {
    const current = this.get(pk, rk);
    if (expected === undefined) {
      if (current !== undefined) throw new ConcurrencyConflict(entity, 'already exists');
    } else if (current === undefined || current.etag !== expected) {
      throw new ConcurrencyConflict(entity, `expected ${expected}`);
    }
    return this.set(pk, rk, json);
  }

  delete(pk: string, rk: string): void {
    this.#rows.get(pk)?.delete(rk);
  }

  *partitionRows(pk: string): Generator<[string, Cell]> {
    const partition = this.#rows.get(pk);
    if (!partition) return;
    for (const rk of [...partition.keys()].sort()) {
      const cell = partition.get(rk);
      if (cell) yield [rk, cell];
    }
  }

  *prefixPartitions(prefix: string): Generator<[string, string, Cell]> {
    for (const pk of [...this.#rows.keys()].sort()) {
      if (!pk.startsWith(prefix)) continue;
      for (const [rk, cell] of this.partitionRows(pk)) yield [pk, rk, cell];
    }
  }

  clearPartition(pk: string): void {
    this.#rows.delete(pk);
  }
}

function decode<T extends { rv: number }>(cell: Cell, schema: z.ZodType<T>): T {
  return upconvert(JSON.parse(cell.json), schema);
}

/**
 * Page a sorted, already-materialised list using an opaque numeric cursor.
 *
 * The Azure adapter uses real continuation tokens; both honour the same `limit` bound so a
 * caller cannot ask for an unbounded result set.
 */
function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
  const limit = boundedLimit(page?.limit);
  const offset = page?.continuation === undefined ? 0 : Number.parseInt(page.continuation, 10);
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const slice = items.slice(start, start + limit);
  const next = start + limit;
  return next < items.length ? { items: slice, continuation: String(next) } : { items: slice };
}

const worldPartition = (worldId: string): string => `w:${worldId}`;
const regionPartition = (worldId: string, regionId: string): string => `w:${worldId}|r:${regionId}`;
const agentPartition = (worldId: string, agentId: string): string => `w:${worldId}|a:${agentId}`;
const lineagePartition = (worldId: string, lineageId: string): string =>
  `w:${worldId}|l:${lineageId}`;

/**
 * Events are partitioned by world *and epoch* so a single partition never grows without bound
 * and a "recent history" query touches one or two partitions.
 */
export const EVENT_EPOCH_TICKS = 1000;

export function eventEpochOf(tick: number): number {
  return Math.floor(tick / EVENT_EPOCH_TICKS);
}

const eventPartition = (worldId: string, tick: number): string =>
  `w:${worldId}|e:${String(eventEpochOf(tick)).padStart(6, '0')}`;

/** Row keys sort lexicographically, so ticks are zero-padded to keep chronological order. */
const eventRowKey = (event: StoredWorldEvent): string =>
  `${String(event.tick).padStart(12, '0')}|${event.id}`;

export class InMemoryWorldRepository implements WorldRepository {
  readonly #t = {
    worlds: new Table(),
    regions: new Table(),
    agents: new Table(),
    lineages: new Table(),
    lineageNodes: new Table(),
    organisms: new Table(),
    structures: new Table(),
    materials: new Table(),
    resources: new Table(),
    memories: new Table(),
    signals: new Table(),
    goals: new Table(),
    events: new Table(),
    decisions: new Table(),
    control: new Table(),
  };

  async initialise(): Promise<void> {
    return Promise.resolve();
  }

  async ping(): Promise<void> {
    return Promise.resolve();
  }

  readonly worlds: WorldStore = {
    get: async (worldId) => {
      const cell = this.#t.worlds.get('worlds', worldId);
      return Promise.resolve(
        cell === undefined
          ? undefined
          : ({
              value: decode(cell, WorldRecordSchema),
              etag: cell.etag,
            } satisfies Tagged<WorldRecord>),
      );
    },
    list: async () =>
      Promise.resolve(
        [...this.#t.worlds.partitionRows('worlds')].map(([, cell]) =>
          decode(cell, WorldRecordSchema),
        ),
      ),
    put: async (record, etag) => {
      const validated = WorldRecordSchema.parse(record);
      const exists = this.#t.worlds.get('worlds', validated.id) !== undefined;
      if (etag === undefined && exists) {
        // An unconditional put of an existing world is a lost-update hazard.
        throw new ConcurrencyConflict('world', 'etag required to overwrite');
      }
      return Promise.resolve(
        this.#t.worlds.setIf('worlds', validated.id, JSON.stringify(validated), etag, 'world'),
      );
    },
  };

  readonly regions: RegionStore = {
    get: async (worldId, regionId) => {
      const cell = this.#t.regions.get(worldPartition(worldId), regionId);
      return Promise.resolve(cell === undefined ? undefined : decode(cell, RegionRecordSchema));
    },
    listByWorld: async (worldId) =>
      Promise.resolve(
        [...this.#t.regions.partitionRows(worldPartition(worldId))].map(([, cell]) =>
          decode(cell, RegionRecordSchema),
        ),
      ),
    putMany: async (records) => {
      for (const record of records) {
        const validated = RegionRecordSchema.parse(record);
        this.#t.regions.set(
          worldPartition(validated.worldId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
  };

  readonly agents: AgentStore = {
    get: async (worldId, agentId) => {
      const cell = this.#t.agents.get(worldPartition(worldId), agentId);
      return Promise.resolve(
        cell === undefined
          ? undefined
          : { value: decode(cell, AgentRecordSchema), etag: cell.etag },
      );
    },
    listByWorld: async (worldId, page) => {
      const all = [...this.#t.agents.partitionRows(worldPartition(worldId))].map(([, cell]) =>
        decode(cell, AgentRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    put: async (record, etag) => {
      const validated = AgentRecordSchema.parse(record);
      const pk = worldPartition(validated.worldId);
      if (etag === undefined && this.#t.agents.get(pk, validated.id) !== undefined) {
        throw new ConcurrencyConflict('agent', 'etag required to overwrite');
      }
      return Promise.resolve(
        this.#t.agents.setIf(pk, validated.id, JSON.stringify(validated), etag, 'agent'),
      );
    },
    putMany: async (records) => {
      for (const record of records) {
        const validated = AgentRecordSchema.parse(record);
        this.#t.agents.set(
          worldPartition(validated.worldId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
  };

  readonly lineages: LineageStore = {
    get: async (worldId, lineageId) => {
      const cell = this.#t.lineages.get(worldPartition(worldId), lineageId);
      return Promise.resolve(cell === undefined ? undefined : decode(cell, LineageRecordSchema));
    },
    listByWorld: async (worldId, page) => {
      const all = [...this.#t.lineages.partitionRows(worldPartition(worldId))].map(([, cell]) =>
        decode(cell, LineageRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    putMany: async (records) => {
      for (const record of records) {
        const validated = LineageRecordSchema.parse(record);
        this.#t.lineages.set(
          worldPartition(validated.worldId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
    listNodes: async (worldId, lineageId, page) => {
      const all = [...this.#t.lineageNodes.partitionRows(lineagePartition(worldId, lineageId))].map(
        ([, cell]) => decode(cell, LineageNodeRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    putNodes: async (worldId, records) => {
      for (const record of records) {
        const validated = LineageNodeRecordSchema.parse(record);
        this.#t.lineageNodes.set(
          lineagePartition(worldId, validated.lineageId),
          // Sorting by birth tick keeps a lineage tree query in generation order.
          `${String(validated.bornAtTick).padStart(12, '0')}|${validated.organismId}`,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
  };

  readonly organisms: OrganismStore = {
    get: async (worldId, organismId) => {
      for (const [, rk, cell] of this.#t.organisms.prefixPartitions(`w:${worldId}|r:`)) {
        if (rk === organismId) return Promise.resolve(decode(cell, OrganismRecordSchema));
      }
      return Promise.resolve(undefined);
    },
    listByRegion: async (worldId, regionId, page) => {
      const all = [...this.#t.organisms.partitionRows(regionPartition(worldId, regionId))].map(
        ([, cell]) => decode(cell, OrganismRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    listByWorld: async (worldId, page) => {
      const all = [...this.#t.organisms.prefixPartitions(`w:${worldId}|r:`)].map(([, , cell]) =>
        decode(cell, OrganismRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    putMany: async (records) => {
      for (const record of records) {
        const validated = OrganismRecordSchema.parse(record);
        this.#t.organisms.set(
          regionPartition(validated.worldId, validated.regionId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
    deleteMany: async (worldId, keys) => {
      for (const key of keys) {
        this.#t.organisms.delete(regionPartition(worldId, key.regionId), key.organismId);
      }
      return Promise.resolve();
    },
  };

  readonly structures: StructureStore = {
    get: async (worldId, structureId) => {
      for (const [, rk, cell] of this.#t.structures.prefixPartitions(`w:${worldId}|r:`)) {
        if (rk === structureId) return Promise.resolve(decode(cell, StructureRecordSchema));
      }
      return Promise.resolve(undefined);
    },
    listByRegion: async (worldId, regionId, page) => {
      const all = [...this.#t.structures.partitionRows(regionPartition(worldId, regionId))].map(
        ([, cell]) => decode(cell, StructureRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    listByWorld: async (worldId, page) => {
      const all = [...this.#t.structures.prefixPartitions(`w:${worldId}|r:`)].map(([, , cell]) =>
        decode(cell, StructureRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    putMany: async (records) => {
      for (const record of records) {
        const validated = StructureRecordSchema.parse(record);
        this.#t.structures.set(
          regionPartition(validated.worldId, validated.regionId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
    deleteMany: async (worldId, keys) => {
      for (const key of keys) {
        this.#t.structures.delete(regionPartition(worldId, key.regionId), key.structureId);
      }
      return Promise.resolve();
    },
  };

  readonly materials: MaterialStore = {
    listByWorld: async (worldId) =>
      Promise.resolve(
        [...this.#t.materials.partitionRows(worldPartition(worldId))].map(([, cell]) =>
          decode(cell, MaterialRecordSchema),
        ),
      ),
    putMany: async (records) => {
      for (const record of records) {
        const validated = MaterialRecordSchema.parse(record);
        this.#t.materials.set(
          worldPartition(validated.worldId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
  };

  readonly resources: ResourceStore = {
    listByRegion: async (worldId, regionId, page) => {
      const all = [...this.#t.resources.partitionRows(regionPartition(worldId, regionId))].map(
        ([, cell]) => decode(cell, ResourceNodeRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    listByWorld: async (worldId, page) => {
      const all = [...this.#t.resources.prefixPartitions(`w:${worldId}|r:`)].map(([, , cell]) =>
        decode(cell, ResourceNodeRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    putMany: async (records) => {
      for (const record of records) {
        const validated = ResourceNodeRecordSchema.parse(record);
        this.#t.resources.set(
          regionPartition(validated.worldId, validated.regionId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
  };

  readonly memories: MemoryStore = {
    listByAgent: async (worldId, agentId, page) => {
      const all = [...this.#t.memories.partitionRows(agentPartition(worldId, agentId))].map(
        ([, cell]) => decode(cell, MemoryRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    putMany: async (records) => {
      for (const record of records) {
        const validated = MemoryRecordSchema.parse(record);
        this.#t.memories.set(
          agentPartition(validated.worldId, validated.agentId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
    deleteMany: async (worldId, keys) => {
      for (const key of keys) {
        this.#t.memories.delete(agentPartition(worldId, key.agentId), key.memoryId);
      }
      return Promise.resolve();
    },
  };

  readonly signals: SignalStore = {
    listByWorld: async (worldId) =>
      Promise.resolve(
        [...this.#t.signals.partitionRows(worldPartition(worldId))].map(([, cell]) =>
          decode(cell, SignalRecordSchema),
        ),
      ),
    replaceAll: async (worldId, records) => {
      // Signals live for a single tick; replacing wholesale keeps the table from growing.
      this.#t.signals.clearPartition(worldPartition(worldId));
      for (const record of records) {
        const validated = SignalRecordSchema.parse(record);
        this.#t.signals.set(
          worldPartition(worldId),
          `${validated.organismId}|${validated.channel}`,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
  };

  readonly goals: GoalStore = {
    get: async (worldId, agentId, goalId) => {
      const cell = this.#t.goals.get(agentPartition(worldId, agentId), goalId);
      return Promise.resolve(
        cell === undefined ? undefined : { value: decode(cell, GoalRecordSchema), etag: cell.etag },
      );
    },
    listByAgent: async (worldId, agentId, page) => {
      const all = [...this.#t.goals.partitionRows(agentPartition(worldId, agentId))].map(
        ([, cell]) => decode(cell, GoalRecordSchema),
      );
      return Promise.resolve(paginate(all, page));
    },
    listPending: async (worldId, limit) => {
      const out: GoalRecord[] = [];
      for (const [, , cell] of this.#t.goals.prefixPartitions(`w:${worldId}|a:`)) {
        const record = decode(cell, GoalRecordSchema);
        if (record.status === 'pending') out.push(record);
        if (out.length >= boundedLimit(limit)) break;
      }
      return Promise.resolve(out);
    },
    put: async (record, etag) => {
      const validated = GoalRecordSchema.parse(record);
      const pk = agentPartition(validated.worldId, validated.agentId);
      if (etag === undefined && this.#t.goals.get(pk, validated.id) !== undefined) {
        throw new ConcurrencyConflict('goal', 'etag required to overwrite');
      }
      return Promise.resolve(
        this.#t.goals.setIf(pk, validated.id, JSON.stringify(validated), etag, 'goal'),
      );
    },
    putMany: async (records) => {
      for (const record of records) {
        const validated = GoalRecordSchema.parse(record);
        this.#t.goals.set(
          agentPartition(validated.worldId, validated.agentId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
  };

  readonly events: EventStore = {
    append: async (events) => {
      let written = 0;
      let skipped = 0;
      for (const event of events) {
        const validated = WorldEventSchema.parse(event);
        const pk = eventPartition(validated.worldId, validated.tick);
        const rk = eventRowKey(validated);
        // Idempotent by construction: the row key contains the deterministic event id.
        if (this.#t.events.get(pk, rk) !== undefined) {
          skipped += 1;
          continue;
        }
        this.#t.events.set(pk, rk, JSON.stringify(validated));
        written += 1;
      }
      return Promise.resolve({ written, skipped });
    },
    query: async (query) => {
      const all: StoredWorldEvent[] = [];
      for (const [, , cell] of this.#t.events.prefixPartitions(`w:${query.worldId}|e:`)) {
        all.push(WorldEventSchema.parse(JSON.parse(cell.json)));
      }
      // The whole log is in hand here, so windowing is pure bookkeeping — but it runs through the
      // same walk as the Azure adapter so the two cannot drift apart on what "newest first" means.
      let latest = 0;
      for (const event of all) if (event.tick > latest) latest = event.tick;
      return pageEventsNewestFirst({
        limit: boundedLimit(query.limit),
        startTick: query.untilTick ?? latest,
        floorTick: query.sinceTick ?? 0,
        cursor: decodeEventCursor(query.continuation),
        accept: (event) => {
          if (query.regionId !== undefined && event.regionId !== query.regionId) return false;
          if (query.lineageId !== undefined && event.lineageId !== query.lineageId) return false;
          return true;
        },
        fetch: (low, high) =>
          Promise.resolve({
            rows: all.filter((event) => event.tick >= low && event.tick <= high),
            complete: true,
          }),
      });
    },
    compact: async (worldId, beforeTick, limit) => {
      let removed = 0;
      const bound = boundedLimit(limit);
      for (const [pk, rk, cell] of this.#t.events.prefixPartitions(`w:${worldId}|e:`)) {
        if (removed >= bound) break;
        const event = WorldEventSchema.parse(JSON.parse(cell.json));
        if (event.tick >= beforeTick) continue;
        this.#t.events.delete(pk, rk);
        removed += 1;
      }
      return Promise.resolve(removed);
    },
  };

  readonly decisions: DecisionStore = {
    put: async (record, etag) => {
      const validated = DecisionRecordSchema.parse(record);
      const pk = worldPartition(validated.worldId);
      if (etag === undefined && this.#t.decisions.get(pk, validated.id) !== undefined) {
        throw new ConcurrencyConflict('decision', 'etag required to overwrite');
      }
      return Promise.resolve(
        this.#t.decisions.setIf(pk, validated.id, JSON.stringify(validated), etag, 'decision'),
      );
    },
    putMany: async (records) => {
      for (const record of records) {
        const validated = DecisionRecordSchema.parse(record);
        this.#t.decisions.set(
          worldPartition(validated.worldId),
          validated.id,
          JSON.stringify(validated),
        );
      }
      return Promise.resolve();
    },
    get: async (worldId, decisionId) => {
      const cell = this.#t.decisions.get(worldPartition(worldId), decisionId);
      return Promise.resolve(
        cell === undefined
          ? undefined
          : { value: decode(cell, DecisionRecordSchema), etag: cell.etag },
      );
    },
    claimPending: async ({ worldId, holder, limit, nowEpochMs, claimTtlMs }) => {
      const claimed: DecisionClaim[] = [];
      const bound = boundedLimit(limit);
      for (const [, rk, cell] of this.#t.decisions.prefixPartitions(worldPartition(worldId))) {
        if (claimed.length >= bound) break;
        const record = decode(cell, DecisionRecordSchema);
        const claimable =
          record.status === 'pending' ||
          (record.status === 'claimed' && (record.claimExpiresAtEpochMs ?? 0) <= nowEpochMs);
        if (!claimable) continue;
        const updated: DecisionRecord = {
          ...record,
          status: 'claimed',
          claimedBy: holder,
          claimExpiresAtEpochMs: nowEpochMs + claimTtlMs,
          attempts: record.attempts + 1,
        };
        try {
          const etag = this.#t.decisions.setIf(
            worldPartition(worldId),
            rk,
            JSON.stringify(DecisionRecordSchema.parse(updated)),
            cell.etag,
            'decision',
          );
          claimed.push({ record: updated, etag });
        } catch (error) {
          // Losing the compare-and-set race simply means another worker got this one.
          if (!(error instanceof ConcurrencyConflict)) throw error;
        }
      }
      return Promise.resolve(claimed);
    },
    listProposed: async (worldId, limit) => {
      const out: DecisionRecord[] = [];
      const bound = boundedLimit(limit);
      for (const [, , cell] of this.#t.decisions.prefixPartitions(worldPartition(worldId))) {
        if (out.length >= bound) break;
        const record = decode(cell, DecisionRecordSchema);
        if (record.status === 'proposed') out.push(record);
      }
      return Promise.resolve(out);
    },
    countByStatus: async (worldId) => {
      const counts: Record<string, number> = {};
      for (const [, , cell] of this.#t.decisions.prefixPartitions(worldPartition(worldId))) {
        const record = decode(cell, DecisionRecordSchema);
        counts[record.status] = (counts[record.status] ?? 0) + 1;
      }
      return Promise.resolve(counts);
    },
    expireStaleClaims: async (worldId, nowEpochMs, limit) => {
      let released = 0;
      const bound = boundedLimit(limit);
      for (const [, rk, cell] of this.#t.decisions.prefixPartitions(worldPartition(worldId))) {
        if (released >= bound) break;
        const record = decode(cell, DecisionRecordSchema);
        if (record.status !== 'claimed') continue;
        if ((record.claimExpiresAtEpochMs ?? 0) > nowEpochMs) continue;
        const { claimedBy: _claimedBy, claimExpiresAtEpochMs: _expiry, ...rest } = record;
        this.#t.decisions.set(
          worldPartition(worldId),
          rk,
          JSON.stringify(DecisionRecordSchema.parse({ ...rest, status: 'pending' })),
        );
        released += 1;
      }
      return Promise.resolve(released);
    },
    deleteMany: async (worldId, decisionIds) => {
      for (const id of decisionIds) this.#t.decisions.delete(worldPartition(worldId), id);
      return Promise.resolve();
    },
  };

  readonly control: ControlStore = {
    getWatermark: async (worldId, name) => {
      const cell = this.#t.control.get(`${worldPartition(worldId)}|wm`, name);
      return Promise.resolve(
        cell === undefined
          ? undefined
          : { value: decode(cell, WatermarkRecordSchema), etag: cell.etag },
      );
    },
    putWatermark: async (record, etag) => {
      const validated = WatermarkRecordSchema.parse(record);
      const pk = `${worldPartition(validated.worldId)}|wm`;
      if (etag === undefined && this.#t.control.get(pk, validated.name) !== undefined) {
        throw new ConcurrencyConflict('watermark', 'etag required to overwrite');
      }
      return Promise.resolve(
        this.#t.control.setIf(pk, validated.name, JSON.stringify(validated), etag, 'watermark'),
      );
    },
    acquireLease: async ({ worldId, name, holder, nowEpochMs, ttlMs }) => {
      const pk = `${worldPartition(worldId)}|lease`;
      const cell = this.#t.control.get(pk, name);
      const lease: LeaseRecord = {
        rv: 1,
        worldId,
        name,
        holder,
        expiresAtEpochMs: nowEpochMs + ttlMs,
      };
      if (cell !== undefined) {
        const current = decode(cell, LeaseRecordSchema);
        // A live lease held by someone else blocks acquisition; our own is renewed.
        if (current.expiresAtEpochMs > nowEpochMs && current.holder !== holder) {
          return Promise.resolve(undefined);
        }
        try {
          this.#t.control.setIf(pk, name, JSON.stringify(lease), cell.etag, 'lease');
          return Promise.resolve(lease);
        } catch {
          return Promise.resolve(undefined);
        }
      }
      try {
        this.#t.control.setIf(pk, name, JSON.stringify(lease), undefined, 'lease');
        return Promise.resolve(lease);
      } catch {
        return Promise.resolve(undefined);
      }
    },
    releaseLease: async (worldId, name, holder) => {
      const pk = `${worldPartition(worldId)}|lease`;
      const cell = this.#t.control.get(pk, name);
      if (cell === undefined) return Promise.resolve();
      const current = decode(cell, LeaseRecordSchema);
      if (current.holder !== holder) return Promise.resolve();
      this.#t.control.delete(pk, name);
      return Promise.resolve();
    },
    getQuota: async (worldId, creatorId, dayKey) => {
      const cell = this.#t.control.get(
        `${worldPartition(worldId)}|quota`,
        `${creatorId}|${dayKey}`,
      );
      return Promise.resolve(
        cell === undefined
          ? undefined
          : { value: decode(cell, CreatorQuotaRecordSchema), etag: cell.etag },
      );
    },
    putQuota: async (record, etag) => {
      const validated = CreatorQuotaRecordSchema.parse(record);
      const pk = `${worldPartition(validated.worldId)}|quota`;
      const rk = `${validated.creatorId}|${validated.dayKey}`;
      if (etag === undefined && this.#t.control.get(pk, rk) !== undefined) {
        throw new ConcurrencyConflict('quota', 'etag required to overwrite');
      }
      return Promise.resolve(
        this.#t.control.setIf(pk, rk, JSON.stringify(validated), etag, 'quota'),
      );
    },
    getIdempotency: async (worldId, key) => {
      const cell = this.#t.control.get(`${worldPartition(worldId)}|idem`, key);
      return Promise.resolve(
        cell === undefined ? undefined : decode(cell, IdempotencyRecordSchema),
      );
    },
    putIdempotency: async (record) => {
      const validated = IdempotencyRecordSchema.parse(record);
      this.#t.control.set(
        `${worldPartition(validated.worldId)}|idem`,
        validated.key,
        JSON.stringify(validated),
      );
      return Promise.resolve();
    },
  };
}
