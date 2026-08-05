import { describe, expect, it, vi } from 'vitest';
import { Logger, Metrics, memorySink, type LogRecord } from '@autocosm/observability';
import { advanceTick, generateWorld, observe } from '@autocosm/simulation';
import type { ActionProposal, Observation, PendingDecision } from '@autocosm/domain';
import { BudgetLedger, DEFAULT_DECISION_BUDGET, DecisionBudgetSchema } from './budget.js';
import { createDecisionProvider, shouldFailClosed } from './factory.js';
import { HeuristicDecisionProvider } from './heuristic-provider.js';
import {
  DecisionProviderError,
  ProposalRejected,
  parseProposal,
  type DecisionProvider,
  type DecisionRequest,
} from './ports.js';
import { MAX_PROMPT_CHARS, SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import { runThinkBatch, type DecisionQueue } from './think-batch.js';
import { AzureOpenAIDecisionProvider, type MinimalChatClient } from './azure-openai-provider.js';

/**
 * The agent runtime is the untrusted-input boundary. These tests exist to prove that no model
 * output can reach the world without passing a shape gate, that budgets are hard limits, and that
 * a configured-but-broken model degrades visibly rather than silently.
 */

function anObservation(): Observation {
  let state = generateWorld({ seed: 5150, worldId: 'w-runtime' });
  for (let i = 0; i < 5; i += 1) state = advanceTick(state).state;
  const organism = [...state.organisms.values()].find((o) => o.alive);
  if (!organism) throw new Error('fixture world has no living organism');
  return observe(state, organism);
}

function aDecision(
  observation: Observation,
  overrides: { [K in keyof PendingDecision]?: unknown } = {},
): PendingDecision {
  return {
    id: 'd-1',
    worldId: observation.worldId,
    agentId: observation.self.agentId,
    lineageId: observation.self.lineageId,
    organismId: observation.self.organismId,
    regionId: observation.self.regionId,
    createdAtTick: observation.tick,
    expiresAtTick: observation.tick + 5,
    reason: 'novelDiscovery',
    status: 'claimed',
    observation,
    attempts: 0,
    ...overrides,
  } as PendingDecision;
}

class RecordingQueue implements DecisionQueue {
  readonly stored: { decisionId: string; proposal: ActionProposal }[] = [];
  readonly released: { decisionId: string; reason: string }[] = [];
  readonly failures: { decisionId: string; reason: string }[] = [];
  #pending: PendingDecision[];

  constructor(pending: readonly PendingDecision[]) {
    this.#pending = [...pending];
  }

  claim(limit: number): Promise<readonly PendingDecision[]> {
    return Promise.resolve(this.#pending.splice(0, limit));
  }

  storeProposal(decision: PendingDecision, proposal: ActionProposal): Promise<void> {
    this.stored.push({ decisionId: decision.id, proposal });
    return Promise.resolve();
  }

  release(decision: PendingDecision, reason: string): Promise<void> {
    this.released.push({ decisionId: decision.id, reason });
    return Promise.resolve();
  }

  fail(decision: PendingDecision, reason: string): Promise<void> {
    this.failures.push({ decisionId: decision.id, reason });
    return Promise.resolve();
  }
}

function harness() {
  const logs: LogRecord[] = [];
  return {
    logs,
    logger: new Logger({ sink: memorySink(logs), level: 'debug', context: { mode: 'test' } }),
    metrics: new Metrics(),
  };
}

describe('proposal parsing', () => {
  const observation = anObservation();

  it('accepts a well-formed proposal for an available action', () => {
    const type = observation.availableActions[0];
    if (type === undefined) throw new Error('fixture observation offers no actions');
    const parsed = parseProposal(
      'test',
      JSON.stringify({ version: 1, action: actionFor(type), rationale: 'move along' }),
      observation,
    );
    expect(parsed.action.type).toBe(type);
    expect(parsed.rationale).toBe('move along');
  });

  it('tolerates a fenced code block and surrounding prose', () => {
    const parsed = parseProposal(
      'test',
      'Sure!\n```json\n{"version":1,"action":{"type":"rest"},"rationale":"conserve"}\n```\nDone.',
      observation,
    );
    expect(parsed.action.type).toBe('rest');
  });

  it('supplies the version when the model omits it', () => {
    const parsed = parseProposal(
      'test',
      '{"action":{"type":"rest"},"rationale":"conserve"}',
      observation,
    );
    expect(parsed.action.type).toBe('rest');
  });

  it('rejects a wrong contract version rather than guessing', () => {
    expect(() =>
      parseProposal('test', '{"version":2,"action":{"type":"rest"},"rationale":"x"}', observation),
    ).toThrow(ProposalRejected);
  });

  it('rejects an action the organism has not evolved the capability for', () => {
    const forbidden = ['repurpose', 'build', 'combine'].find(
      (type) => !observation.availableActions.includes(type),
    );
    expect(forbidden).toBeDefined();
    expect(() =>
      parseProposal(
        'test',
        JSON.stringify({ version: 1, action: actionFor(forbidden!), rationale: 'x' }),
        observation,
      ),
    ).toThrow(/not in availableActions/u);
  });

  it('rejects a rationale that carries hidden reasoning by length', () => {
    expect(() =>
      parseProposal(
        'test',
        JSON.stringify({ version: 1, action: { type: 'rest' }, rationale: 'x'.repeat(400) }),
        observation,
      ),
    ).toThrow(ProposalRejected);
  });

  it('rejects non-JSON output', () => {
    expect(() => parseProposal('test', 'I refuse to answer.', observation)).toThrow(
      ProposalRejected,
    );
  });

  it('rejects an unknown action type', () => {
    expect(() =>
      parseProposal(
        'test',
        '{"version":1,"action":{"type":"ascend"},"rationale":"x"}',
        observation,
      ),
    ).toThrow(ProposalRejected);
  });

  it('rejects an action with an out-of-range payload', () => {
    expect(() =>
      parseProposal(
        'test',
        '{"version":1,"action":{"type":"move","target":{"x":9e9,"z":0}},"rationale":"x"}',
        observation,
      ),
    ).toThrow(ProposalRejected);
  });
});

function actionFor(type: string): Record<string, unknown> {
  switch (type) {
    case 'move':
      return { type, target: { x: 0, z: 0 } };
    case 'consume':
      return { type, resourceNodeId: 'r-1' };
    case 'attack':
      return { type, targetOrganismId: 'o-1' };
    case 'signal':
      return { type, channel: 'food', intensity: 500 };
    case 'attach':
      return { type, structureId: 's-1' };
    case 'share':
      return { type, targetOrganismId: 'o-1', materialId: 'm-1', quantity: 1 };
    case 'reproduce':
      return { type, investment: 500 };
    case 'expressTrait':
      return { type, traitId: 'metabolicEfficiency' };
    case 'collect':
      return { type, resourceNodeId: 'r-1', quantity: 1 };
    case 'combine':
      return { type, components: [{ materialId: 'm-1', quantity: 1 }], label: 'thing' };
    case 'build':
      return { type, pattern: 'shell', components: [{ materialId: 'm-1', quantity: 1 }] };
    case 'inspect':
      return { type, structureId: 's-1' };
    case 'repurpose':
      return { type, structureId: 's-1', pattern: 'shell' };
    default:
      return { type: 'rest' };
  }
}

describe('heuristic provider', () => {
  it('is always available so the world runs without a cloud account', () => {
    expect(new HeuristicDecisionProvider().isAvailable()).toBe(true);
  });

  it('is deterministic for the same decision', async () => {
    const observation = anObservation();
    const provider = new HeuristicDecisionProvider(() => 1_700_000_000_000);
    const request: DecisionRequest = {
      decisionId: 'd-42',
      observation,
      reason: 'novelDiscovery',
      timeoutMs: 1_000,
    };
    const a = await provider.propose(request);
    const b = await provider.propose(request);
    expect(a.action).toEqual(b.action);
    expect(a.provider).toBe('heuristic');
  });

  it('only ever proposes actions the organism can attempt', async () => {
    const observation = anObservation();
    const provider = new HeuristicDecisionProvider();
    for (let i = 0; i < 25; i += 1) {
      const proposal = await provider.propose({
        decisionId: `d-${i}`,
        observation,
        reason: 'novelDiscovery',
        timeoutMs: 1_000,
      });
      expect(observation.availableActions).toContain(proposal.action.type);
    }
  });
});

describe('prompt construction', () => {
  const observation = anObservation();

  it('never leaks world-wide state or storage topology', () => {
    const prompt = buildUserPrompt(observation, 'novelDiscovery');
    for (const forbidden of [
      'core.windows.net',
      'PartitionKey',
      'RowKey',
      'connectionString',
      'AccountKey',
      'worldId',
      'seed',
    ]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it('stays inside the prompt budget', () => {
    expect(buildUserPrompt(observation, 'novelDiscovery').length).toBeLessThanOrEqual(
      MAX_PROMPT_CHARS,
    );
  });

  it('tells the model it is not the authority', () => {
    expect(SYSTEM_PROMPT).toContain('You do not control the world');
    expect(SYSTEM_PROMPT).toContain('availableActions');
  });
});

describe('decision budget', () => {
  it('defaults to affordable limits', () => {
    expect(DEFAULT_DECISION_BUDGET.maxDecisionsPerRun).toBeLessThanOrEqual(50);
    expect(DEFAULT_DECISION_BUDGET.maxDecisionsPerDay).toBeLessThanOrEqual(5_000);
  });

  it('refuses once the per-run limit is reached', () => {
    const budget = DecisionBudgetSchema.parse({ maxDecisionsPerRun: 2 });
    const ledger = new BudgetLedger(budget);
    ledger.consume('l-a', 1);
    ledger.consume('l-b', 1);
    expect(ledger.refusalFor('l-c', 1)).toBe('runLimit');
    expect(ledger.exhausted()).toBe(true);
  });

  it('refuses once the daily limit is reached, across executions', () => {
    const budget = DecisionBudgetSchema.parse({ maxDecisionsPerDay: 5 });
    const ledger = new BudgetLedger(budget, { usedToday: 5 });
    expect(ledger.refusalFor('l-a', 1)).toBe('dailyLimit');
  });

  it('enforces a per-lineage cooldown so one lineage cannot monopolise the budget', () => {
    const budget = DecisionBudgetSchema.parse({ minTicksBetweenLineageDecisions: 10 });
    const ledger = new BudgetLedger(budget, { lastDecisionTickByLineage: new Map([['l-a', 100]]) });
    expect(ledger.refusalFor('l-a', 105)).toBe('lineageCooldown');
    expect(ledger.refusalFor('l-a', 110)).toBeUndefined();
    expect(ledger.refusalFor('l-b', 105)).toBeUndefined();
  });

  it('refuses once the wall-clock budget is spent', () => {
    let now = 0;
    const budget = DecisionBudgetSchema.parse({ runBudgetMs: 5_000 });
    const ledger = new BudgetLedger(budget, { now: () => now });
    expect(ledger.refusalFor('l-a', 1)).toBeUndefined();
    now = 6_000;
    expect(ledger.refusalFor('l-a', 1)).toBe('timeBudget');
  });
});

describe('think batch', () => {
  it('proposes for every claimable decision within budget', async () => {
    const observation = anObservation();
    const queue = new RecordingQueue([
      aDecision(observation, { id: 'd-1' }),
      aDecision(observation, { id: 'd-2', lineageId: 'l-other' as PendingDecision['lineageId'] }),
    ]);
    const { logger, metrics } = harness();

    const result = await runThinkBatch({
      queue,
      provider: new HeuristicDecisionProvider(),
      budget: DecisionBudgetSchema.parse({ minTicksBetweenLineageDecisions: 0 }),
      holder: 'test-run',
      logger,
      metrics,
      failClosed: false,
    });

    expect(result.proposed).toBe(2);
    expect(queue.stored).toHaveLength(2);
    expect(metrics.snapshot().counters['model.calls']).toBe(2);
  });

  it('stops claiming once the per-run budget is exhausted', async () => {
    const observation = anObservation();
    const decisions = Array.from({ length: 10 }, (_, i) =>
      aDecision(observation, {
        id: `d-${i}`,
        lineageId: `l-${i}` as PendingDecision['lineageId'],
      }),
    );
    const queue = new RecordingQueue(decisions);
    const { logger, metrics } = harness();

    const result = await runThinkBatch({
      queue,
      provider: new HeuristicDecisionProvider(),
      budget: DecisionBudgetSchema.parse({ maxDecisionsPerRun: 3 }),
      holder: 'test-run',
      logger,
      metrics,
      failClosed: false,
    });

    expect(result.proposed).toBe(3);
    expect(queue.stored).toHaveLength(3);
  });

  it('exits immediately when nothing is claimable, so the job costs nothing', async () => {
    const queue = new RecordingQueue([]);
    const { logger, metrics } = harness();
    const result = await runThinkBatch({
      queue,
      provider: new HeuristicDecisionProvider(),
      budget: DEFAULT_DECISION_BUDGET,
      holder: 'test-run',
      logger,
      metrics,
      failClosed: false,
    });
    expect(result).toMatchObject({ claimed: 0, proposed: 0, health: 'healthy' });
  });

  it('releases a decision for retry when the model output is malformed', async () => {
    const observation = anObservation();
    const queue = new RecordingQueue([aDecision(observation)]);
    const { logger, metrics } = harness();
    const provider: DecisionProvider = {
      name: 'broken',
      isAvailable: () => true,
      propose: () => Promise.reject(new ProposalRejected('broken', 'not JSON')),
    };

    const result = await runThinkBatch({
      queue,
      provider,
      budget: DecisionBudgetSchema.parse({ maxAttemptsPerDecision: 3 }),
      holder: 'test-run',
      logger,
      metrics,
      failClosed: false,
    });

    expect(result.released).toBe(1);
    expect(queue.released[0]?.reason).toContain('not JSON');
    expect(metrics.snapshot().counters['proposals.invalid']).toBe(1);
  });

  it('gives up on a decision that has exhausted its attempts', async () => {
    const observation = anObservation();
    const queue = new RecordingQueue([aDecision(observation, { attempts: 2 })]);
    const { logger, metrics } = harness();
    const provider: DecisionProvider = {
      name: 'broken',
      isAvailable: () => true,
      propose: () => Promise.reject(new ProposalRejected('broken', 'not JSON')),
    };

    const result = await runThinkBatch({
      queue,
      provider,
      budget: DecisionBudgetSchema.parse({ maxAttemptsPerDecision: 3 }),
      holder: 'test-run',
      logger,
      metrics,
      failClosed: false,
    });

    expect(result.failed).toBe(1);
    expect(queue.failures).toHaveLength(1);
  });

  it('reports a degraded state instead of silently falling back when fail-closed', async () => {
    const observation = anObservation();
    const queue = new RecordingQueue([
      aDecision(observation),
      aDecision(observation, { id: 'd-2' }),
    ]);
    const { logger, metrics } = harness();
    const provider: DecisionProvider = {
      name: 'azure-openai',
      isAvailable: () => true,
      propose: () => Promise.reject(new DecisionProviderError('azure-openai', 'gateway', true)),
    };

    const result = await runThinkBatch({
      queue,
      provider,
      budget: DEFAULT_DECISION_BUDGET,
      holder: 'test-run',
      logger,
      metrics,
      failClosed: true,
    });

    expect(result.health).toBe('degraded');
    expect(result.degradedReason).toContain('gateway');
    expect(queue.stored).toHaveLength(0);
  });

  it('reports degraded when the provider is unavailable', async () => {
    const { logger, metrics } = harness();
    const result = await runThinkBatch({
      queue: new RecordingQueue([]),
      provider: {
        name: 'off',
        isAvailable: () => false,
        propose: () => Promise.reject(new Error()),
      },
      budget: DEFAULT_DECISION_BUDGET,
      holder: 'test-run',
      logger,
      metrics,
      failClosed: true,
    });
    expect(result.health).toBe('degraded');
  });
});

describe('provider factory', () => {
  it('defaults to the deterministic provider', () => {
    const provider = createDecisionProvider({
      kind: 'heuristic',
      azureOpenAiApiVersion: '2024-10-21',
      maxCompletionTokens: 320,
      maxRetries: 1,
    });
    expect(provider.name).toBe('heuristic');
    expect(shouldFailClosed({ kind: 'heuristic' } as never)).toBe(false);
  });

  it('fails loudly when azure-openai is selected without configuration', () => {
    expect(() =>
      createDecisionProvider({
        kind: 'azure-openai',
        azureOpenAiApiVersion: '2024-10-21',
        maxCompletionTokens: 320,
        maxRetries: 1,
      }),
    ).toThrow(/requires AZURE_OPENAI_ENDPOINT/u);
  });
});

describe('azure openai provider', () => {
  const observation = anObservation();

  function providerWith(client: MinimalChatClient) {
    return new AzureOpenAIDecisionProvider({
      endpoint: 'https://example.openai.azure.com',
      deployment: 'gpt-test',
      apiVersion: '2024-10-21',
      maxCompletionTokens: 200,
      maxRetries: 0,
      client,
      now: () => 1_700_000_000_000,
    });
  }

  it('refuses an endpoint that embeds a credential', () => {
    expect(
      () =>
        new AzureOpenAIDecisionProvider({
          endpoint: 'https://example.openai.azure.com?sig=abc',
          deployment: 'gpt-test',
          apiVersion: '2024-10-21',
          maxCompletionTokens: 200,
          maxRetries: 0,
        }),
    ).toThrow(/must not embed credentials/u);
  });

  it('validates model output before it can reach the world', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: '{"version":1,"action":{"type":"rest"},"rationale":"ok"}' } },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const proposal = await providerWith({ chat: { completions: { create } } }).propose({
      decisionId: 'd-1',
      observation,
      reason: 'novelDiscovery',
      timeoutMs: 5_000,
    });

    expect(proposal.action.type).toBe('rest');
    expect(proposal.promptTokens).toBe(100);
    expect(proposal.model).toBe('gpt-test');
    const body = create.mock.calls[0]?.[0] as { max_completion_tokens: number };
    expect(body.max_completion_tokens).toBe(200);
  });

  it('rejects an action the model invented', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: '{"version":1,"action":{"type":"smite"},"rationale":"x"}' } },
      ],
    });
    await expect(
      providerWith({ chat: { completions: { create } } }).propose({
        decisionId: 'd-1',
        observation,
        reason: 'novelDiscovery',
        timeoutMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(ProposalRejected);
  });

  it('surfaces an empty completion as a retryable provider error', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: '' } }] });
    await expect(
      providerWith({ chat: { completions: { create } } }).propose({
        decisionId: 'd-1',
        observation,
        reason: 'novelDiscovery',
        timeoutMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(DecisionProviderError);
  });

  it('classifies a 400 as non-retryable configuration failure', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    await expect(
      providerWith({ chat: { completions: { create } } }).propose({
        decisionId: 'd-1',
        observation,
        reason: 'novelDiscovery',
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
