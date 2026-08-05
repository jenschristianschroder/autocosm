import { beforeEach, describe, expect, it } from 'vitest';
import { RECORD_VERSION } from '@autocosm/domain';
import { Logger, Metrics } from '@autocosm/observability';
import { fromRecords } from '@autocosm/simulation';
import { createRepository, loadWorldBundle, type WorldRepository } from '@autocosm/storage';
import { InvalidConfiguration, loadTickConfig, type TickConfig } from './config.js';
import { TICK_LEASE, TICK_WATERMARK, runTick } from './run.js';

const silent = new Logger({ level: 'error', context: { mode: 'test' } });

function aConfig(overrides: Partial<TickConfig> = {}): TickConfig {
  return {
    nodeEnv: 'test',
    logLevel: 'error',
    worldId: 'tick-world',
    worldSeed: 90210,
    storage: { driver: 'memory', isProduction: false },
    ticksPerMinute: 4,
    maxTicksPerRun: 5,
    executionBudgetMs: 30_000,
    leaseTtlMs: 90_000,
    eventRetentionTicks: 20_000,
    maxEventsCompactedPerRun: 100,
    seedIfMissing: true,
    ...overrides,
  };
}

async function freshRepository(): Promise<WorldRepository> {
  const repository = createRepository({ driver: 'memory', isProduction: false });
  await repository.initialise();
  return repository;
}

interface RunOptions {
  readonly holder?: string;
  readonly now?: () => number;
}

