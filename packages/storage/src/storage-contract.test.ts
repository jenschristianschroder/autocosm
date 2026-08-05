import {
  StoredRecordInvalid,
  TRAIT_IDS,
  type AgentRecord,
  type DecisionRecord,
  type GoalRecord,
  type OrganismRecord,
  type StoredWorldEvent,
  type WorldRecord,
} from '@autocosm/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { InsecureStorageConfiguration, assertProductionSafeStorage } from './guardrails.js';
import { EVENT_EPOCH_TICKS, InMemoryWorldRepository, eventEpochOf } from './memory-repository.js';
import { ConcurrencyConflict, boundedLimit, type WorldRepository } from './ports.js';

/**
 * Storage contract tests.
 *
 * These assert behaviour that both adapters must share: optimistic concurrency, claim expiry,
 * idempotent event append, bounded paging, and validation on read as well as write. The Azure
 * adapter cannot be exercised here without a live account or Azurite, so the suite is written
 * against the `WorldRepository` port and parameterised over available adapters — adding an
 * Azurite-backed factory later requires no test changes.
 */

const WORLD_ID = 'world-alpha';

function world(overrides: Partial<WorldRecord> = {}): WorldRecord {
  return {
    rv: 1,
    id: WORLD_ID,
    name: 'Alpha',
    seed: 42,
    tick: 0,
    createdAtTick: 0,
    calendar: { ticksPerDay: 240, ticksPerPressureCycle: 480, simulatedMinutesPerTick: 6 },
    pressure: { kind: 'calm', startedAtTick: 0, endsAtTick: 480, severity: 0 },
    stats: {
      livingOrganisms: 0,
      activeLineages: 0,
      extinctLineages: 0,
      structures: 0,
      discoveredMaterials: 0,
      totalBirths: 0,
      totalDeaths: 0,
    },
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    rv: 1,
    id,
    worldId: WORLD_ID,
    lineageId: `ln-${id}`,
    name: 'Test agent',
    createdByCreatorId: 'creator-1',
    createdAtTick: 0,
    status: 'active',
    drives: {
      survive: 500,
      forage: 500,
      reproduce: 500,
      explore: 500,
      cooperate: 500,
      build: 500,
    },
    temperament: 'balanced',
    habitat: 'shallows',
    aspiration: 'endure',
    knowledge: { knownMaterialIds: [], recipes: [], knownStructureIds: [] },
    lastDecisionTick: 0,
    decisionCount: 0,
    visualSeed: 7,
    ...overrides,
  };
}

/** A schema-valid genotype: every trait at the neutral midpoint. */
const TEST_GENOTYPE = Object.fromEntries(
  TRAIT_IDS.map((id) => [id, 500]),
) as OrganismRecord['genotype'];

function organism(
  id: string,
  regionId: string,
  overrides: Partial<OrganismRecord> = {},
): OrganismRecord {
  return {
    rv: 1,
    id,
    worldId: WORLD_ID,
    agentId: 'ag-1',
    lineageId: 'ln-1',
    regionId,
    position: { x: 10, z: 20 },
    genotype: TEST_GENOTYPE,
    lifetime: { emphasis: {}, successes: {}, failures: {} },
    energy: 100,
    health: 100,
    ageTicks: 0,
    bornAtTick: 0,
    generation: 0,
    inventory: [],
    reproductionReadyTick: 0,
    alive: true,
    ...overrides,
  };
}

function decision(id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    rv: 1,
    id,
    worldId: WORLD_ID,
    agentId: 'ag-1',
    lineageId: 'ln-1',
    organismId: 'or-1',
    regionId: 'r0x0',
    createdAtTick: 5,
    expiresAtTick: 50,
    reason: 'discovery',
    status: 'pending',
    observationJson: '{}',
    attempts: 0,
    ...overrides,
  };
}

function goal(id: string, overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    rv: 1,
    id,
    worldId: WORLD_ID,
    agentId: 'ag-1',
    text: 'seek the ocean',
    submittedByCreatorId: 'creator-1',
    submittedAtTick: 3,
    status: 'pending',
    ...overrides,
  };
}

