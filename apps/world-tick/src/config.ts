import { z } from 'zod';
import { LogLevelSchema } from '@autocosm/observability';
import { StorageConfigSchema } from '@autocosm/storage';

/**
 * Tick job configuration.
 *
 * The two budgets here are what keep a scheduled minute-long execution from becoming an
 * unbounded one: `maxTicksPerRun` caps how much catch-up a single run attempts, and
 * `executionBudgetMs` stops it early even when that cap has not been reached. Whatever is left
 * over is simply picked up by the next run.
 */

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const TickConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: LogLevelSchema.default('info'),
  worldId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .default('autocosm'),
  worldSeed: z.coerce.number().int().default(4_242_424),
  storage: StorageConfigSchema,
  /** Simulated ticks a single wall-clock minute represents. */
  ticksPerMinute: z.coerce.number().int().min(1).max(240).default(4),
  /** Hard ceiling on ticks advanced in one execution, however far behind the world is. */
  maxTicksPerRun: z.coerce.number().int().min(1).max(2_000).default(60),
  /** Wall-clock budget. The run stops cleanly at this point and leaves the rest for later. */
  executionBudgetMs: z.coerce.number().int().min(1_000).max(600_000).default(45_000),
  /** How long this run holds the tick lease. Must exceed the execution budget. */
  leaseTtlMs: z.coerce.number().int().min(5_000).max(900_000).default(90_000),
  /** Events older than this many ticks are compacted away. Zero disables compaction. */
  eventRetentionTicks: z.coerce.number().int().min(0).max(1_000_000).default(20_000),
  maxEventsCompactedPerRun: z.coerce.number().int().min(0).max(10_000).default(500),
  /** Seed the world if it is absent. Safe for the tick job: it is the authoritative writer. */
  seedIfMissing: boolish.default(true),
  /** Stable execution identity, used as the lease holder so logs and leases agree. */
  executionName: z.string().min(1).max(80).optional(),
});

export type TickConfig = z.infer<typeof TickConfigSchema>;

export class InvalidConfiguration extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfiguration';
  }
}

const processEnvironment = process.env;

/**
 * Drop variables that are present but empty. A deployment template that renders an optional value
 * as `""` would otherwise look configured, and the resulting failure appears far from its cause.
 */
function present(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') out[key] = trimmed;
  }
  return out;
}

export function loadTickConfig(rawEnv: NodeJS.ProcessEnv = processEnvironment): TickConfig {
  const env = present(rawEnv);
  const isProduction = env['NODE_ENV'] === 'production';
  const parsed = TickConfigSchema.safeParse({
    nodeEnv: env['NODE_ENV'] ?? 'development',
    logLevel: env['AUTOCOSM_LOG_LEVEL'] ?? 'info',
    worldId: env['AUTOCOSM_WORLD_ID'] ?? 'autocosm',
    worldSeed: env['AUTOCOSM_WORLD_SEED'] ?? 4_242_424,
    storage: {
      driver: env['AUTOCOSM_STORAGE_DRIVER'] ?? (isProduction ? 'azureTables' : 'memory'),
      tableEndpoint: env['AZURE_TABLE_ENDPOINT'],
      managedIdentityClientId: env['AZURE_CLIENT_ID'],
      isProduction,
    },
    ticksPerMinute: env['AUTOCOSM_TICKS_PER_MINUTE'] ?? 4,
    maxTicksPerRun: env['AUTOCOSM_MAX_TICKS_PER_RUN'] ?? 60,
    executionBudgetMs: env['AUTOCOSM_TICK_BUDGET_MS'] ?? 45_000,
    leaseTtlMs: env['AUTOCOSM_TICK_LEASE_MS'] ?? 90_000,
    eventRetentionTicks: env['AUTOCOSM_EVENT_RETENTION_TICKS'] ?? 20_000,
    maxEventsCompactedPerRun: env['AUTOCOSM_MAX_EVENTS_COMPACTED'] ?? 500,
    seedIfMissing: env['AUTOCOSM_SEED_IF_MISSING'] ?? true,
    executionName: env['CONTAINER_APP_REPLICA_NAME'],
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfiguration(`invalid tick configuration: ${detail}`);
  }

  const config = parsed.data;
  if (config.nodeEnv === 'production' && config.storage.driver !== 'azureTables') {
    throw new InvalidConfiguration('production requires AUTOCOSM_STORAGE_DRIVER=azureTables');
  }
  // A lease that expires mid-run would let a second execution start and double-apply a tick.
  if (config.leaseTtlMs <= config.executionBudgetMs) {
    throw new InvalidConfiguration(
      'AUTOCOSM_TICK_LEASE_MS must exceed AUTOCOSM_TICK_BUDGET_MS so the lease cannot expire mid-run',
    );
  }
  return config;
}
