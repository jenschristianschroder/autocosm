import { z } from 'zod';
import { DecisionBudgetSchema } from '@autocosm/agent-runtime';
import { LogLevelSchema } from '@autocosm/observability';
import { StorageConfigSchema } from '@autocosm/storage';

/**
 * Think job configuration.
 *
 * Every knob here exists to bound spend. The defaults are deliberately small: a scheduled job
 * that quietly scales its own model usage is the easiest way to turn a hobby world into a bill.
 */

export const ThinkConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: LogLevelSchema.default('info'),
  worldId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .default('autocosm'),
  storage: StorageConfigSchema,
  provider: z.object({
    kind: z.enum(['heuristic', 'azure-openai']).default('heuristic'),
    azureOpenAiEndpoint: z.string().url().optional(),
    azureOpenAiDeployment: z.string().min(1).max(64).optional(),
    azureOpenAiApiVersion: z.string().min(1).max(32).default('2024-10-21'),
    managedIdentityClientId: z.string().min(1).max(64).optional(),
    maxCompletionTokens: z.number().int().min(32).max(4_096).default(320),
    maxRetries: z.number().int().min(0).max(5).default(1),
    /**
     * Debug-only switch (`AUTOCOSM_LOG_OPENAI_IO`). When true the think job writes raw, unredacted
     * Azure OpenAI request/response bodies to stdout. Default false; never leave on in production.
     */
    logModelIo: z.boolean().default(false),
  }),
  budget: DecisionBudgetSchema,
  /** Overall wall-clock ceiling. The job exits cleanly at this point whatever remains. */
  executionBudgetMs: z.coerce.number().int().min(1_000).max(600_000).default(50_000),
  /** Stable execution identity, used as the claim holder so logs and claims agree. */
  executionName: z.string().min(1).max(80).optional(),
});

export type ThinkConfig = z.infer<typeof ThinkConfigSchema>;

export class InvalidConfiguration extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfiguration';
  }
}

const processEnvironment = process.env;

/**
 * Drop variables that are present but empty.
 *
 * Deployment templates routinely render an optional value as `""`. An empty string that reaches a
 * schema as "configured" fails much later and much less clearly than one that was never set — a
 * blank `AZURE_OPENAI_ENDPOINT` would satisfy the "endpoint is present" check and then produce an
 * unexplained request failure on the first decision.
 */
function present(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') out[key] = trimmed;
  }
  return out;
}

export function loadThinkConfig(rawEnv: NodeJS.ProcessEnv = processEnvironment): ThinkConfig {
  const env = present(rawEnv);
  const isProduction = env['NODE_ENV'] === 'production';
  const parsed = ThinkConfigSchema.safeParse({
    nodeEnv: env['NODE_ENV'] ?? 'development',
    logLevel: env['AUTOCOSM_LOG_LEVEL'] ?? 'info',
    worldId: env['AUTOCOSM_WORLD_ID'] ?? 'autocosm',
    storage: {
      driver: env['AUTOCOSM_STORAGE_DRIVER'] ?? (isProduction ? 'azureTables' : 'memory'),
      tableEndpoint: env['AZURE_TABLE_ENDPOINT'],
      managedIdentityClientId: env['AZURE_CLIENT_ID'],
      isProduction,
    },
    provider: {
      kind: env['AUTOCOSM_DECISION_PROVIDER'] ?? 'heuristic',
      azureOpenAiEndpoint: env['AZURE_OPENAI_ENDPOINT'],
      azureOpenAiDeployment: env['AZURE_OPENAI_DEPLOYMENT'],
      azureOpenAiApiVersion: env['AZURE_OPENAI_API_VERSION'] ?? '2024-10-21',
      managedIdentityClientId: env['AZURE_CLIENT_ID'],
      maxCompletionTokens: numberOr(env['AUTOCOSM_MAX_COMPLETION_TOKENS'], 320),
      maxRetries: numberOr(env['AUTOCOSM_MODEL_MAX_RETRIES'], 1),
      logModelIo: env['AUTOCOSM_LOG_OPENAI_IO'] === 'true',
    },
    budget: {
      maxDecisionsPerRun: numberOr(env['AUTOCOSM_MAX_DECISIONS_PER_RUN'], undefined),
      maxDecisionsPerDay: numberOr(env['AUTOCOSM_MAX_DECISIONS_PER_DAY'], undefined),
      minTicksBetweenLineageDecisions: numberOr(env['AUTOCOSM_MIN_TICKS_BETWEEN'], undefined),
      perDecisionTimeoutMs: numberOr(env['AUTOCOSM_DECISION_TIMEOUT_MS'], undefined),
      runBudgetMs: numberOr(env['AUTOCOSM_THINK_BUDGET_MS'], undefined),
      maxAttemptsPerDecision: numberOr(env['AUTOCOSM_MAX_DECISION_ATTEMPTS'], undefined),
      maxCompletionTokens: numberOr(env['AUTOCOSM_MAX_COMPLETION_TOKENS'], undefined),
    },
    executionBudgetMs: env['AUTOCOSM_THINK_BUDGET_MS'] ?? 50_000,
    executionName: env['CONTAINER_APP_REPLICA_NAME'],
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfiguration(`invalid think configuration: ${detail}`);
  }

  const config = parsed.data;
  if (config.nodeEnv === 'production' && config.storage.driver !== 'azureTables') {
    throw new InvalidConfiguration('production requires AUTOCOSM_STORAGE_DRIVER=azureTables');
  }
  if (
    config.provider.kind === 'azure-openai' &&
    (!config.provider.azureOpenAiEndpoint || !config.provider.azureOpenAiDeployment)
  ) {
    throw new InvalidConfiguration(
      'AUTOCOSM_DECISION_PROVIDER=azure-openai requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT',
    );
  }
  return config;
}

/** Undefined lets the schema default apply; an unparseable value must not silently become zero. */
function numberOr(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