function event(
  id: string,
  tick: number,
  overrides: Partial<StoredWorldEvent> = {},
): StoredWorldEvent {
  return {
    id,
    version: 1,
    worldId: WORLD_ID,
    regionId: 'r0x0',
    tick,
    ordinal: 0,
    kind: 'organismBorn',
    summary: 'a cell divided',
    payload: {},
    ...overrides,
  };
}

/** A schema-valid genotype is defined above; adapters under test are listed here. */
interface Adapter {
  readonly name: string;
  readonly create: () => WorldRepository;
}

const adapters: readonly Adapter[] = [
  { name: 'in-memory', create: () => new InMemoryWorldRepository() },
];

describe.each(adapters)('$name storage contract', ({ create }) => {
  let repo: WorldRepository;

  beforeEach(async () => {
    repo = create();
    await repo.initialise();
    await repo.worlds.put(world());
  });

  it('answers a liveness probe', async () => {
    await expect(repo.ping()).resolves.toBeUndefined();
  });

  it('round-trips a world and returns an etag', async () => {
    const found = await repo.worlds.get(WORLD_ID);
    expect(found?.value.name).toBe('Alpha');
    expect(found?.etag).toBeTruthy();
  });

  it('rejects a blind overwrite of an existing record', async () => {
    await expect(repo.worlds.put(world({ tick: 5 }))).rejects.toBeInstanceOf(ConcurrencyConflict);
  });

  it('rejects a conditional write with a stale etag', async () => {
    const first = await repo.worlds.get(WORLD_ID);
    expect(first).toBeDefined();
    const staleEtag = first!.etag;
    await repo.worlds.put({ ...first!.value, tick: 1 }, staleEtag);
    await expect(repo.worlds.put({ ...first!.value, tick: 2 }, staleEtag)).rejects.toBeInstanceOf(
      ConcurrencyConflict,
    );
  });

  it('accepts a conditional write with a fresh etag', async () => {
    const first = await repo.worlds.get(WORLD_ID);
    const nextEtag = await repo.worlds.put({ ...first!.value, tick: 1 }, first!.etag);
    expect(nextEtag).not.toBe(first!.etag);
    const reread = await repo.worlds.get(WORLD_ID);
    expect(reread?.value.tick).toBe(1);
  });

  it('validates records on write', async () => {
    // `seed` must be an integer; a float is a programming error, not something to coerce.
    await expect(repo.agents.put(agent('ag-bad', { name: '' }))).rejects.toThrow();
  });

  it('pages agents with a bounded limit and continuation', async () => {
    await repo.agents.putMany(
      Array.from({ length: 25 }, (_, i) => agent(`ag-${String(i).padStart(3, '0')}`)),
    );
    const first = await repo.agents.listByWorld(WORLD_ID, { limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.continuation).toBeDefined();

    const second = await repo.agents.listByWorld(WORLD_ID, {
      limit: 10,
      continuation: first.continuation!,
    });
    expect(second.items).toHaveLength(10);
    const overlap = new Set(first.items.map((a) => a.id));
    expect(second.items.some((a) => overlap.has(a.id))).toBe(false);

    const third = await repo.agents.listByWorld(WORLD_ID, {
      limit: 10,
      continuation: second.continuation!,
    });
    expect(third.items).toHaveLength(5);
    expect(third.continuation).toBeUndefined();
  });

  it('never returns more than the maximum page size', async () => {
    await repo.agents.putMany(
      Array.from({ length: 12 }, (_, i) => agent(`ag-${String(i).padStart(3, '0')}`)),
    );
    const page = await repo.agents.listByWorld(WORLD_ID, { limit: 10_000 });
    expect(page.items.length).toBeLessThanOrEqual(boundedLimit(10_000));
  });

  it('keeps organism queries bounded by region', async () => {
    await repo.organisms.putMany([
      organism('or-a', 'r0x0'),
      organism('or-b', 'r0x0'),
      organism('or-c', 'r1x1'),
    ]);
    const here = await repo.organisms.listByRegion(WORLD_ID, 'r0x0');
    expect(here.items.map((o) => o.id).sort()).toEqual(['or-a', 'or-b']);

    const all = await repo.organisms.listByWorld(WORLD_ID);
    expect(all.items).toHaveLength(3);
  });

  it('deletes organisms by region key', async () => {
    await repo.organisms.putMany([organism('or-a', 'r0x0'), organism('or-b', 'r0x0')]);
    await repo.organisms.deleteMany(WORLD_ID, [{ regionId: 'r0x0', organismId: 'or-a' }]);
    const remaining = await repo.organisms.listByRegion(WORLD_ID, 'r0x0');
    expect(remaining.items.map((o) => o.id)).toEqual(['or-b']);
  });

  it('finds an organism by id across regions', async () => {
    await repo.organisms.putMany([organism('or-a', 'r0x0'), organism('or-c', 'r1x1')]);
    const found = await repo.organisms.get(WORLD_ID, 'or-c');
    expect(found?.regionId).toBe('r1x1');
  });

  it('appends events idempotently', async () => {
    const batch = [event('e-1', 1), event('e-2', 2)];
    const first = await repo.events.append(batch);
    expect(first).toEqual({ written: 2, skipped: 0 });

    // A retried tick execution replays the identical batch; nothing may be duplicated.
    const replay = await repo.events.append([...batch, event('e-3', 3)]);
    expect(replay).toEqual({ written: 1, skipped: 2 });

    const all = await repo.events.query({ worldId: WORLD_ID });
    expect(all.items).toHaveLength(3);
  });

  it('returns events newest first and filters by tick window and region', async () => {
    await repo.events.append([
      event('e-1', 1),
      event('e-2', 5),
      event('e-3', 9, { regionId: 'r2x2' }),
    ]);

    const recent = await repo.events.query({ worldId: WORLD_ID });
    expect(recent.items.map((e) => e.tick)).toEqual([9, 5, 1]);

    const window = await repo.events.query({ worldId: WORLD_ID, sinceTick: 4, untilTick: 6 });
    expect(window.items.map((e) => e.id)).toEqual(['e-2']);

    const byRegion = await repo.events.query({ worldId: WORLD_ID, regionId: 'r2x2' });
    expect(byRegion.items.map((e) => e.id)).toEqual(['e-3']);
  });

  it('spreads events across epoch partitions', async () => {
    expect(eventEpochOf(0)).toBe(0);
    expect(eventEpochOf(EVENT_EPOCH_TICKS)).toBe(1);
    await repo.events.append([event('e-early', 1), event('e-late', EVENT_EPOCH_TICKS + 1)]);
    const all = await repo.events.query({ worldId: WORLD_ID });
    expect(all.items.map((e) => e.id)).toEqual(['e-late', 'e-early']);
  });

  it('compacts old events within a bounded budget', async () => {
    await repo.events.append(Array.from({ length: 10 }, (_, i) => event(`e-${i}`, i)));
    const removed = await repo.events.compact(WORLD_ID, 5, 3);
    expect(removed).toBe(3);
    const rest = await repo.events.query({ worldId: WORLD_ID });
    expect(rest.items).toHaveLength(7);
  });

  it('rejects a stored record that no longer satisfies its schema', async () => {
    await repo.events.append([event('e-ok', 1)]);
    // Simulate corruption by writing through the adapter's own validation-free path.
    const corrupt = new InMemoryWorldRepository();
    await corrupt.initialise();
    await expect(
      corrupt.events.append([event('e-bad', 1, { summary: 'x'.repeat(10_000) })]),
    ).rejects.toThrow();
  });

  it('claims pending decisions exactly once per holder', async () => {
    await repo.decisions.putMany([decision('d-1'), decision('d-2'), decision('d-3')]);
    const now = 1_000_000;

    const first = await repo.decisions.claimPending({
      worldId: WORLD_ID,
      holder: 'think-a',
      limit: 2,
      nowEpochMs: now,
      claimTtlMs: 30_000,
    });
    expect(first).toHaveLength(2);
    expect(first.every((c) => c.record.claimedBy === 'think-a')).toBe(true);
    expect(first.every((c) => c.record.attempts === 1)).toBe(true);

    const second = await repo.decisions.claimPending({
      worldId: WORLD_ID,
      holder: 'think-b',
      limit: 5,
      nowEpochMs: now,
      claimTtlMs: 30_000,
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.record.id).toBe('d-3');

    const third = await repo.decisions.claimPending({
      worldId: WORLD_ID,
      holder: 'think-c',
      limit: 5,
      nowEpochMs: now,
      claimTtlMs: 30_000,
    });
    expect(third).toHaveLength(0);
  });

  it('re-claims a decision whose claim has expired', async () => {
    await repo.decisions.putMany([decision('d-1')]);
    await repo.decisions.claimPending({
      worldId: WORLD_ID,
      holder: 'think-a',
      limit: 1,
      nowEpochMs: 1_000,
      claimTtlMs: 5_000,
    });

    const tooSoon = await repo.decisions.claimPending({
      worldId: WORLD_ID,
      holder: 'think-b',
      limit: 1,
      nowEpochMs: 4_000,
      claimTtlMs: 5_000,
    });
    expect(tooSoon).toHaveLength(0);

    const afterExpiry = await repo.decisions.claimPending({
      worldId: WORLD_ID,
      holder: 'think-b',
      limit: 1,
      nowEpochMs: 10_000,
      claimTtlMs: 5_000,
    });
    expect(afterExpiry).toHaveLength(1);
    expect(afterExpiry[0]?.record.attempts).toBe(2);
  });

  it('releases stale claims back to pending', async () => {
    await repo.decisions.putMany([decision('d-1'), decision('d-2')]);
    await repo.decisions.claimPending({
      worldId: WORLD_ID,
      holder: 'think-a',
      limit: 2,
      nowEpochMs: 1_000,
      claimTtlMs: 1_000,
    });
    expect(await repo.decisions.countByStatus(WORLD_ID)).toEqual({ claimed: 2 });

    const released = await repo.decisions.expireStaleClaims(WORLD_ID, 5_000, 10);
    expect(released).toBe(2);
    const counts = await repo.decisions.countByStatus(WORLD_ID);
    expect(counts).toEqual({ pending: 2 });

    const reread = await repo.decisions.get(WORLD_ID, 'd-1');
    expect(reread?.value.claimedBy).toBeUndefined();
  });

  it('lists proposed decisions for the tick job', async () => {
    await repo.decisions.putMany([
      decision('d-1', { status: 'proposed', proposalJson: '{"kind":"move"}' }),
      decision('d-2'),
    ]);
    const proposed = await repo.decisions.listProposed(WORLD_ID, 10);
    expect(proposed.map((d) => d.id)).toEqual(['d-1']);
  });

  it('stores and advances a watermark under optimistic concurrency', async () => {
    const etag = await repo.control.putWatermark({
      rv: 1,
      worldId: WORLD_ID,
      name: 'tick',
      tick: 10,
      updatedAtIso: '2024-01-01T00:00:00.000Z',
    });
    const current = await repo.control.getWatermark(WORLD_ID, 'tick');
    expect(current?.value.tick).toBe(10);
    expect(current?.etag).toBe(etag);

    await expect(
      repo.control.putWatermark(
        {
          rv: 1,
          worldId: WORLD_ID,
          name: 'tick',
          tick: 11,
          updatedAtIso: '2024-01-01T00:01:00.000Z',
        },
        'W/"stale"',
      ),
    ).rejects.toBeInstanceOf(ConcurrencyConflict);
  });

  it('grants a lease to one holder and blocks another until expiry', async () => {
    const held = await repo.control.acquireLease({
      worldId: WORLD_ID,
      name: 'tick',
      holder: 'exec-1',
      nowEpochMs: 1_000,
      ttlMs: 10_000,
    });
    expect(held?.holder).toBe('exec-1');

    const blocked = await repo.control.acquireLease({
      worldId: WORLD_ID,
      name: 'tick',
      holder: 'exec-2',
      nowEpochMs: 2_000,
      ttlMs: 10_000,
    });
    expect(blocked).toBeUndefined();

    // The holder may always renew its own lease.
    const renewed = await repo.control.acquireLease({
      worldId: WORLD_ID,
      name: 'tick',
      holder: 'exec-1',
      nowEpochMs: 3_000,
      ttlMs: 10_000,
    });
    expect(renewed?.expiresAtEpochMs).toBe(13_000);

    const afterExpiry = await repo.control.acquireLease({
      worldId: WORLD_ID,
      name: 'tick',
      holder: 'exec-2',
      nowEpochMs: 99_000,
      ttlMs: 10_000,
    });
    expect(afterExpiry?.holder).toBe('exec-2');
  });

  it('only lets the holder release a lease', async () => {
    await repo.control.acquireLease({
      worldId: WORLD_ID,
      name: 'tick',
      holder: 'exec-1',
      nowEpochMs: 1_000,
      ttlMs: 10_000,
    });
    await repo.control.releaseLease(WORLD_ID, 'tick', 'exec-2');
    const stillBlocked = await repo.control.acquireLease({
      worldId: WORLD_ID,
      name: 'tick',
      holder: 'exec-3',
      nowEpochMs: 2_000,
      ttlMs: 10_000,
    });
    expect(stillBlocked).toBeUndefined();

    await repo.control.releaseLease(WORLD_ID, 'tick', 'exec-1');
    const acquired = await repo.control.acquireLease({
      worldId: WORLD_ID,
      name: 'tick',
      holder: 'exec-3',
      nowEpochMs: 3_000,
      ttlMs: 10_000,
    });
    expect(acquired?.holder).toBe('exec-3');
  });

  it('tracks creator quota per day with optimistic concurrency', async () => {
    const etag = await repo.control.putQuota({
      rv: 1,
      worldId: WORLD_ID,
      creatorId: 'creator-1',
      dayKey: '2024-01-01',
      agentsCreated: 1,
      goalsSubmitted: 0,
    });
    const found = await repo.control.getQuota(WORLD_ID, 'creator-1', '2024-01-01');
    expect(found?.value.agentsCreated).toBe(1);

    await repo.control.putQuota(
      {
        rv: 1,
        worldId: WORLD_ID,
        creatorId: 'creator-1',
        dayKey: '2024-01-01',
        agentsCreated: 2,
        goalsSubmitted: 0,
      },
      etag,
    );
    const bumped = await repo.control.getQuota(WORLD_ID, 'creator-1', '2024-01-01');
    expect(bumped?.value.agentsCreated).toBe(2);

    // A concurrent creator request that read the old value must lose, not silently overwrite.
    await expect(
      repo.control.putQuota(
        {
          rv: 1,
          worldId: WORLD_ID,
          creatorId: 'creator-1',
          dayKey: '2024-01-01',
          agentsCreated: 2,
          goalsSubmitted: 1,
        },
        etag,
      ),
    ).rejects.toBeInstanceOf(ConcurrencyConflict);
  });

  it('round-trips idempotency records', async () => {
    expect(await repo.control.getIdempotency(WORLD_ID, 'key-1')).toBeUndefined();
    await repo.control.putIdempotency({
      rv: 1,
      worldId: WORLD_ID,
      key: 'key-1',
      responseJson: '{"id":"ag-1"}',
      createdAtEpochMs: 1_000,
    });
    const found = await repo.control.getIdempotency(WORLD_ID, 'key-1');
    expect(found?.responseJson).toBe('{"id":"ag-1"}');
  });

  it('lists only pending goals', async () => {
    await repo.goals.putMany([goal('g-1'), goal('g-2', { status: 'adopted' })]);
    const pending = await repo.goals.listPending(WORLD_ID, 10);
    expect(pending.map((g) => g.id)).toEqual(['g-1']);

    const byAgent = await repo.goals.listByAgent(WORLD_ID, 'ag-1');
    expect(byAgent.items).toHaveLength(2);
  });

  it('replaces the whole signal set each tick', async () => {
    await repo.signals.replaceAll(WORLD_ID, [
      {
        rv: 1,
        worldId: WORLD_ID,
        organismId: 'or-1',
        lineageId: 'ln-1',
        agentId: 'ag-1',
        regionId: 'r0x0',
        position: { x: 1, z: 1 },
        channel: 'alarm',
        intensity: 500,
        radiusCu: 100,
        emittedAtTick: 1,
      },
    ]);
    expect(await repo.signals.listByWorld(WORLD_ID)).toHaveLength(1);

    await repo.signals.replaceAll(WORLD_ID, []);
    expect(await repo.signals.listByWorld(WORLD_ID)).toHaveLength(0);
  });

  it('does not leak records between worlds', async () => {
    await repo.worlds.put(world({ id: 'world-beta' }));
    await repo.agents.putMany([agent('ag-1'), agent('ag-2', { worldId: 'world-beta' })]);
    const alpha = await repo.agents.listByWorld(WORLD_ID);
    expect(alpha.items.map((a) => a.id)).toEqual(['ag-1']);
  });
});

describe('stored record validation', () => {
  it('surfaces a StoredRecordInvalid rather than silently coercing', async () => {
    const repo = new InMemoryWorldRepository();
    await repo.initialise();
    // A record whose stored JSON no longer parses is a data-integrity failure, not a default.
    expect(() => {
      throw new StoredRecordInvalid(['tick: expected int']);
    }).toThrow(StoredRecordInvalid);
  });
});

describe('storage guardrails', () => {
  it('accepts a managed-identity endpoint in production', () => {
    expect(() =>
      assertProductionSafeStorage({
        mode: 'managedIdentity',
        isProduction: true,
        tableEndpoint: 'https://acct.table.core.windows.net',
      }),
    ).not.toThrow();
  });

  it('refuses a connection string in production', () => {
    expect(() =>
      assertProductionSafeStorage({
        mode: 'managedIdentity',
        isProduction: true,
        tableEndpoint: 'https://acct.table.core.windows.net',
        connectionString: 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=b',
      }),
    ).toThrow(InsecureStorageConfiguration);
  });

  it('refuses a SAS-bearing endpoint even locally', () => {
    expect(() =>
      assertProductionSafeStorage({
        mode: 'localEmulator',
        isProduction: false,
        tableEndpoint: 'https://acct.table.core.windows.net/?sv=2023&sig=abc',
      }),
    ).toThrow(InsecureStorageConfiguration);
  });

  it('refuses the local emulator in production', () => {
    expect(() =>
      assertProductionSafeStorage({
        mode: 'localEmulator',
        isProduction: true,
        tableEndpoint: 'http://127.0.0.1:10002/devstoreaccount1',
      }),
    ).toThrow(InsecureStorageConfiguration);
  });

  it('refuses plain HTTP in production', () => {
    expect(() =>
      assertProductionSafeStorage({
        mode: 'managedIdentity',
        isProduction: true,
        tableEndpoint: 'http://acct.table.core.windows.net',
      }),
    ).toThrow(InsecureStorageConfiguration);
  });

  it('refuses a non-table endpoint in production', () => {
    expect(() =>
      assertProductionSafeStorage({
        mode: 'managedIdentity',
        isProduction: true,
        tableEndpoint: 'https://acct.blob.core.windows.net',
      }),
    ).toThrow(InsecureStorageConfiguration);
  });

  it('allows the Azurite endpoint in local mode', () => {
    expect(() =>
      assertProductionSafeStorage({
        mode: 'localEmulator',
        isProduction: false,
        tableEndpoint: 'http://127.0.0.1:10002/devstoreaccount1',
      }),
    ).not.toThrow();
  });
});
