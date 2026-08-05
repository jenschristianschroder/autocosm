import { randomUUID } from 'node:crypto';
import { Logger, Metrics } from '@autocosm/observability';
import { createRepository, type WorldRepository } from '@autocosm/storage';
import { loadTickConfig, type TickConfig } from './config.js';
import { runTick, type TickRunResult } from './run.js';

/**
 * `tick` mode entry point.
 *
 * Runs exactly one bounded execution and exits. It never loops or sleeps: the schedule owns
 * cadence, so a hung or slow run is visible as a job failure rather than as a container that
 * quietly stays alive and keeps costing money.
 *
 * `overrides.repository` lets the local development harness drive real ticks against the same
 * in-memory store the web process serves from. Production passes nothing.
 */

export async function main(
  config: TickConfig = loadTickConfig(),
  overrides: { readonly repository?: WorldRepository } = {},
): Promise<TickRunResult> {
  const holder = config.executionName ?? randomUUID();
  const logger = new Logger({
    level: config.logLevel,
    context: { mode: 'tick', worldId: config.worldId, jobExecutionId: holder },
  });
  const metrics = new Metrics();

  const repository = overrides.repository ?? createRepository(config.storage);
  await repository.initialise();

  const result = await runTick({ repository, config, logger, metrics, holder });
  logger.info('tick.metrics', { snapshot: JSON.stringify(metrics.snapshot()).slice(0, 1500) });
  return result;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/gu, '/')}`;

if (invokedDirectly) {
  main().then(
    (result) => {
      process.exitCode = result.outcome === 'skippedLeaseHeld' ? 0 : 0;
    },
    (error: unknown) => {
      // eslint-disable-next-line no-console -- a job failure must surface before the logger exists
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
