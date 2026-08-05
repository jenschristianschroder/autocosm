#!/usr/bin/env node
/**
 * Server used by the Playwright smoke test.
 *
 * Identical to `scripts/dev-world.mjs` except that `world-web` also serves the compiled browser
 * bundle from disk, exactly as the container does. Testing against Vite's dev server would test
 * a build that never ships.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRepository } from '@autocosm/storage';
import { loadWebConfig } from '@autocosm/world-web/dist/config.js';
import { start as startWeb } from '@autocosm/world-web/dist/main.js';
import { loadTickConfig } from '@autocosm/world-tick/dist/config.js';
import { main as runTickOnce } from '@autocosm/world-tick/dist/main.js';
import { loadThinkConfig } from '@autocosm/agent-think/dist/config.js';
import { main as runThinkOnce } from '@autocosm/agent-think/dist/main.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticRoot = path.join(root, 'apps', 'world-web', 'public');

if (!existsSync(path.join(staticRoot, 'index.html'))) {
  console.error(
    `[test-server] no browser bundle at ${staticRoot}\n` +
      '            run: npm run build --workspace @autocosm/web-client',
  );
  process.exit(1);
}

process.env['NODE_ENV'] ??= 'test';
process.env['AUTOCOSM_STORAGE_DRIVER'] ??= 'memory';
process.env['AUTOCOSM_ALLOW_LOCAL_SEEDING'] ??= 'true';
process.env['AUTOCOSM_STATIC_ROOT'] = staticRoot;

const webConfig = loadWebConfig();
const tickConfig = loadTickConfig();
const thinkConfig = loadThinkConfig();

const repository = createRepository(webConfig.storage);
await repository.initialise();

await startWeb(webConfig, { repository });
console.log(`[test-server] listening on http://${webConfig.host}:${String(webConfig.port)}`);

const tickIntervalMs = Number(process.env['AUTOCOSM_DEV_TICK_INTERVAL_MS'] ?? 900);
const thinkIntervalMs = Number(process.env['AUTOCOSM_DEV_THINK_INTERVAL_MS'] ?? 1_200);

function schedule(intervalMs, run) {
  let inFlight = false;
  setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void run()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs).unref();
}

schedule(tickIntervalMs, () => runTickOnce(tickConfig, { repository }));
schedule(thinkIntervalMs, () => runThinkOnce(thinkConfig, { repository }));

// Playwright terminates the process group; nothing else to do.
setInterval(() => undefined, 1 << 30);
