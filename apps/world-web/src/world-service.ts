import {
  CreateAgentRequestSchema,
  RECORD_VERSION,
  SubmitGoalRequestSchema,
  normaliseGenotype,
  regionIdOf,
  type AgentRecord,
  type CreateAgentResponse,
  type GoalRecord,
  type LineageRecord,
  type SubmitGoalResponse,
  type WorldRecordBundle,
} from '@autocosm/domain';
import {
  drivesFor,
  foundingGenotypeFor,
  fromRecords,
  habitatAnchor,
  type WorldState,
} from '@autocosm/simulation';
import { ConcurrencyConflict, loadWorldBundle, type WorldRepository } from '@autocosm/storage';

/**
 * The world service.
 *
 * Read paths compose a `WorldState` from storage and hand it to the read model. Write paths are
 * limited, on purpose, to the only two mutations an observer is permitted: authoring a new agent
 * and submitting a broad goal. Neither writes authoritative simulation state — they record intent
 * that the tick job, the sole authority, later materialises.
 */

export class QuotaExceeded extends Error {
  readonly limit: number;

  constructor(what: string, limit: number) {
    super(`daily ${what} limit of ${limit} reached for this creator`);
    this.name = 'QuotaExceeded';
    this.limit = limit;
  }
}

export class AgentNotFound extends Error {
  constructor(agentId: string) {
    super(`agent ${agentId} does not exist`);
    this.name = 'AgentNotFound';
  }
}

export class WorldNotSeeded extends Error {
  constructor(worldId: string) {
    super(`world ${worldId} has not been seeded`);
    this.name = 'WorldNotSeeded';
  }
}

export interface WorldServiceOptions {
  readonly repository: WorldRepository;
  readonly worldId: string;
  readonly maxAgentsPerCreatorPerDay: number;
  readonly maxGoalsPerCreatorPerDay: number;
  /** Milliseconds a loaded world may be reused before storage is consulted again. */
  readonly cacheTtlMs: number;
  readonly now?: () => number;
}

export interface LoadedWorld {
  readonly state: WorldState;
  /** Strong-enough validator for conditional GETs; changes whenever the world advances. */
  readonly etag: string;
  readonly loadedAtEpochMs: number;
}

export class WorldService {
  readonly #repo: WorldRepository;
  readonly #worldId: string;
  readonly #maxAgents: number;
  readonly #maxGoals: number;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  #cache: LoadedWorld | undefined;
  #inflight: Promise<LoadedWorld> | undefined;

  constructor(options: WorldServiceOptions) {
    this.#repo = options.repository;
    this.#worldId = options.worldId;
    this.#maxAgents = options.maxAgentsPerCreatorPerDay;
    this.#maxGoals = options.maxGoalsPerCreatorPerDay;
    this.#cacheTtlMs = options.cacheTtlMs;
    this.#now = options.now ?? Date.now;
  }

  get worldId(): string {
    return this.#worldId;
  }

  get repository(): WorldRepository {
    return this.#repo;
  }

  /** Drop the cached world so the next read reflects a write made through this process. */
  invalidate(): void {
    this.#cache = undefined;
  }

