import { z } from 'zod';
import { LogLevelSchema } from '@autocosm/observability';
import { StorageConfigSchema } from '@autocosm/storage';

/**
 * Admin inspector configuration, validated once at startup.
 *
 * This process is given internal ingress only (see infra/app.bicep), reads storage with a
 * table-reader-only managed identity, and never writes. Nothing here is a secret: storage access
 * is managed identity. Domain code never reads `process.env`; everything arrives through this
 * schema so a missing or malformed variable fails the container immediately.
 */
export const AdminConfigSchema = z.object({
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
  storage: StorageConfigSchema,
  /** Rows shown per table page. Bounded so one request can never pull an unbounded scan. */
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  /**
   * Browser sign-in parameters, present only for the external (Entra-fronted) deployment. These
   * are public identifiers, not secrets — the same app-registration client ID the platform's Easy
   * Auth layer validates. The server hands them to the page so it can obtain an ID token and
   * present it as a bearer token on its single write; Easy Auth's cookie flow forbids that POST as
   * a cross-site-forgery risk, whereas a bearer token is accepted. Absent for the internal
   * deployment, where there is no Easy Auth layer and the toggle posts directly.
   */
  auth: z
    .object({
      clientId: z.string().min(1).max(128).optional(),
      tenantId: z.string().min(1).max(128).optional(),
    })
    .default({}),
});

export type AdminConfig = z.infer<typeof AdminConfigSchema>;

export class InvalidConfiguration extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfiguration';
  }
}

const processEnvironment = process.env;

/** Drop variables that are present but empty, so a template-rendered `""` fails near its cause. */
function present(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') out[key] = trimmed;
  }
  return out;
}

export function loadAdminConfig(rawEnv: NodeJS.ProcessEnv = processEnvironment): AdminConfig {
  const env = present(rawEnv);
  const isProduction = env['NODE_ENV'] === 'production';
  const parsed = AdminConfigSchema.safeParse({
    nodeEnv: env['NODE_ENV'] ?? 'development',
    host: env['HOST'] ?? '0.0.0.0',
    port: env['PORT'] ?? 8080,
    logLevel: env['AUTOCOSM_LOG_LEVEL'] ?? 'info',
    worldId: env['AUTOCOSM_WORLD_ID'] ?? 'autocosm',
    storage: {
      driver: env['AUTOCOSM_STORAGE_DRIVER'] ?? (isProduction ? 'azureTables' : 'memory'),
      tableEndpoint: env['AZURE_TABLE_ENDPOINT'],
      managedIdentityClientId: env['AZURE_CLIENT_ID'],
      isProduction,
    },
    pageSize: env['AUTOCOSM_ADMIN_PAGE_SIZE'] ?? 50,
    auth: {
      clientId: env['AUTOCOSM_ADMIN_AUTH_CLIENT_ID'],
      tenantId: env['AZURE_TENANT_ID'],
    },
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfiguration(`invalid admin configuration: ${detail}`);
  }
  return parsed.data;
}
