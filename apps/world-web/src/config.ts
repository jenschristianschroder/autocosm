import { z } from 'zod';
import { LogLevelSchema } from '@autocosm/observability';
import { StorageConfigSchema } from '@autocosm/storage';

/**
 * Environment configuration, validated exactly once at startup.
 *
 * Domain and simulation code never reads `process.env`; everything arrives through this schema so
 * a missing or malformed variable fails the container immediately rather than at the first
 * request. Nothing here is a secret: storage and model access use managed identity.
 */

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const WebConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  host: z.string().min(1).max(64).default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65_535).default(8080),
  logLevel: LogLevelSchema.default('info'),
  worldId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .default('autocosm'),
  worldSeed: z.coerce.number().int().default(4_242_424),
  storage: StorageConfigSchema,
  /** Signs the anonymous creator cookie. Generated per-process when absent, which is fine
   *  for a prototype identity but means creator identity does not survive a restart. */
  creatorSigningKey: z.string().min(16).max(200).optional(),
  staticRoot: z.string().max(400).optional(),
  /**
   * Local development only. Without a static root this app is API-only, so the root path would
   * answer a bare JSON 404 and look broken; this is the client URL it points at instead. The
   * pattern excludes `javascript:` and friends because the value is interpolated into HTML.
   */
  devClientUrl: z
    .string()
    .max(200)
    .regex(/^https?:\/\/[^\s"'<>]+$/u)
    .optional(),
  /** Seconds a regional snapshot may be cached by the browser and any shared cache. */
  snapshotCacheSeconds: z.coerce.number().int().min(0).max(60).default(2),
  maxAgentsPerCreatorPerDay: z.coerce.number().int().min(0).max(100).default(3),
  maxGoalsPerCreatorPerDay: z.coerce.number().int().min(0).max(100).default(6),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(10_000).default(240),
  maxRequestBodyBytes: z.coerce.number().int().min(1_024).max(1_048_576).default(16_384),
  /** Local-development only. Production startup refuses this. */
  allowLocalSeeding: boolish.default(false),
  heuristicOnly: boolish.default(true),
});

export type WebConfig = z.infer<typeof WebConfigSchema>;

export class InvalidConfiguration extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfiguration';
  }
}

/** The single place the process environment is read. Everything else takes explicit input. */
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

export function loadWebConfig(rawEnv: NodeJS.ProcessEnv = processEnvironment): WebConfig {
  const env = present(rawEnv);
  const isProduction = env['NODE_ENV'] === 'production';
  const parsed = WebConfigSchema.safeParse({
    nodeEnv: env['NODE_ENV'] ?? 'development',
    host: env['HOST'] ?? '0.0.0.0',
    port: env['PORT'] ?? 8080,
    logLevel: env['AUTOCOSM_LOG_LEVEL'] ?? 'info',
    worldId: env['AUTOCOSM_WORLD_ID'] ?? 'autocosm',
    worldSeed: env['AUTOCOSM_WORLD_SEED'] ?? 4_242_424,
    storage: {
      driver: env['AUTOCOSM_STORAGE_DRIVER'] ?? (isProduction ? 'azureTables' : 'memory'),
      tableEndpoint: env['AZURE_TABLE_ENDPOINT'],
      managedIdentityClientId: env['AZURE_CLIENT_ID'],
      isProduction,
    },
    creatorSigningKey: env['AUTOCOSM_CREATOR_SIGNING_KEY'],
    staticRoot: env['AUTOCOSM_STATIC_ROOT'],
    devClientUrl: env['AUTOCOSM_DEV_CLIENT_URL'],
    snapshotCacheSeconds: env['AUTOCOSM_SNAPSHOT_CACHE_SECONDS'] ?? 2,
    maxAgentsPerCreatorPerDay: env['AUTOCOSM_MAX_AGENTS_PER_DAY'] ?? 3,
    maxGoalsPerCreatorPerDay: env['AUTOCOSM_MAX_GOALS_PER_DAY'] ?? 6,
    rateLimitPerMinute: env['AUTOCOSM_RATE_LIMIT_PER_MINUTE'] ?? 240,
    maxRequestBodyBytes: env['AUTOCOSM_MAX_BODY_BYTES'] ?? 16_384,
    allowLocalSeeding: env['AUTOCOSM_ALLOW_LOCAL_SEEDING'] ?? false,
    heuristicOnly:
      env['AUTOCOSM_DECISION_PROVIDER'] === undefined ||
      env['AUTOCOSM_DECISION_PROVIDER'] === 'heuristic',
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfiguration(`invalid web configuration: ${detail}`);
  }

  const config = parsed.data;

  // Seeding writes authoritative world state from a request path. That must never be reachable
  // in production, regardless of how the variable was set.
  if (config.nodeEnv === 'production' && config.allowLocalSeeding) {
    throw new InvalidConfiguration(
      'AUTOCOSM_ALLOW_LOCAL_SEEDING must not be enabled in production: seeding mutates authoritative world state',
    );
  }
  if (config.nodeEnv === 'production' && config.storage.driver !== 'azureTables') {
    throw new InvalidConfiguration('production requires AUTOCOSM_STORAGE_DRIVER=azureTables');
  }

  return config;
}
