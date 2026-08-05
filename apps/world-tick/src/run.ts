import {
  RECORD_VERSION,
  WorldEventSchema,
  type ActionProposal,
  type DecisionRecord,
  type OrganismId,
  type PendingDecision,
  type StoredWorldEvent,
} from '@autocosm/domain';
import type { Logger, Metrics } from '@autocosm/observability';
import {
  advanceTick,
  fromRecords,
  generateWorld,
  toRecords,
  type WorldState,
} from '@autocosm/simulation';
import {
  ConcurrencyConflict,
  loadWorldBundle,
  saveWorldBundle,
  type WorldRepository,
} from '@autocosm/storage';
import type { TickConfig } from './config.js';

/**
 * One bounded, idempotent world-advance execution.
 *
 * Safety rests on four things:
 *
 * 1. A lease. Only one execution advances a world at a time; a second run exits immediately
 *    rather than queuing, because a queued run would be stale by the time it started.
 * 2. Deterministic identifiers. Replaying tick N regenerates the same event ids, so the
 *    append is a no-op the second time round.
 * 3. Ordering. World data is written before the world row, and the watermark after both, so
 *    a crash always leaves the world *behind*, never ahead. Recomputing is safe; skipping is not.
 * 4. Budgets. `maxTicksPerRun` and `executionBudgetMs` bound the work; the remainder is left
 *    for the next scheduled run instead of being forced through.
 */

export const TICK_LEASE = 'tick';
export const TICK_WATERMARK = 'tick';

export interface TickRunResult {
  readonly outcome: 'advanced' | 'skippedLeaseHeld' | 'seeded' | 'upToDate';
  readonly ticksAdvanced: number;
  readonly startTick: number;
  readonly endTick: number;
  readonly eventsWritten: number;
  readonly decisionsCreated: number;
  readonly proposalsApplied: number;
  readonly lagTicks: number;
  readonly durationMs: number;
}

export interface TickRunOptions {
  readonly repository: WorldRepository;
  readonly config: TickConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly holder: string;
  readonly now?: () => number;
}

export async function runTick(options: TickRunOptions): Promise<TickRunResult> {
  const { repository, config, metrics } = options;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const logger = options.logger.child({ jobExecutionId: options.holder });

  const lease = await repository.control.acquireLease({
    worldId: config.worldId,
    name: TICK_LEASE,
    holder: options.holder,
    nowEpochMs: now(),
    ttlMs: config.leaseTtlMs,
  });
  if (!lease) {
    metrics.increment('tick.skipped');
    logger.info('tick.skipped', { detail: 'another execution holds the tick lease' });
    return empty('skippedLeaseHeld', now() - startedAtMs);
  }

  try {
    let bundle = await loadWorldBundle(repository, config.worldId);

    if (!bundle) {
      if (!config.seedIfMissing) {
        logger.warn('tick.noWorld', { detail: 'world absent and seeding disabled' });
        return empty('upToDate', now() - startedAtMs);
      }
      const seeded = generateWorld({ seed: config.worldSeed, worldId: config.worldId });
      await saveWorldBundle(repository, toRecords(seeded));
      await putWatermark(repository, config.worldId, seeded.world.tick, now);
      logger.info('tick.seeded', {
        seed: config.worldSeed,
        lineages: seeded.lineages.size,
        organisms: seeded.organisms.size,
      });
      return {
        ...empty('seeded', now() - startedAtMs),
        startTick: seeded.world.tick,
        endTick: seeded.world.tick,
      };
    }

    const worldRow = await repository.worlds.get(config.worldId);
    let worldEtag = worldRow?.etag;
    let state = fromRecords(bundle);
    const startTick = state.world.tick;

    const target = await targetTick(repository, config, state, now);
    const lag = Math.max(0, target - startTick);
    metrics.gauge('tick.lag', lag);

    let advanced = 0;
    let eventsWritten = 0;
    let decisionsCreated = 0;
    let proposalsApplied = 0;

    while (advanced < config.maxTicksPerRun && state.world.tick < target) {
      if (now() - startedAtMs > config.executionBudgetMs) {
        logger.info('tick.budgetReached', { detail: 'stopping early; next run continues' });
        break;
      }

      const proposals = await claimProposals(repository, config.worldId, state.world.tick);
      const result = advanceTick(state, { proposals: proposals.byOrganism });

      const nextBundle = toRecords(result.state);
      worldEtag = await saveWorldBundle(repository, nextBundle, {
        previous: bundle,
        ...(worldEtag === undefined ? {} : { worldEtag }),
      });

      const append = await repository.events.append(result.events.map(toStoredEvent));
      eventsWritten += append.written;
      metrics.increment('tick.eventsWritten', append.written);

      if (result.decisions.length > 0) {
        await repository.decisions.putMany(result.decisions.map(toDecisionRecord));
        decisionsCreated += result.decisions.length;
      }
      if (proposals.appliedIds.length > 0) {
        await markApplied(repository, config.worldId, proposals.appliedIds);
        proposalsApplied += proposals.appliedIds.length;
      }

      await putWatermark(repository, config.worldId, result.state.world.tick, now);

      bundle = nextBundle;
      state = result.state;
      advanced += 1;

      metrics.increment('tick.executed');
      metrics.increment('organisms.born', result.metrics.births);
      metrics.increment('organisms.died', result.metrics.deaths);
      metrics.gauge('organisms.active', result.metrics.livingOrganisms);
    }

    // Housekeeping runs once per execution, not once per tick, and is bounded.
    const expired = await repository.decisions.expireStaleClaims(config.worldId, now(), 200);
    if (expired > 0) metrics.increment('decisions.expired', expired);

    if (config.eventRetentionTicks > 0 && state.world.tick > config.eventRetentionTicks) {
      await repository.events.compact(
        config.worldId,
        state.world.tick - config.eventRetentionTicks,
        config.maxEventsCompactedPerRun,
      );
    }

    const pending = await repository.decisions.countByStatus(config.worldId);
    metrics.gauge('decisions.pending', pending['pending'] ?? 0);
    metrics.gauge('tick.catchupRemaining', Math.max(0, target - state.world.tick));

    const durationMs = now() - startedAtMs;
    metrics.observeDuration('tick.durationMs', durationMs);
    logger.info('tick.completed', {
      startTick,
      endTick: state.world.tick,
      ticksAdvanced: advanced,
      eventsWritten,
      decisionsCreated,
      proposalsApplied,
      remaining: Math.max(0, target - state.world.tick),
      durationMs,
      outcome: 'ok',
    });

    return {
      outcome: advanced > 0 ? 'advanced' : 'upToDate',
      ticksAdvanced: advanced,
      startTick,
      endTick: state.world.tick,
      eventsWritten,
      decisionsCreated,
      proposalsApplied,
      lagTicks: Math.max(0, target - state.world.tick),
      durationMs,
    };
  } catch (cause) {
    if (cause instanceof ConcurrencyConflict) {
      // Another writer won. Retrying now would race again; the next scheduled run is soon.
      metrics.increment('storage.conflicts');
      logger.warn('tick.conflict', { detail: cause.message, outcome: 'degraded' });
      return empty('skippedLeaseHeld', now() - startedAtMs);
    }
    throw cause;
  } finally {
    await repository.control.releaseLease(config.worldId, TICK_LEASE, options.holder);
  }
}

