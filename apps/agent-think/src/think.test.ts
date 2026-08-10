import { beforeEach, describe, expect, it } from 'vitest';
import {
  ObservationSchema,
  RECORD_VERSION,
  type DecisionRecord,
  type Observation,
} from '@autocosm/domain';
import { Logger, Metrics } from '@autocosm/observability';
import { createRepository, type WorldRepository } from '@autocosm/storage';
import { InvalidConfiguration, loadThinkConfig, type ThinkConfig } from './config.js';
import { runThink } from './main.js';
import { THINKER_QUOTA_ID, dayKeyFor } from './queue.js';

const silent = new Logger({ level: 'error', context: { mode: 'test' } });
const WORLD = 'think-world';

function anObservation(): Observation {
  // Built through the schema so the fixture is provably a shape the simulation could persist.
  return ObservationSchema.parse({
    version: 1,
    worldId: WORLD,
    tick: 10,
    self: {
      organismId: 'organism-1',
      agentId: 'agent-1',
      lineageId: 'lineage-1',
      position: { x: 10, z: 12 },
      regionId: 'region-1',
      energy: 40,
      maxEnergy: 100,
      health: 80,
      maxHealth: 100,
      ageTicks: 30,
      maxAgeTicks: 900,
      mature: true,
      reproductionReady: true,
      generation: 2,
      inventory: [],
      carryCapacity: 240,
      inventorySlotLimit: 8,
      planning: 300,
      manipulation: 250,
      memorySlots: 4,
      speedCuPerTick: 1.2,
      moveCostPer100Cu: 4,
      perceptionRadiusCu: 14,
      signalRadiusCu: 20,
    },
    environment: {
      biome: 'shore',
      lightPerMille: 700,
      temperature: 500,
      waterCoverage: 300,
      biomass: 42,
      pressure: 'none',
      pressureSeverity: 0,
      atPopulationCeiling: false,
    },
    organisms: [],
    resources: [],
    structures: [],
    signals: [],
    memories: [],
    goals: [],
    drives: { survive: 600, forage: 500, reproduce: 300, explore: 400, cooperate: 200, build: 100 },
    temperament: 'balanced',
    aspiration: 'endure',
    knownRecipes: [],
    availableActions: ['move', 'consume', 'rest'],
  });
}

function aDecision(id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    rv: RECORD_VERSION,
    id,
    worldId: WORLD,
    agentId: 'agent-1',
    lineageId: 'lineage-1',
    organismId: 'organism-1',
    regionId: 'region-1',
    createdAtTick: 10,
    expiresAtTick: 400,
    reason: 'discovery',
    status: 'pending',
    observationJson: JSON.stringify(anObservation()),
    attempts: 0,
    ...overrides,
  };
}

function aConfig(overrides: Partial<ThinkConfig> = {}): ThinkConfig {
  return {
    nodeEnv: 'test',
    logLevel: 'error',
    worldId: WORLD,
    storage: { driver: 'memory', isProduction: false },
    provider: {
      kind: 'heuristic',
      azureOpenAiApiVersion: '2024-10-21',
      maxCompletionTokens: 320,
      maxRetries: 1,
      logModelIo: false,
    },
    budget: {
      maxDecisionsPerRun: 12,
      maxDecisionsPerDay: 600,
      minTicksBetweenLineageDecisions: 0,
      perDecisionTimeoutMs: 5_000,
      runBudgetMs: 30_000,
      maxAttemptsPerDecision: 3,
      maxCompletionTokens: 320,
    },
    executionBudgetMs: 30_000,
    ...overrides,
  };
}

async function freshRepository(): Promise<WorldRepository> {
  const repository = createRepository({ driver: 'memory', isProduction: false });
  await repository.initialise();
  return repository;
}

function run(
  repository: WorldRepository,
  config: ThinkConfig,
  holder = 'thinker-a',
): ReturnType<typeof runThink> {
  return runThink({ repository, config, logger: silent, metrics: new Metrics(), holder });
}

describe('think configuration', () => {
  it('refuses azure-openai without an endpoint and deployment', () => {
    expect(() =>
      loadThinkConfig({ AUTOCOSM_DECISION_PROVIDER: 'azure-openai' } as NodeJS.ProcessEnv),
    ).toThrow(InvalidConfiguration);
  });

  it('refuses a non-Azure driver in production', () => {
    expect(() =>
      loadThinkConfig({
        NODE_ENV: 'production',
        AUTOCOSM_STORAGE_DRIVER: 'memory',
      } as NodeJS.ProcessEnv),
    ).toThrow(InvalidConfiguration);
  });

  it('defaults to the heuristic provider so no cloud account is needed', () => {
    const config = loadThinkConfig({} as NodeJS.ProcessEnv);
    expect(config.provider.kind).toBe('heuristic');
    expect(config.storage.driver).toBe('memory');
  });
});

