import { Logger } from '@autocosm/observability';
import { createRawTableReader, createSettingsStore } from '@autocosm/storage';
import { loadAdminConfig, type AdminConfig } from './config.js';
import { buildAdminServer } from './server.js';

/**
 * `admin` mode entry point.
 *
 * Configuration is validated and the read-only table reader is constructed before the listener
 * opens, so a misconfigured container fails immediately and visibly. The reader requires
 * `AUTOCOSM_STORAGE_DRIVER=azureTables`; there is no in-memory inspector because there is nothing
 * to inspect without the deployed store.
 */

export async function start(
  config: AdminConfig = loadAdminConfig(),
): Promise<{ close: () => Promise<void> }> {
  const logger = new Logger({
    level: config.logLevel,
    context: { mode: 'admin', worldId: config.worldId },
  });

  const reader = createRawTableReader(config.storage);
  const settings = createSettingsStore(config.storage);

  const app = await buildAdminServer({ config, reader, settings, logger });

  await app.listen({ host: config.host, port: config.port });
  logger.info('admin.listening', { host: config.host, port: config.port });

  const shutdown = async (): Promise<void> => {
    logger.info('admin.stopping', {});
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