/**
 * How far the world should have advanced by now.
 *
 * Derived from the watermark's wall-clock timestamp so a restarted or long-idle deployment
 * catches up gradually rather than jumping, and a fresh world starts from where it is.
 */
async function targetTick(
  repository: WorldRepository,
  config: TickConfig,
  state: WorldState,
  now: () => number,
): Promise<number> {
  const watermark = await repository.control.getWatermark(config.worldId, TICK_WATERMARK);
  if (!watermark) return state.world.tick + config.ticksPerMinute;
  const elapsedMs = now() - Date.parse(watermark.value.updatedAtIso);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return state.world.tick + config.ticksPerMinute;
  const owed = Math.floor((elapsedMs / 60_000) * config.ticksPerMinute);
  return state.world.tick + Math.max(1, owed);
}

async function putWatermark(
  repository: WorldRepository,
  worldId: string,
  tick: number,
  now: () => number,
): Promise<void> {
  const existing = await repository.control.getWatermark(worldId, TICK_WATERMARK);
  await repository.control.putWatermark(
    {
      rv: RECORD_VERSION,
      worldId,
      name: TICK_WATERMARK,
      tick,
      updatedAtIso: new Date(now()).toISOString(),
    },
    existing?.etag,
  );
}

interface ClaimedProposals {
  readonly byOrganism: ReadonlyMap<OrganismId, ActionProposal>;
  readonly appliedIds: readonly string[];
}

/**
 * Collect proposals the think job has produced for organisms that are still relevant.
 *
 * A proposal whose decision has already expired in simulated time is ignored: acting on a stale
 * observation would let a model steer the world using facts that are no longer true.
 */
async function claimProposals(
  repository: WorldRepository,
  worldId: string,
  currentTick: number,
): Promise<ClaimedProposals> {
  const proposed = await repository.decisions.listProposed(worldId, 64);
  const byOrganism = new Map<OrganismId, ActionProposal>();
  const appliedIds: string[] = [];

  for (const record of proposed) {
    if (record.proposalJson === undefined) continue;
    if (record.expiresAtTick < currentTick) continue;
    let proposal: ActionProposal;
    try {
      proposal = JSON.parse(record.proposalJson) as ActionProposal;
    } catch {
      continue;
    }
    byOrganism.set(record.organismId as OrganismId, proposal);
    appliedIds.push(record.id);
  }
  return { byOrganism, appliedIds };
}

async function markApplied(
  repository: WorldRepository,
  worldId: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    const stored = await repository.decisions.get(worldId, id);
    if (!stored) continue;
    try {
      await repository.decisions.put({ ...stored.value, status: 'applied' }, stored.etag);
    } catch (cause) {
      // Losing this race is harmless: the decision stays 'proposed' and expires naturally.
      if (!(cause instanceof ConcurrencyConflict)) throw cause;
    }
  }
}

function toStoredEvent(event: {
  id: string;
  version: number;
  worldId: string;
  regionId: string;
  tick: number;
  ordinal: number;
  kind: string;
  summary: string;
  payload: unknown;
  agentId?: string | undefined;
  lineageId?: string | undefined;
  organismId?: string | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
}): StoredWorldEvent {
  return WorldEventSchema.parse(event);
}

function toDecisionRecord(decision: PendingDecision): DecisionRecord {
  return {
    rv: RECORD_VERSION,
    id: decision.id,
    worldId: decision.worldId,
    agentId: decision.agentId,
    lineageId: decision.lineageId,
    organismId: decision.organismId,
    regionId: decision.regionId,
    createdAtTick: decision.createdAtTick,
    expiresAtTick: decision.expiresAtTick,
    reason: decision.reason,
    status: 'pending',
    observationJson: JSON.stringify(decision.observation),
    attempts: 0,
  };
}

function empty(outcome: TickRunResult['outcome'], durationMs: number): TickRunResult {
  return {
    outcome,
    ticksAdvanced: 0,
    startTick: 0,
    endTick: 0,
    eventsWritten: 0,
    decisionsCreated: 0,
    proposalsApplied: 0,
    lagTicks: 0,
    durationMs,
  };
}
