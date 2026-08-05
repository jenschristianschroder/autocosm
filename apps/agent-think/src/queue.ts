import {
  ObservationSchema,
  RECORD_VERSION,
  type ActionProposal,
  type AgentId,
  type DecisionId,
  type DecisionReason,
  type LineageId,
  type OrganismId,
  type PendingDecision,
  type RegionId,
  type WorldId,
} from '@autocosm/domain';
import type { DecisionQueue } from '@autocosm/agent-runtime';
import { ConcurrencyConflict, type WorldRepository } from '@autocosm/storage';

/**
 * `DecisionQueue` implemented over the storage repository.
 *
 * The claim/release protocol lives in storage (ETag compare-and-set) rather than here, so this
 * class is mostly translation. The one piece of judgement it carries is what to do when a write
 * loses a race: nothing. A lost race means another worker already owns the decision, and the
 * decision either gets proposed by them or expires — both safe.
 */
export class RepositoryDecisionQueue implements DecisionQueue {
  readonly #repository: WorldRepository;
  readonly #worldId: string;
  readonly #now: () => number;
  /** ETags from the claim, so release/store can compare-and-set without re-reading. */
  readonly #etags = new Map<string, string>();

  constructor(repository: WorldRepository, worldId: string, now: () => number = Date.now) {
    this.#repository = repository;
    this.#worldId = worldId;
    this.#now = now;
  }

  async claim(limit: number, holder: string, leaseMs: number): Promise<readonly PendingDecision[]> {
    const claims = await this.#repository.decisions.claimPending({
      worldId: this.#worldId,
      holder,
      limit,
      nowEpochMs: this.#now(),
      claimTtlMs: leaseMs,
    });

    const decisions: PendingDecision[] = [];
    for (const claim of claims) {
      const decision = toPending(claim.record);
      // A decision whose observation no longer parses is corrupt, not retryable.
      if (!decision) {
        await this.#repository.decisions.put(
          { ...claim.record, status: 'failed', claimedBy: undefined },
          claim.etag,
        );
        continue;
      }
      this.#etags.set(claim.record.id, claim.etag);
      decisions.push(decision);
    }
    return decisions;
  }

  async storeProposal(decision: PendingDecision, proposal: ActionProposal): Promise<void> {
    await this.#update(decision, (record) => ({
      ...record,
      status: 'proposed',
      proposalJson: JSON.stringify(proposal).slice(0, 4_000),
      claimedBy: undefined,
      claimExpiresAtEpochMs: undefined,
    }));
  }

  async release(decision: PendingDecision): Promise<void> {
    // `claimPending` already counted this attempt; counting again would burn retries twice.
    await this.#update(decision, (record) => ({
      ...record,
      status: 'pending',
      claimedBy: undefined,
      claimExpiresAtEpochMs: undefined,
    }));
  }

  async fail(decision: PendingDecision): Promise<void> {
    await this.#update(decision, (record) => ({
      ...record,
      status: 'failed',
      claimedBy: undefined,
      claimExpiresAtEpochMs: undefined,
    }));
  }

  async #update(
    decision: PendingDecision,
    change: (
      record: Awaited<ReturnType<WorldRepository['decisions']['get']>> extends
        { value: infer V } | undefined
        ? V
        : never,
    ) => Parameters<WorldRepository['decisions']['put']>[0],
  ): Promise<void> {
    const stored = await this.#repository.decisions.get(this.#worldId, decision.id);
    if (!stored) return;
    const etag = this.#etags.get(decision.id) ?? stored.etag;
    try {
      await this.#repository.decisions.put(change(stored.value), etag);
      this.#etags.delete(decision.id);
    } catch (cause) {
      if (cause instanceof ConcurrencyConflict) return;
      throw cause;
    }
  }
}

/** Reserved creator id under which the world's daily AI spend is recorded. */
export const THINKER_QUOTA_ID = 'system-thinker';

export function dayKeyFor(nowEpochMs: number): string {
  return new Date(nowEpochMs).toISOString().slice(0, 10);
}

/** Decisions already charged today, so a restarted job does not get a fresh daily allowance. */
export async function readDailySpend(
  repository: WorldRepository,
  worldId: string,
  dayKey: string,
): Promise<number> {
  const stored = await repository.control.getQuota(worldId, THINKER_QUOTA_ID, dayKey);
  return stored?.value.decisionsRequested ?? 0;
}

/**
 * Record this run's spend against the day.
 *
 * A lost compare-and-set is retried a few times and then abandoned: over-counting would refuse
 * legitimate work, and the run-level budget already bounds a single execution.
 */
export async function recordDailySpend(
  repository: WorldRepository,
  worldId: string,
  dayKey: string,
  used: number,
): Promise<void> {
  if (used <= 0) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stored = await repository.control.getQuota(worldId, THINKER_QUOTA_ID, dayKey);
    const next = {
      rv: RECORD_VERSION,
      worldId,
      creatorId: THINKER_QUOTA_ID,
      dayKey,
      agentsCreated: stored?.value.agentsCreated ?? 0,
      goalsSubmitted: stored?.value.goalsSubmitted ?? 0,
      decisionsRequested: Math.min(1_000_000, (stored?.value.decisionsRequested ?? 0) + used),
    };
    try {
      await repository.control.putQuota(next, stored?.etag);
      return;
    } catch (cause) {
      if (!(cause instanceof ConcurrencyConflict)) throw cause;
    }
  }
}

function toPending(record: {
  id: string;
  worldId: string;
  agentId: string;
  lineageId: string;
  organismId: string;
  regionId: string;
  createdAtTick: number;
  expiresAtTick: number;
  reason: string;
  observationJson: string;
  attempts: number;
  claimedBy?: string | undefined;
  claimExpiresAtEpochMs?: number | undefined;
}): PendingDecision | undefined {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(record.observationJson);
  } catch {
    return undefined;
  }
  const observation = ObservationSchema.safeParse(parsedJson);
  if (!observation.success) return undefined;

  return {
    id: record.id as DecisionId,
    worldId: record.worldId as WorldId,
    agentId: record.agentId as AgentId,
    lineageId: record.lineageId as LineageId,
    organismId: record.organismId as OrganismId,
    regionId: record.regionId as RegionId,
    createdAtTick: record.createdAtTick,
    expiresAtTick: record.expiresAtTick,
    reason: record.reason as DecisionReason,
    status: 'claimed',
    observation: observation.data,
    attempts: record.attempts,
    ...(record.claimedBy === undefined ? {} : { claimedBy: record.claimedBy }),
    ...(record.claimExpiresAtEpochMs === undefined
      ? {}
      : { claimExpiresAtEpochMs: record.claimExpiresAtEpochMs }),
  };
}
