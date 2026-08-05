import { randomUUID } from 'node:crypto';
import {
  BudgetLedger,
  createDecisionProvider,
  runThinkBatch,
  shouldFailClosed,
  type ThinkBatchResult,
} from '@autocosm/agent-runtime';
import { Logger, Metrics } from '@autocosm/observability';
import { createRepository, type WorldRepository } from '@autocosm/storage';
import { loadThinkConfig, type ThinkConfig } from './config.js';
import { RepositoryDecisionQueue, dayKeyFor, readDailySpend, recordDailySpend } from './queue.js';

/**
 * `think` mode entry point.
 *
 * One bounded batch, then exit. If nothing is claimable the job returns immediately rather than
 * polling, because a scale-to-zero job that waits for work is just an always-on worker with
 * extra steps.
 *
 * `overrides.repository` lets the local development harness run real think batches against the
 * same in-memory store the web process serves from. Production passes nothing.
 */

export interface ThinkRunResult extends ThinkBatchResult {
  readonly usedToday: number;
  readonly durationMs: number;
}

export interface ThinkRunOptions {
  readonly repository: WorldRepository;
  readonly config: ThinkConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly holder: string;
  readonly now?: () => number;
}

export async function runThink(options: ThinkRunOptions): Promise<ThinkRunResult> {
  const { repository, config, metrics } = options;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const logger = options.logger.child({ jobExecutionId: options.holder });

  const dayKey = dayKeyFor(now());
  const usedToday = await readDailySpend(repository, config.worldId, dayKey);

  const budget = { ...config.budget, runBudgetMs: config.executionBudgetMs };
  const ledger = new BudgetLedger(budget, { usedToday, now });

  if (ledger.exhausted()) {
    logger.info('think.dailyBudgetSpent', { usedToday, outcome: 'skipped' });
    return {
      claimed: 0,
      proposed: 0,
      failed: 0,
      released: 0,
      skipped: 0,
      health: 'healthy',
      usedToday,
      durationMs: now() - startedAtMs,
    };
  }

  const provider = createDecisionProvider(config.provider);
  const queue = new RepositoryDecisionQueue(repository, config.worldId, now);

  const result = await runThinkBatch({
    queue,
    provider,
    budget,
    ledger,
    holder: options.holder,
    logger,
    metrics,
    failClosed: shouldFailClosed(config.provider),
  });

  await recordDailySpend(repository, config.worldId, dayKey, ledger.usedThisRun);

  const pending = await repository.decisions.countByStatus(config.worldId);
  metrics.gauge('decisions.pending', pending['pending'] ?? 0);
  metrics.increment('decisions.applied', result.proposed);

  const durationMs = now() - startedAtMs;
  logger.info('think.completed', {
    provider: provider.name,
    claimed: result.claimed,
    proposed: result.proposed,
    failed: result.failed,
    released: result.released,
    skipped: result.skipped,
    usedToday: usedToday + ledger.usedThisRun,
    durationMs,
    outcome: result.health === 'healthy' ? 'ok' : 'degraded',
  });

  return { ...result, usedToday: usedToday + ledger.usedThisRun, durationMs };
}

export async function main(
  config: ThinkConfig = loadThinkConfig(),
  overrides: { readonly repository?: WorldRepository } = {},
): Promise<ThinkRunResult> {
  const holder = config.executionName ?? randomUUID();
  const logger = new Logger({
    level: config.logLevel,
    context: { mode: 'think', worldId: config.worldId, jobExecutionId: holder },
  });
  const metrics = new Metrics();

  const repository = overrides.repository ?? createRepository(config.storage);
  await repository.initialise();

  const result = await runThink({ repository, config, logger, metrics, holder });
  logger.info('think.metrics', { snapshot: JSON.stringify(metrics.snapshot()).slice(0, 1500) });
  return result;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/gu, '/')}`;

if (invokedDirectly) {
  main().then(
    (result) => {
      // A degraded model is an operational signal, not a crash: exit non-zero so the schedule
      // surfaces it, but only after the batch has been cleanly released.
      process.exitCode = result.health === 'healthy' ? 0 : 2;
    },
    (error: unknown) => {
      // eslint-disable-next-line no-console -- a job failure must surface before the logger exists
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