  async load(): Promise<LoadedWorld> {
    const cached = this.#cache;
    if (cached && this.#now() - cached.loadedAtEpochMs < this.#cacheTtlMs) return cached;
    // Collapse concurrent misses so a burst of polling browsers causes a single storage read.
    this.#inflight ??= this.#loadFresh().finally(() => {
      this.#inflight = undefined;
    });
    return await this.#inflight;
  }

  /** Whether the world exists yet, without throwing. Used by readiness. */
  async isSeeded(): Promise<boolean> {
    if (this.#cache) return true;
    return (await this.#repo.worlds.get(this.#worldId)) !== undefined;
  }

  async #loadFresh(): Promise<LoadedWorld> {
    const bundle: WorldRecordBundle | undefined = await loadWorldBundle(this.#repo, this.#worldId);
    if (!bundle) throw new WorldNotSeeded(this.#worldId);
    const state = fromRecords(bundle);
    const loaded: LoadedWorld = {
      state,
      etag: `"${state.world.id}.${state.world.tick}.${state.organisms.size}.${state.structures.size}"`,
      loadedAtEpochMs: this.#now(),
    };
    this.#cache = loaded;
    return loaded;
  }

  async createAgent(
    creatorId: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<CreateAgentResponse> {
    const request = CreateAgentRequestSchema.parse(body);
    const replayed = await this.#replay<CreateAgentResponse>(idempotencyKey);
    if (replayed) return replayed;

    const { state } = await this.load();
    await this.#consumeQuota(creatorId, 'agent');

    const agentId = this.#mintId('ag', creatorId, request.name);
    const lineageId = `ln${agentId.slice(2)}`;
    const genotype = normaliseGenotype(foundingGenotypeFor(request, state.world.seed));

    const agent: AgentRecord = {
      rv: RECORD_VERSION,
      id: agentId,
      worldId: this.#worldId,
      lineageId,
      name: request.name,
      createdByCreatorId: creatorId,
      createdAtTick: state.world.tick,
      status: 'active',
      drives: { ...drivesFor(request) },
      temperament: request.temperament,
      habitat: request.habitat,
      aspiration: request.aspiration,
      knowledge: { knownMaterialIds: [], recipes: [], knownStructureIds: [] },
      lastDecisionTick: 0,
      decisionCount: 0,
      visualSeed: request.visualSeed,
    };

    // The lineage starts bodiless. `foundPendingLineages` in the tick engine — the only
    // authoritative writer — creates the founding cell on the next advance.
    const lineage: LineageRecord = {
      rv: RECORD_VERSION,
      id: lineageId,
      worldId: this.#worldId,
      agentId,
      name: request.name,
      foundedAtTick: state.world.tick,
      originRegionId: regionIdOf(
        habitatAnchor(state.terrain, request.habitat, state.world.seed, request.visualSeed),
      ),
      generations: 0,
      births: 0,
      deaths: 0,
      livingCount: 0,
      meanGenotype: { ...genotype },
      // Explicit rather than relying on the load-time fallback: a spectator's lineage starts
      // measuring drift from the genome it was authored with.
      foundingGenotype: { ...genotype },
    };

    await this.#repo.agents.put(agent);
    await this.#repo.lineages.putMany([lineage]);
    this.invalidate();

    const response: CreateAgentResponse = {
      agentId,
      lineageId,
      name: request.name,
      acceptedAtTick: state.world.tick,
      message:
        'Your agent enters the world as a basic cell on the next tick. Survival is not guaranteed.',
    };
    await this.#remember(idempotencyKey, response);
    return response;
  }

  async submitGoal(
    creatorId: string,
    agentId: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<SubmitGoalResponse> {
    const request = SubmitGoalRequestSchema.parse(body);
    const replayed = await this.#replay<SubmitGoalResponse>(idempotencyKey);
    if (replayed) return replayed;

    const stored = await this.#repo.agents.get(this.#worldId, agentId);
    if (!stored) throw new AgentNotFound(agentId);

    const { state } = await this.load();
    const remaining = await this.#consumeQuota(creatorId, 'goal');

    const goalId = this.#mintId('go', creatorId, agentId);
    const goal: GoalRecord = {
      rv: RECORD_VERSION,
      id: goalId,
      worldId: this.#worldId,
      agentId,
      text: request.text,
      submittedByCreatorId: creatorId,
      submittedAtTick: state.world.tick,
      status: 'pending',
    };
    await this.#repo.goals.put(goal);
    this.invalidate();

    const response: SubmitGoalResponse = {
      goalId,
      agentId,
      status: 'pending',
      message: 'Goal recorded. The agent may adopt, defer or reject it.',
      remainingToday: remaining,
    };
    await this.#remember(idempotencyKey, response);
    return response;
  }

  /** Remaining allowances for the current UTC day, for the creator-identity endpoint. */
  async remainingToday(creatorId: string): Promise<{ agents: number; goals: number }> {
    const quota = await this.#repo.control.getQuota(this.#worldId, creatorId, this.#dayKey());
    return {
      agents: Math.max(0, this.#maxAgents - (quota?.value.agentsCreated ?? 0)),
      goals: Math.max(0, this.#maxGoals - (quota?.value.goalsSubmitted ?? 0)),
    };
  }

  /**
   * Increment a creator's daily counter under optimistic concurrency.
   *
   * The check and the increment are a single compare-and-set, so two simultaneous requests cannot
   * both observe the last remaining allowance. Losing the race retries against fresh state.
   */
  async #consumeQuota(creatorId: string, what: 'agent' | 'goal'): Promise<number> {
    const limit = what === 'agent' ? this.#maxAgents : this.#maxGoals;
    const dayKey = this.#dayKey();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.#repo.control.getQuota(this.#worldId, creatorId, dayKey);
      const agentsCreated = existing?.value.agentsCreated ?? 0;
      const goalsSubmitted = existing?.value.goalsSubmitted ?? 0;
      const used = what === 'agent' ? agentsCreated : goalsSubmitted;
      if (used >= limit) throw new QuotaExceeded(what, limit);

      try {
        await this.#repo.control.putQuota(
          {
            rv: RECORD_VERSION,
            worldId: this.#worldId,
            creatorId,
            dayKey,
            agentsCreated: what === 'agent' ? agentsCreated + 1 : agentsCreated,
            goalsSubmitted: what === 'goal' ? goalsSubmitted + 1 : goalsSubmitted,
            decisionsRequested: existing?.value.decisionsRequested ?? 0,
          },
          existing?.etag,
        );
        return Math.max(0, limit - used - 1);
      } catch (cause) {
        if (!(cause instanceof ConcurrencyConflict)) throw cause;
      }
    }
    throw new QuotaExceeded(what, limit);
  }

  async #replay<T>(key: string | undefined): Promise<T | undefined> {
    if (key === undefined) return undefined;
    const stored = await this.#repo.control.getIdempotency(this.#worldId, key);
    if (!stored) return undefined;
    return JSON.parse(stored.responseJson) as T;
  }

  async #remember(key: string | undefined, response: unknown): Promise<void> {
    if (key === undefined) return;
    await this.#repo.control.putIdempotency({
      rv: RECORD_VERSION,
      worldId: this.#worldId,
      key,
      responseJson: JSON.stringify(response),
      createdAtEpochMs: this.#now(),
    });
  }

  #dayKey(): string {
    return new Date(this.#now()).toISOString().slice(0, 10);
  }

  /**
   * Mint a bounded, collision-resistant identifier.
   *
   * Not seeded from the simulation PRNG on purpose: authored ids are inputs to the world, not
   * outputs of it, so they must not perturb deterministic replay.
   */
  #mintId(prefix: string, ...parts: readonly (string | number)[]): string {
    let hash = 0x811c9dc5;
    for (const part of [...parts, this.#now(), globalThis.crypto.randomUUID()]) {
      const text = String(part);
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
    }
    return `${prefix}-${this.#now().toString(36)}-${(hash >>> 0).toString(36)}`.slice(0, 60);
  }
}
