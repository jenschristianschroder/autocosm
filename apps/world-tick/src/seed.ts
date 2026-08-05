import { Logger } from '@autocosm/observability';
import { generateWorld, toRecords } from '@autocosm/simulation';
import { createRepository, loadWorldBundle, saveWorldBundle } from '@autocosm/storage';
import { InvalidConfiguration, loadTickConfig } from './config.js';

/**
 * Local-only world seeding.
 *
 * Seeding is destructive to whatever was there before, so it refuses to run in production
 * outright rather than relying on an operator remembering not to invoke it.
 */

export async function seed(): Promise<void> {
  const config = loadTickConfig();
  if (config.nodeEnv === 'production') {
    throw new InvalidConfiguration('seeding is disabled in production');
  }

  const logger = new Logger({
    level: config.logLevel,
    context: { mode: 'tick', worldId: config.worldId },
  });
  const repository = createRepository(config.storage);
  await repository.initialise();

  const existing = await loadWorldBundle(repository, config.worldId);
  if (existing) {
    logger.info('seed.exists', { tick: existing.world.tick, detail: 'nothing to do' });
    return;
  }

  const world = generateWorld({ seed: config.worldSeed, worldId: config.worldId });
  await saveWorldBundle(repository, toRecords(world));
  logger.info('seed.created', {
    seed: config.worldSeed,
    lineages: world.lineages.size,
    organisms: world.organisms.size,
    regions: world.regions.size,
    materials: world.materials.size,
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/gu, '/')}`;

if (invokedDirectly) {
  seed().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- seeding failure must surface to the developer
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
