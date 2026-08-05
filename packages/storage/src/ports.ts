import type {
  AgentRecord,
  CreatorQuotaRecord,
  DecisionRecord,
  GoalRecord,
  IdempotencyRecord,
  LeaseRecord,
  LineageNodeRecord,
  LineageRecord,
  MaterialRecord,
  MemoryRecord,
  OrganismRecord,
  RegionRecord,
  ResourceNodeRecord,
  SignalRecord,
  StoredWorldEvent,
  StructureRecord,
  WatermarkRecord,
  WorldRecord,
} from '@autocosm/domain';

/**
 * Storage ports.
 *
 * The simulation and the API depend on these interfaces, never on Azure. Two adapters implement
 * them: an in-memory one used by tests and the local demo, and an Azure Table Storage one used
 * in production. Everything is expressed in terms of bounded queries — there is deliberately no
 * "load the whole world" method that would blow past Table entity limits.
 */

/** An opaque optimistic-concurrency token. Azure returns an ETag; the memory adapter mints one. */
export type ETag = string;

/** A record as it was read, together with the tag needed to write it back safely. */
export interface Tagged<T> {
  readonly value: T;
  readonly etag: ETag;
}

/** Raised when a conditional write loses a race. Callers re-read and retry. */
export class ConcurrencyConflict extends Error {
  readonly entity: string;

