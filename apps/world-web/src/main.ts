import { randomBytes } from 'node:crypto';
import { Logger, Metrics } from '@autocosm/observability';
import {
  createRepository,
  loadWorldBundle,
  saveWorldBundle,
  type WorldRepository,
} from '@autocosm/storage';
import { generateWorld, toRecords } from '@autocosm/simulation';
import { loadWebConfig, type WebConfig } from './config.js';
import { SignedCookieCreatorIdentity } from './identity.js';
import { buildServer } from './server.js';
import { WorldService } from './world-service.js';

/**
 * `web` mode entry point.
 *
 * Everything fallible happens before the listener opens: configuration is validated, storage is
 * created and probed, and the world is seeded when local seeding is explicitly permitted. A
 * misconfigured container therefore fails immediately and visibly instead of serving errors.
 *
 * `overrides.repository` exists so a caller that already owns a repository can share it — tests,
 * and the local development harness, which runs the real tick job against the same in-memory
 * store so the world visibly advances without Azure. Production passes nothing.
 */

export async function start(
  config: WebConfig = loadWebConfig(),
  overrides: { readonly repository?: WorldRepository } = {},
): Promise<{ close: () => Promise<void> }> {
  const logger = new Logger({
    level: config.logLevel,
    context: { mode: 'web', worldId: config.worldId },
  });
  const metrics = new Metrics();

  const repository = overrides.repository ?? createRepository(config.storage);
  await repository.initialise();

  if (config.allowLocalSeeding) {
    await seedIfEmpty(repository, config, logger);
  }

  const world = new WorldService({
    repository,
    worldId: config.worldId,
    maxAgentsPerCreatorPerDay: config.maxAgentsPerCreatorPerDay,
    maxGoalsPerCreatorPerDay: config.maxGoalsPerCreatorPerDay,
    cacheTtlMs: Math.max(500, config.snapshotCacheSeconds * 1000),
  });

  const signingKey = config.creatorSigningKey ?? randomBytes(32).toString('base64url');
  if (config.creatorSigningKey === undefined) {
    logger.warn('identity.ephemeralKey', {
      detail: 'AUTOCOSM_CREATOR_SIGNING_KEY not set; creator identity will not survive a restart',
    });
  }

  const app = await buildServer({
    config,
    world,
    identity: new SignedCookieCreatorIdentity(signingKey),
    logger,
    metrics,
  });

  await app.listen({ host: config.host, port: config.port });
  logger.info('web.listening', { host: config.host, port: config.port });

  const shutdown = async (): Promise<void> => {
    logger.info('web.stopping', {});
    await app.close();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  return { close: shutdown };
}

/**
 * Seed a world for local development.
 *
 * Guarded twice: the configuration loader refuses `allowLocalSeeding` in production, and this
 * function is a no-op when a world already exists, so it can never overwrite a live world.
 */
async function seedIfEmpty(
  repository: WorldRepository,
  config: WebConfig,
  logger: Logger,
): Promise<void> {
  const existing = await loadWorldBundle(repository, config.worldId);
  if (existing) {
    logger.info('seed.skipped', { detail: 'world already exists' });
    return;
  }
  const state = generateWorld({ seed: config.worldSeed, worldId: config.worldId });
  await saveWorldBundle(repository, toRecords(state));
  logger.info('seed.created', {
    seed: config.worldSeed,
    lineages: state.lineages.size,
    organisms: state.organisms.size,
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/gu, '/')}`;

if (invokedDirectly) {
  start().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- startup failure must be visible before the logger exists
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
