import type { ActionProposal, PendingDecision } from '@autocosm/domain';
import type { Logger, Metrics } from '@autocosm/observability';
import { BudgetLedger, type DecisionBudget } from './budget.js';
import {
  DecisionProviderError,
  ProposalRejected,
  requestFromDecision,
  type DecisionProvider,
} from './ports.js';

/**
 * The batch loop the `think` job runs.
 *
 * It lives here, rather than in the job, so the claim/propose/store/release protocol can be tested
 * without Azure. The job supplies a `DecisionQueue` implemented over the storage repository.
 */

export interface DecisionQueue {
  /** Claim up to `limit` pending decisions, atomically, for `holder`. */
  claim(limit: number, holder: string, leaseMs: number): Promise<readonly PendingDecision[]>;
  /** Persist a successful proposal. Must be idempotent. */
  storeProposal(decision: PendingDecision, proposal: ActionProposal): Promise<void>;
  /** Return a decision to the pool after a retryable failure. */
  release(decision: PendingDecision, reason: string): Promise<void>;
  /** Give up on a decision; the tick engine falls back to its deterministic policy. */
  fail(decision: PendingDecision, reason: string): Promise<void>;
}

export type ProviderHealth = 'healthy' | 'degraded';

export interface ThinkBatchOptions {
  readonly queue: DecisionQueue;
  readonly provider: DecisionProvider;
  readonly budget: DecisionBudget;
  readonly holder: string;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /**
   * When true (production with a configured model), a provider failure surfaces as a degraded
   * result instead of quietly substituting a different policy.
   */
  readonly failClosed: boolean;
  readonly ledger?: BudgetLedger;
}

export interface ThinkBatchResult {
  readonly claimed: number;
  readonly proposed: number;
  readonly failed: number;
  readonly released: number;
  readonly skipped: number;
  readonly health: ProviderHealth;
  readonly degradedReason?: string;
}

/** Batch size per claim round; small enough that a crash strands little work. */
const CLAIM_CHUNK = 4;
/** Lease headroom over the per-decision timeout so a slow model does not lose its claim. */
const LEASE_MULTIPLIER = 3;

export async function runThinkBatch(options: ThinkBatchOptions): Promise<ThinkBatchResult> {
  const { queue, provider, budget, logger, metrics } = options;
  const ledger = options.ledger ?? new BudgetLedger(budget);

  let claimed = 0;
  let proposed = 0;
  let failed = 0;
  let released = 0;
  let skipped = 0;
  let health: ProviderHealth = 'healthy';
  let degradedReason: string | undefined;

  if (!provider.isAvailable()) {
    return {
      claimed: 0,
      proposed: 0,
      failed: 0,
      released: 0,
      skipped: 0,
      health: 'degraded',
      degradedReason: `provider ${provider.name} is not available`,
    };
  }

  const leaseMs = budget.perDecisionTimeoutMs * LEASE_MULTIPLIER;
  /**
   * Decisions this run has already considered.
   *
   * Releasing a refused decision returns it to the pool, so without this it would be claimed
   * again on the next round and the loop would spin until the attempt counter overflowed.
   * Nothing a run does changes a cooldown or a daily limit, so reconsidering cannot help.
   */
  const considered = new Set<string>();

  while (!ledger.exhausted() && health === 'healthy') {
    const want = Math.min(CLAIM_CHUNK, ledger.remainingThisRun);
    if (want <= 0) break;

    const batch = await queue.claim(want, options.holder, leaseMs);
    if (batch.length === 0) break;

    const fresh: PendingDecision[] = [];
    for (const decision of batch) {
      if (considered.has(decision.id)) {
        await queue.release(decision, 'already considered in this execution');
      } else {
        considered.add(decision.id);
        fresh.push(decision);
      }
    }
    if (fresh.length === 0) break;

    claimed += fresh.length;
    metrics.increment('decisions.claimed', fresh.length);

    for (const decision of fresh) {
      const refusal = ledger.refusalFor(decision.lineageId, decision.createdAtTick);
      if (refusal !== undefined) {
        await queue.release(decision, refusal);
        released += 1;
        skipped += 1;
        continue;
      }

      const outcome = await attempt(options, decision, ledger);
      if (outcome.kind === 'proposed') {
        proposed += 1;
      } else if (outcome.kind === 'failed') {
        failed += 1;
      } else if (outcome.kind === 'released') {
        released += 1;
      } else {
        health = 'degraded';
        degradedReason = outcome.reason;
        released += 1;
        break;
      }
    }
  }

  logger.info('think batch complete', {
    claimed,
    proposed,
    failed,
    released,
    skipped,
    health,
    provider: provider.name,
  });

  return {
    claimed,
    proposed,
    failed,
    released,
    skipped,
    health,
    ...(degradedReason === undefined ? {} : { degradedReason }),
  };
}

type AttemptOutcome =
  | { kind: 'proposed' }
  | { kind: 'failed' }
  | { kind: 'released' }
  | { kind: 'degraded'; reason: string };

async function attempt(
  options: ThinkBatchOptions,
  decision: PendingDecision,
  ledger: BudgetLedger,
): Promise<AttemptOutcome> {
  const { queue, provider, budget, logger, metrics } = options;
  ledger.consume(decision.lineageId, decision.createdAtTick);
  metrics.increment('model.calls');

  try {
    const proposal = await metrics.time('api.durationMs', () =>
      provider.propose(requestFromDecision(decision, budget.perDecisionTimeoutMs)),
    );
    await queue.storeProposal(decision, proposal);
    if (proposal.promptTokens !== undefined) {
      metrics.increment('model.promptTokens', proposal.promptTokens);
    }
    if (proposal.completionTokens !== undefined) {
      metrics.increment('model.completionTokens', proposal.completionTokens);
    }
    logger.debug('proposal stored', {
      decisionId: decision.id,
      action: proposal.action.type,
      latencyMs: proposal.latencyMs,
    });
    return { kind: 'proposed' };
  } catch (cause) {
    metrics.increment('model.failures');

    if (cause instanceof ProposalRejected) {
      // Malformed output is the model's fault, not an outage. Retry until attempts run out.
      metrics.increment('proposals.invalid');
      return await giveUpOrRelease(options, decision, `invalid proposal: ${cause.detail}`);
    }

    const retryable = cause instanceof DecisionProviderError ? cause.retryable : true;
    const reason = cause instanceof Error ? cause.message : 'unknown provider failure';

    if (options.failClosed) {
      await queue.release(decision, reason);
      logger.error('decision provider degraded', { decisionId: decision.id, reason });
      return { kind: 'degraded', reason };
    }

    if (!retryable) {
      await queue.fail(decision, reason);
      return { kind: 'failed' };
    }
    return await giveUpOrRelease(options, decision, reason);
  }
}

async function giveUpOrRelease(
  options: ThinkBatchOptions,
  decision: PendingDecision,
  reason: string,
): Promise<AttemptOutcome> {
  if (decision.attempts + 1 >= options.budget.maxAttemptsPerDecision) {
    await options.queue.fail(decision, reason);
    return { kind: 'failed' };
  }
  await options.queue.release(decision, reason);
  return { kind: 'released' };
}