  constructor(entity: string, detail?: string) {
    super(`Concurrent modification of ${entity}${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'ConcurrencyConflict';
    this.entity = entity;
  }
}

/** Raised when a record that must exist does not. */
export class RecordNotFound extends Error {
  readonly entity: string;

  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = 'RecordNotFound';
    this.entity = entity;
  }
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page, absent when the listing is exhausted. */
  readonly continuation?: string;
}

export interface PageRequest {
  readonly limit?: number;
  readonly continuation?: string;
}

/** Worlds are few and small. Read-modify-write is guarded by an ETag. */
export interface WorldStore {
  get(worldId: string): Promise<Tagged<WorldRecord> | undefined>;
  list(): Promise<readonly WorldRecord[]>;
  put(record: WorldRecord, etag?: ETag): Promise<ETag>;
}

export interface RegionStore {
  get(worldId: string, regionId: string): Promise<RegionRecord | undefined>;
  listByWorld(worldId: string): Promise<readonly RegionRecord[]>;
  putMany(records: readonly RegionRecord[]): Promise<void>;
}

export interface AgentStore {
  get(worldId: string, agentId: string): Promise<Tagged<AgentRecord> | undefined>;
  listByWorld(worldId: string, page?: PageRequest): Promise<Page<AgentRecord>>;
  put(record: AgentRecord, etag?: ETag): Promise<ETag>;
  putMany(records: readonly AgentRecord[]): Promise<void>;
}

export interface LineageStore {
  get(worldId: string, lineageId: string): Promise<LineageRecord | undefined>;
  listByWorld(worldId: string, page?: PageRequest): Promise<Page<LineageRecord>>;
  putMany(records: readonly LineageRecord[]): Promise<void>;
  /** Genealogy nodes, partitioned by lineage so a lineage tree is one bounded query. */
  listNodes(
    worldId: string,
    lineageId: string,
    page?: PageRequest,
  ): Promise<Page<LineageNodeRecord>>;
  putNodes(worldId: string, records: readonly LineageNodeRecord[]): Promise<void>;
}

export interface OrganismStore {
  get(worldId: string, organismId: string): Promise<OrganismRecord | undefined>;
  /** Bounded by region so a snapshot never scans the world. */
  listByRegion(
    worldId: string,
    regionId: string,
    page?: PageRequest,
  ): Promise<Page<OrganismRecord>>;
  listByWorld(worldId: string, page?: PageRequest): Promise<Page<OrganismRecord>>;
  putMany(records: readonly OrganismRecord[]): Promise<void>;
  deleteMany(
    worldId: string,
    keys: readonly { regionId: string; organismId: string }[],
  ): Promise<void>;
}

export interface StructureStore {
  get(worldId: string, structureId: string): Promise<StructureRecord | undefined>;
  listByRegion(
    worldId: string,
    regionId: string,
    page?: PageRequest,
  ): Promise<Page<StructureRecord>>;
  listByWorld(worldId: string, page?: PageRequest): Promise<Page<StructureRecord>>;
  putMany(records: readonly StructureRecord[]): Promise<void>;
  deleteMany(
    worldId: string,
    keys: readonly { regionId: string; structureId: string }[],
  ): Promise<void>;
}

export interface MaterialStore {
  listByWorld(worldId: string): Promise<readonly MaterialRecord[]>;
  putMany(records: readonly MaterialRecord[]): Promise<void>;
}

export interface ResourceStore {
  listByRegion(
    worldId: string,
    regionId: string,
    page?: PageRequest,
  ): Promise<Page<ResourceNodeRecord>>;
  listByWorld(worldId: string, page?: PageRequest): Promise<Page<ResourceNodeRecord>>;
  putMany(records: readonly ResourceNodeRecord[]): Promise<void>;
}

export interface MemoryStore {
  listByAgent(worldId: string, agentId: string, page?: PageRequest): Promise<Page<MemoryRecord>>;
  putMany(records: readonly MemoryRecord[]): Promise<void>;
  deleteMany(
    worldId: string,
    keys: readonly { agentId: string; memoryId: string }[],
  ): Promise<void>;
}

export interface SignalStore {
  listByWorld(worldId: string): Promise<readonly SignalRecord[]>;
  replaceAll(worldId: string, records: readonly SignalRecord[]): Promise<void>;
}

export interface GoalStore {
  get(worldId: string, agentId: string, goalId: string): Promise<Tagged<GoalRecord> | undefined>;
  listByAgent(worldId: string, agentId: string, page?: PageRequest): Promise<Page<GoalRecord>>;
  listPending(worldId: string, limit: number): Promise<readonly GoalRecord[]>;
  put(record: GoalRecord, etag?: ETag): Promise<ETag>;
  putMany(records: readonly GoalRecord[]): Promise<void>;
}

export interface EventQuery extends PageRequest {
  readonly worldId: string;
  readonly regionId?: string;
  readonly sinceTick?: number;
  readonly untilTick?: number;
  readonly lineageId?: string;
}

export interface EventStore {
  /**
   * Append events idempotently. An event already present with the same id is left untouched,
   * so a retried tick execution cannot duplicate history.
   */
  append(
    events: readonly StoredWorldEvent[],
  ): Promise<{ readonly written: number; readonly skipped: number }>;
  query(query: EventQuery): Promise<Page<StoredWorldEvent>>;
  /** Delete events older than a tick. Called by the tick job to bound retention. */
  compact(worldId: string, beforeTick: number, limit: number): Promise<number>;
}

export interface DecisionClaim {
  readonly record: DecisionRecord;
  readonly etag: ETag;
}

export interface DecisionStore {
  put(record: DecisionRecord, etag?: ETag): Promise<ETag>;
  putMany(records: readonly DecisionRecord[]): Promise<void>;
  get(worldId: string, decisionId: string): Promise<Tagged<DecisionRecord> | undefined>;
  /**
   * Atomically claim up to `limit` pending decisions using ETag compare-and-set. Losing a race
   * is not an error: the loser simply gets fewer items.
   */
  claimPending(args: {
    worldId: string;
    holder: string;
    limit: number;
    nowEpochMs: number;
    claimTtlMs: number;
  }): Promise<readonly DecisionClaim[]>;
  listProposed(worldId: string, limit: number): Promise<readonly DecisionRecord[]>;
  countByStatus(worldId: string): Promise<Readonly<Record<string, number>>>;
  /** Release claims whose expiry has passed so work is never permanently stranded. */
  expireStaleClaims(worldId: string, nowEpochMs: number, limit: number): Promise<number>;
  deleteMany(worldId: string, decisionIds: readonly string[]): Promise<void>;
}

export interface ControlStore {
  getWatermark(worldId: string, name: string): Promise<Tagged<WatermarkRecord> | undefined>;
  putWatermark(record: WatermarkRecord, etag?: ETag): Promise<ETag>;
  /** Acquire a lease, or return undefined when another holder owns an unexpired one. */
  acquireLease(args: {
    worldId: string;
    name: string;
    holder: string;
    nowEpochMs: number;
    ttlMs: number;
  }): Promise<LeaseRecord | undefined>;
  releaseLease(worldId: string, name: string, holder: string): Promise<void>;
  getQuota(
    worldId: string,
    creatorId: string,
    dayKey: string,
  ): Promise<Tagged<CreatorQuotaRecord> | undefined>;
  putQuota(record: CreatorQuotaRecord, etag?: ETag): Promise<ETag>;
  getIdempotency(worldId: string, key: string): Promise<IdempotencyRecord | undefined>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;
}

/** The full storage surface. Apps receive this, never a concrete adapter. */
export interface WorldRepository {
  readonly worlds: WorldStore;
  readonly regions: RegionStore;
  readonly agents: AgentStore;
  readonly lineages: LineageStore;
  readonly organisms: OrganismStore;
  readonly structures: StructureStore;
  readonly materials: MaterialStore;
  readonly resources: ResourceStore;
  readonly memories: MemoryStore;
  readonly signals: SignalStore;
  readonly goals: GoalStore;
  readonly events: EventStore;
  readonly decisions: DecisionStore;
  readonly control: ControlStore;
  /** Create any backing containers. Safe to call repeatedly. */
  initialise(): Promise<void>;
  /** Cheap liveness probe used by readiness endpoints. */
  ping(): Promise<void>;
}

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

export function boundedLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(requested)));
}
