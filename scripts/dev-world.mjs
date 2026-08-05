#!/usr/bin/env node
/**
 * Local development harness — a living world with no Azure account.
 *
 * The `memory` storage adapter is per-process, so a separately spawned tick job would advance its
 * own empty world. This harness therefore creates one repository and hands it to the real
 * `world-web`, `world-tick` and `agent-think` entry points. Nothing is reimplemented: the loops
 * call exactly the bounded, idempotent executions that Container Apps Jobs invoke, so lease
 * handling, claim expiry, catch-up and idempotency are exercised locally too.
 *
 * This file is development-only wiring and is never present in the container image.
 */
import process from 'node:process';
import { createRepository } from '@autocosm/storage';
import { loadWebConfig } from '@autocosm/world-web/dist/config.js';
import { start as startWeb } from '@autocosm/world-web/dist/main.js';
import { loadTickConfig } from '@autocosm/world-tick/dist/config.js';
import { main as runTickOnce } from '@autocosm/world-tick/dist/main.js';
import { loadThinkConfig } from '@autocosm/agent-think/dist/config.js';
import { main as runThinkOnce } from '@autocosm/agent-think/dist/main.js';

process.env['NODE_ENV'] ??= 'development';
process.env['AUTOCOSM_STORAGE_DRIVER'] ??= 'memory';
process.env['AUTOCOSM_ALLOW_LOCAL_SEEDING'] ??= 'true';
process.env['AUTOCOSM_SEED_IF_MISSING'] ??= 'true';
process.env['HOST'] ??= '127.0.0.1';
process.env['PORT'] ??= '8080';

const webConfig = loadWebConfig();
const tickConfig = loadTickConfig();
const thinkConfig = loadThinkConfig();

// One store, shared. This is the whole reason the harness exists.
const repository = createRepository(webConfig.storage);
await repository.initialise();

const web = await startWeb(webConfig, { repository });
console.log(`[dev] world-web listening on http://${webConfig.host}:${webConfig.port}`);

// Compressed time: the production schedule is one execution per wall-clock minute. Locally that
// is unwatchably slow, so the interval is shorter and configurable. The work per execution is
// identical and still bounded by AUTOCOSM_MAX_TICKS_PER_RUN.
const tickIntervalMs = Number(process.env['AUTOCOSM_DEV_TICK_INTERVAL_MS'] ?? 6_000);
const thinkIntervalMs = Number(process.env['AUTOCOSM_DEV_THINK_INTERVAL_MS'] ?? 9_000);

/** Serialise each job with itself, exactly as one-active-execution does in Container Apps. */
function schedule(name, intervalMs, run) {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void run()
      .catch((error) => {
        console.error(`[dev] ${name} failed:`, error instanceof Error ? error.message : error);
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  return timer;
}

const timers = [
  schedule('tick', tickIntervalMs, async () => {
    const result = await runTickOnce(tickConfig, { repository });
    if (result.ticksAdvanced > 0) {
      console.log(
        `[dev] tick → +${String(result.ticksAdvanced)} (now at ${String(result.endTick)})`,
      );
    }
  }),
  schedule('think', thinkIntervalMs, async () => {
    const result = await runThinkOnce(thinkConfig, { repository });
    if (result.claimed > 0) {
      console.log(
        `[dev] think → ${String(result.proposed)}/${String(result.claimed)} proposals (${result.health})`,
      );
    }
  }),
];

console.log(
  `[dev] ticking every ${String(tickIntervalMs)}ms, thinking every ${String(thinkIntervalMs)}ms`,
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const timer of timers) clearInterval(timer);
    void web.close().finally(() => process.exit(0));
  });
}