describe('think run', () => {
  let repository: WorldRepository;

  beforeEach(async () => {
    repository = await freshRepository();
  });

  it('exits immediately when nothing is claimable', async () => {
    const result = await run(repository, aConfig());
    expect(result.claimed).toBe(0);
    expect(result.proposed).toBe(0);
    expect(result.health).toBe('healthy');
  });

  it('claims pending decisions and stores proposals', async () => {
    await repository.decisions.putMany([aDecision('d1'), aDecision('d2')]);

    const result = await run(repository, aConfig());

    expect(result.claimed).toBe(2);
    expect(result.proposed).toBe(2);

    const stored = await repository.decisions.get(WORLD, 'd1');
    expect(stored?.value.status).toBe('proposed');
    expect(stored?.value.proposalJson).toBeDefined();
    expect(stored?.value.claimedBy).toBeUndefined();
  });

  it('stores a proposal the tick job can parse and act on', async () => {
    await repository.decisions.putMany([aDecision('d1')]);
    await run(repository, aConfig());

    const proposed = await repository.decisions.listProposed(WORLD, 10);
    expect(proposed.length).toBe(1);
    const parsed = JSON.parse(proposed[0]!.proposalJson!) as { action: { type: string } };
    expect(typeof parsed.action.type).toBe('string');
  });

  it('never exceeds the per-run decision budget', async () => {
    const decisions = Array.from({ length: 10 }, (_, i) => aDecision(`d${i}`));
    await repository.decisions.putMany(decisions);

    const result = await run(
      repository,
      aConfig({ budget: { ...aConfig().budget, maxDecisionsPerRun: 3 } }),
    );

    expect(result.proposed).toBeLessThanOrEqual(3);
    const counts = await repository.decisions.countByStatus(WORLD);
    expect(counts['pending'] ?? 0).toBeGreaterThan(0);
  });

  it('carries daily spend across executions so a restart cannot reset it', async () => {
    await repository.decisions.putMany([aDecision('d1'), aDecision('d2'), aDecision('d3')]);
    const config = aConfig({
      budget: { ...aConfig().budget, maxDecisionsPerRun: 1, maxDecisionsPerDay: 2 },
    });

    const first = await run(repository, config);
    const second = await run(repository, config);
    const third = await run(repository, config);

    expect(first.proposed).toBe(1);
    expect(second.proposed).toBe(1);
    expect(third.claimed).toBe(0);
    expect(third.usedToday).toBe(2);

    const quota = await repository.control.getQuota(WORLD, THINKER_QUOTA_ID, dayKeyFor(Date.now()));
    expect(quota?.value.decisionsRequested).toBe(2);
  });

  it('two concurrent executions never propose for the same decision twice', async () => {
    await repository.decisions.putMany([aDecision('d1'), aDecision('d2')]);

    const [a, b] = await Promise.all([
      run(repository, aConfig(), 'thinker-a'),
      run(repository, aConfig(), 'thinker-b'),
    ]);

    expect(a.claimed + b.claimed).toBe(2);
    const counts = await repository.decisions.countByStatus(WORLD);
    expect(counts['proposed'] ?? 0).toBe(2);
  });

  it('fails a decision whose stored observation is corrupt instead of feeding it to a model', async () => {
    await repository.decisions.putMany([aDecision('bad', { observationJson: '{"nope":true}' })]);

    const result = await run(repository, aConfig());

    expect(result.claimed).toBe(0);
    const stored = await repository.decisions.get(WORLD, 'bad');
    expect(stored?.value.status).toBe('failed');
  });

  it('leaves decisions untouched once the daily budget is spent', async () => {
    const dayKey = dayKeyFor(Date.now());
    await repository.control.putQuota({
      rv: RECORD_VERSION,
      worldId: WORLD,
      creatorId: THINKER_QUOTA_ID,
      dayKey,
      agentsCreated: 0,
      goalsSubmitted: 0,
      decisionsRequested: 600,
    });
    await repository.decisions.putMany([aDecision('d1')]);

    const result = await run(repository, aConfig());

    expect(result.claimed).toBe(0);
    const stored = await repository.decisions.get(WORLD, 'd1');
    expect(stored?.value.status).toBe('pending');
  });

  it('respects the lineage cooldown so one lineage cannot monopolise the budget', async () => {
    await repository.decisions.putMany([
      aDecision('d1', { createdAtTick: 10 }),
      aDecision('d2', { createdAtTick: 11 }),
    ]);

    const result = await run(
      repository,
      aConfig({ budget: { ...aConfig().budget, minTicksBetweenLineageDecisions: 50 } }),
    );

    expect(result.proposed).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