async function run(
  repository: WorldRepository,
  config: TickConfig,
  options: RunOptions = {},
): Promise<ReturnType<typeof runTick>> {
  return runTick({
    repository,
    config,
    logger: silent,
    metrics: new Metrics(),
    holder: options.holder ?? 'runner-a',
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

describe('tick configuration', () => {
  it('refuses a lease shorter than the execution budget', () => {
    expect(() =>
      loadTickConfig({
        AUTOCOSM_TICK_BUDGET_MS: '60000',
        AUTOCOSM_TICK_LEASE_MS: '30000',
      } as NodeJS.ProcessEnv),
    ).toThrow(InvalidConfiguration);
  });

  it('refuses a non-Azure driver in production', () => {
    expect(() =>
      loadTickConfig({
        NODE_ENV: 'production',
        AUTOCOSM_STORAGE_DRIVER: 'memory',
      } as NodeJS.ProcessEnv),
    ).toThrow(InvalidConfiguration);
  });

  it('defaults to a local memory driver', () => {
    const config = loadTickConfig({} as NodeJS.ProcessEnv);
    expect(config.storage.driver).toBe('memory');
    expect(config.leaseTtlMs).toBeGreaterThan(config.executionBudgetMs);
  });
});

describe('tick run', () => {
  let repository: WorldRepository;

  beforeEach(async () => {
    repository = await freshRepository();
  });

  it('seeds an absent world and does not advance it in the same run', async () => {
    const result = await run(repository, aConfig());

    expect(result.outcome).toBe('seeded');
    expect(result.ticksAdvanced).toBe(0);

    const bundle = await loadWorldBundle(repository, 'tick-world');
    expect(bundle).toBeDefined();
    expect(bundle?.lineages.length).toBe(8);
    expect(bundle?.organisms.length).toBeGreaterThan(0);
  });

  it('refuses to seed when seeding is disabled', async () => {
    const result = await run(repository, aConfig({ seedIfMissing: false }));
    expect(result.outcome).toBe('upToDate');
    expect(await loadWorldBundle(repository, 'tick-world')).toBeUndefined();
  });

  it('advances the world and records events', async () => {
    await run(repository, aConfig());
    const result = await run(repository, aConfig({ maxTicksPerRun: 3 }));

    expect(result.outcome).toBe('advanced');
    expect(result.ticksAdvanced).toBeGreaterThan(0);
    expect(result.endTick).toBe(result.startTick + result.ticksAdvanced);
    expect(result.eventsWritten).toBeGreaterThan(0);
  });

  it('never advances further than maxTicksPerRun however far behind it is', async () => {
    await run(repository, aConfig());
    const start = Date.now();
    // Pretend an hour has elapsed since the watermark: the world owes 240 ticks.
    const result = await run(repository, aConfig({ maxTicksPerRun: 4 }), {
      now: () => start + 3_600_000,
    });

    expect(result.ticksAdvanced).toBe(4);
    expect(result.lagTicks).toBeGreaterThan(200);
  });

  it('stops at the execution budget and leaves the rest for the next run', async () => {
    await run(repository, aConfig());
    let clock = Date.now();
    const result = await run(
      repository,
      aConfig({ maxTicksPerRun: 50, executionBudgetMs: 2_000 }),
      {
        // Every reading of the clock advances it, so the budget is spent after a few ticks.
        now: () => {
          clock += 100;
          return clock;
        },
      },
    );

    expect(result.ticksAdvanced).toBeGreaterThan(0);
    expect(result.ticksAdvanced).toBeLessThan(50);
  });

  it('exits without advancing when another execution holds the lease', async () => {
    await run(repository, aConfig());
    const before = await loadWorldBundle(repository, 'tick-world');

    const held = await repository.control.acquireLease({
      worldId: 'tick-world',
      name: TICK_LEASE,
      holder: 'other-runner',
      nowEpochMs: Date.now(),
      ttlMs: 60_000,
    });
    expect(held).toBeDefined();

    const result = await run(repository, aConfig(), { holder: 'runner-b' });
    expect(result.outcome).toBe('skippedLeaseHeld');
    expect(result.ticksAdvanced).toBe(0);

    const after = await loadWorldBundle(repository, 'tick-world');
    expect(after?.world.tick).toBe(before?.world.tick);
  });

  it('releases the lease so the next run can proceed', async () => {
    await run(repository, aConfig());
    const first = await run(repository, aConfig({ maxTicksPerRun: 1 }));
    const second = await run(repository, aConfig({ maxTicksPerRun: 1 }));

    expect(first.ticksAdvanced).toBe(1);
    expect(second.ticksAdvanced).toBe(1);
    expect(second.startTick).toBe(first.endTick);
  });

  it('advances the watermark to the committed tick', async () => {
    await run(repository, aConfig());
    const result = await run(repository, aConfig({ maxTicksPerRun: 2 }));

    const watermark = await repository.control.getWatermark('tick-world', TICK_WATERMARK);
    expect(watermark?.value.tick).toBe(result.endTick);

    const bundle = await loadWorldBundle(repository, 'tick-world');
    expect(bundle?.world.tick).toBe(watermark?.value.tick);
  });

  it('is deterministic: the same seed produces the same world after the same ticks', async () => {
    const other = await freshRepository();
    const config = aConfig({ maxTicksPerRun: 6 });

    await run(repository, config);
    await run(repository, config);
    await run(other, config);
    await run(other, config);

    const a = await loadWorldBundle(repository, 'tick-world');
    const b = await loadWorldBundle(other, 'tick-world');
    expect(a?.world.tick).toBe(b?.world.tick);
    expect(JSON.stringify(a?.organisms)).toBe(JSON.stringify(b?.organisms));
    expect(JSON.stringify(a?.lineages)).toBe(JSON.stringify(b?.lineages));
  });

  it('does not double-append events when a tick is replayed', async () => {
    await run(repository, aConfig());
    const before = await loadWorldBundle(repository, 'tick-world');
    const state = fromRecords(before!);

    const first = await run(repository, aConfig({ maxTicksPerRun: 2 }));
    const afterFirst = await repository.events.query({ worldId: 'tick-world' });

    // Rewind the stored world and replay the identical ticks.
    const worldRow = await repository.worlds.get('tick-world');
    await repository.worlds.put({ ...worldRow!.value, tick: state.world.tick }, worldRow!.etag);

    const replay = await run(repository, aConfig({ maxTicksPerRun: 2 }));
    const afterReplay = await repository.events.query({ worldId: 'tick-world' });

    expect(replay.eventsWritten).toBe(0);
    expect(afterReplay.items.length).toBe(afterFirst.items.length);
    expect(first.eventsWritten).toBeGreaterThan(0);
  });

  it('expires stale decision claims during housekeeping', async () => {
    await run(repository, aConfig());
    const now = Date.now();
    await repository.decisions.putMany([
      {
        rv: RECORD_VERSION,
        id: 'decision-stale',
        worldId: 'tick-world',
        agentId: 'agent-1',
        lineageId: 'lineage-1',
        organismId: 'organism-1',
        regionId: 'region-1',
        createdAtTick: 0,
        expiresAtTick: 10_000,
        reason: 'test',
        status: 'claimed',
        observationJson: '{}',
        claimedBy: 'ghost',
        claimExpiresAtEpochMs: now - 60_000,
        attempts: 1,
      },
    ]);

    await run(repository, aConfig({ maxTicksPerRun: 1 }));

    const stored = await repository.decisions.get('tick-world', 'decision-stale');
    expect(stored?.value.status).toBe('pending');
    expect(stored?.value.claimedBy).toBeUndefined();
  });

  it('never writes a watermark ahead of the persisted world', async () => {
    await run(repository, aConfig());
    for (let i = 0; i < 3; i += 1) await run(repository, aConfig({ maxTicksPerRun: 2 }));

    const watermark = await repository.control.getWatermark('tick-world', TICK_WATERMARK);
    const bundle = await loadWorldBundle(repository, 'tick-world');
    expect(watermark!.value.tick).toBeLessThanOrEqual(bundle!.world.tick);
  });
});
