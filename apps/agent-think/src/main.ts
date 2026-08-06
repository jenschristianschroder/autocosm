import { randomUUID } from 'node:crypto';
import {
  BudgetLedger,
  createDecisionProvider,
  runThinkBatch,
  shouldFailClosed,
  type ModelIoLogEntry,
  type ThinkBatchResult,
} from '@autocosm/agent-runtime';
import { Logger, Metrics } from '@autocosm/observability';
import { createRepository, createSettingsStore, type WorldRepository } from '@autocosm/storage';
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

  if (config.provider.logModelIo) {
    logger.warn('think.modelIoLoggingEnabled', {
      note: 'raw Azure OpenAI prompts and responses are being written to stdout; disable in production',
    });
  }
  const provider = createDecisionProvider(
    config.provider,
    config.provider.logModelIo ? { recordModelIo: makeModelIoRecorder(config.worldId) } : {},
  );
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

/** Longest raw prompt/response fragment kept per field, so one line can never grow unbounded. */
const MODEL_IO_FIELD_MAX = 8_000;

/**
 * Build the raw model-IO recorder.
 *
 * This deliberately bypasses the sanitising `Logger`: the entire point of the switch is to see the
 * *unredacted* prompt and response, which the structured logger is built to withhold. It is gated
 * behind `AUTOCOSM_LOG_OPENAI_IO` (default off), writes one bounded JSON line per event to stdout so
 * it still reaches Log Analytics, and is loudly labelled so it cannot be mistaken for an ordinary
 * log line or left on unnoticed.
 */
function makeModelIoRecorder(worldId: string): (entry: ModelIoLogEntry) => void {
  return (entry) => {
    const line = {
      event: 'openai.io',
      warning: 'RAW MODEL IO \u2014 unredacted prompt/response; disable in production',
      worldId,
      timestamp: new Date().toISOString(),
      phase: entry.phase,
      decisionId: entry.decisionId,
      deployment: entry.deployment,
      reason: entry.reason,
      systemPrompt: boundText(entry.systemPrompt),
      userPrompt: boundText(entry.userPrompt),
      responseText: boundText(entry.responseText),
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      errorMessage: entry.errorMessage,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
}

function boundText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > MODEL_IO_FIELD_MAX
    ? `${text.slice(0, MODEL_IO_FIELD_MAX)}\u2026[truncated ${text.length - MODEL_IO_FIELD_MAX} chars]`
    : text;
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

  // The admin inspector can flip raw model-IO logging at runtime by writing a runtime-settings row.
  // It overrides the AUTOCOSM_LOG_OPENAI_IO env default and takes effect on this run. Reading it must
  // never take the job down, so any failure falls back to the env-configured default.
  let effectiveConfig = config;
  try {
    const stored = await createSettingsStore(config.storage).read();
    if (stored.logOpenAiIo !== undefined && stored.logOpenAiIo !== config.provider.logModelIo) {
      effectiveConfig = {
        ...config,
        provider: { ...config.provider, logModelIo: stored.logOpenAiIo },
      };
    }
  } catch (error) {
    logger.warn('think.settingsReadFailed', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const result = await runThink({ repository, config: effectiveConfig, logger, metrics, holder });
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
