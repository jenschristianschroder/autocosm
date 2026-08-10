import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryWorldRepository, saveWorldBundle } from '@autocosm/storage';
import { Logger, Metrics, memorySink, type LogRecord } from '@autocosm/observability';
import { advanceTick, generateWorld, toRecords } from '@autocosm/simulation';
import {
  CreateAgentResponseSchema,
  EventHistoryResponseSchema,
  GlossaryResponseSchema,
  SnapshotResponseSchema,
  SubmitGoalResponseSchema,
  WorldMetaResponseSchema,
} from '@autocosm/domain';
import { WebConfigSchema, loadWebConfig, InvalidConfiguration } from './config.js';
import { CREATOR_COOKIE, SignedCookieCreatorIdentity } from './identity.js';
import { MUTATION_ROUTES, buildServer } from './server.js';
import { WorldService } from './world-service.js';

/**
 * API tests.
 *
 * The most important assertions here are negative: an observer cannot reach any route that
 * mutates the world, quotas are real limits rather than advisory, and malformed input is refused
 * without revealing anything about storage.
 */

const VALID_AGENT = {
  name: 'Tidewalker',
  aspiration: 'Find the deep water and remember the way back.',
  habitat: 'shallows',
  temperament: 'bold',
  sensoryBias: 'chemical',
  visualSeed: 4242,
  drives: { survive: 700, forage: 600, reproduce: 400, explore: 500, cooperate: 300, build: 200 },
} as const;

async function harness(
  overrides: Partial<Record<string, unknown>> = {},
  options: { ticks?: number; seedWorld?: boolean } = {},
) {
  const repository = new InMemoryWorldRepository();
  await repository.initialise();

  if (options.seedWorld !== false) {
    let state = generateWorld({ seed: 90_210, worldId: 'test-world' });
    for (let i = 0; i < (options.ticks ?? 3); i += 1) state = advanceTick(state).state;
    await saveWorldBundle(repository, toRecords(state));
  }

  const config = WebConfigSchema.parse({
    nodeEnv: 'test',
    worldId: 'test-world',
    storage: { driver: 'memory', isProduction: false },
    maxAgentsPerCreatorPerDay: 2,
    maxGoalsPerCreatorPerDay: 2,
    snapshotCacheSeconds: 0,
    ...overrides,
  });

  const world = new WorldService({
    repository,
    worldId: config.worldId,
    maxAgentsPerCreatorPerDay: config.maxAgentsPerCreatorPerDay,
    maxGoalsPerCreatorPerDay: config.maxGoalsPerCreatorPerDay,
    cacheTtlMs: 0,
  });

  const logs: LogRecord[] = [];
  const app = await buildServer({
    config,
    world,
    identity: new SignedCookieCreatorIdentity('a-test-signing-key-of-length'),
    logger: new Logger({ sink: memorySink(logs), level: 'error' }),
    metrics: new Metrics(),
  });

  return { app, repository, world, config, logs };
}

/** Reuse one creator cookie across requests so quota accounting is per-creator, not per-request. */
function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const first = Array.isArray(raw) ? String(raw[0]) : String(raw ?? '');
  return first.split(';')[0] ?? '';
}

describe('observer boundary', () => {
  it('exposes exactly two mutation routes, both authoring intent rather than world state', async () => {
    const { app } = await harness();
    const routes = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .filter((line) => /\((POST|PUT|PATCH|DELETE)/u.test(line));
    await app.close();

    // Every mutating verb the router knows about must be a POST, and only the two authoring ones.
    expect(routes.every((line) => !/(PUT|PATCH|DELETE)/u.test(line))).toBe(true);
    expect(MUTATION_ROUTES).toHaveLength(2);
  });

  it('refuses direct world manipulation attempts', async () => {
    const { app } = await harness();
    const attempts = [
      { method: 'POST' as const, url: '/api/v1/organisms/o-1/move' },
      { method: 'POST' as const, url: '/api/v1/world/tick' },
      { method: 'POST' as const, url: '/api/v1/world/seed' },
      { method: 'POST' as const, url: '/api/v1/world/reset' },
      { method: 'DELETE' as const, url: '/api/v1/organisms/o-1' },
      { method: 'PATCH' as const, url: '/api/v1/agents/ag-1' },
      { method: 'POST' as const, url: '/api/v1/structures' },
      { method: 'POST' as const, url: '/api/v1/resources/grant' },
    ];

    for (const attempt of attempts) {
      const res = await app.inject(attempt);
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'notFound' } });
    }
    await app.close();
  });

  it('never mutates world state through a read route', async () => {
    const { app, repository } = await harness();
    const before = await repository.worlds.get('test-world');
    await app.inject({ method: 'GET', url: '/api/v1/snapshot' });
    await app.inject({ method: 'GET', url: '/api/v1/world' });
    await app.inject({ method: 'GET', url: '/api/v1/events?limit=10' });
    const after = await repository.worlds.get('test-world');
    await app.close();
    expect(after?.value.tick).toBe(before?.value.tick);
  });
});

describe('static hosting', () => {
  /**
   * The container serves the browser bundle from the same process as the API, so this path runs
   * in production but not in most tests. It regressed once — two `setNotFoundHandler` calls on
   * one instance, which Fastify rejects at boot — so it is asserted explicitly.
   */
  const staticRoot = mkdtempSync(path.join(tmpdir(), 'autocosm-static-'));
  writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Autocosm</title>');
  writeFileSync(path.join(staticRoot, 'app.js'), 'export default 1;');

  it('boots with a static root and serves the client shell', async () => {
    const { app } = await harness({ staticRoot });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Autocosm');
    await app.close();
  });

  it('falls through unknown browser paths to the single-page shell', async () => {
    const { app } = await harness({ staticRoot });
    const res = await app.inject({ method: 'GET', url: '/lineage/ln-drifters' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Autocosm');
    await app.close();
  });

  it('still returns a structured 404 for unknown API routes', async () => {
    const { app } = await harness({ staticRoot });
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'notFound' } });
    await app.close();
  });

  /**
   * Development has no static root, so `/` used to answer a bare JSON 404 — the client runs on a
   * separate Vite port. Both directions are asserted because a signpost that leaked into
   * production would shadow the real single-page shell.
   */
  it('signposts the client from the API root when no bundle is hosted', async () => {
    const { app } = await harness({ devClientUrl: 'http://127.0.0.1:5173' });
    const res = await app.inject({ method: 'GET', url: '/' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('http://127.0.0.1:5173');
  });

  it('never serves the development signpost in production', async () => {
    const { app } = await harness({
      nodeEnv: 'production',
      devClientUrl: 'http://127.0.0.1:5173',
      storage: { driver: 'memory', isProduction: false },
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'notFound' } });
  });

  it('caches hashed assets immutably and the shell not at all', async () => {
    const { app } = await harness({ staticRoot });
    const html = await app.inject({ method: 'GET', url: '/index.html' });
    const asset = await app.inject({ method: 'GET', url: '/app.js' });
    await app.close();
    expect(html.headers['cache-control']).toBe('no-cache');
    expect(asset.headers['cache-control']).toContain('immutable');
  });
});

describe('read routes', () => {
  it('serves a bounded snapshot that validates against its schema', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/snapshot?radius=1' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const parsed = SnapshotResponseSchema.parse(res.json());
    expect(parsed.regions.length).toBeGreaterThan(0);
    expect(parsed.regions.length).toBeLessThanOrEqual(9);
    expect(parsed.organisms.length).toBeLessThanOrEqual(600);
    expect(res.headers.etag).toBeDefined();
  });

  it('answers a conditional GET with 304 while the world is unchanged', async () => {
    const { app } = await harness();
    const first = await app.inject({ method: 'GET', url: '/api/v1/snapshot' });
    const etag = String(first.headers.etag);
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/snapshot',
      headers: { 'if-none-match': etag },
    });
    await app.close();
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('serves world metadata and event history', async () => {
    const { app } = await harness();
    const meta = await app.inject({ method: 'GET', url: '/api/v1/world' });
    const events = await app.inject({ method: 'GET', url: '/api/v1/events?limit=25' });
    await app.close();

    const parsedMeta = WorldMetaResponseSchema.parse(meta.json());
    expect(parsedMeta.agents.length).toBeGreaterThanOrEqual(8);
    // The material catalogue rides on /world rather than the snapshot, so a spectator can name
    // anything the world references without a request per material.
    expect(parsedMeta.materials.length).toBeGreaterThan(0);
    expect(parsedMeta.materials.every((m) => m.label.length > 0)).toBe(true);
    expect(EventHistoryResponseSchema.parse(events.json()).events.length).toBeLessThanOrEqual(25);
  });

  it('serves a cacheable glossary that explains the vocabulary the world uses', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/glossary' });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Static for the life of the deployment; a spectator should not refetch it every poll.
    expect(res.headers['cache-control']).toContain('max-age=');
    const glossary = GlossaryResponseSchema.parse(res.json());
    expect(glossary.structureFunctions.length).toBe(10);
    expect(glossary.traits.length).toBeGreaterThan(0);
    expect(glossary.rejectionReasons.length).toBeGreaterThan(0);
    // Crafting can now push a property past every ingredient that made it. That is the least
    // intuitive rule in the world, so the route must explain it rather than leave a spectator to
    // infer it from a number that does not add up.
    expect(glossary.materialReactions.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-range snapshot radius rather than clamping silently', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/snapshot?radius=9' });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalidRequest' } });
  });

  it('returns 404 for unknown agents, organisms, lineages and structures', async () => {
    const { app } = await harness();
    for (const url of [
      '/api/v1/agents/ag-nope',
      '/api/v1/organisms/o-nope',
      '/api/v1/lineages/l-nope',
      '/api/v1/structures/st-nope',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
    await app.close();
  });

  it('reports notReady when the world has not been seeded', async () => {
    const { app } = await harness({}, { seedWorld: false });
    const res = await app.inject({ method: 'GET', url: '/api/v1/readiness' });
    await app.close();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'notReady', worldSeeded: false });
  });

  it('degrades a snapshot request safely when the world is missing', async () => {
    const { app } = await harness({}, { seedWorld: false });
    const res = await app.inject({ method: 'GET', url: '/api/v1/snapshot' });
    await app.close();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'worldNotReady' } });
  });
});

describe('agent authoring', () => {
  it('creates a lineage with no living body, leaving embodiment to the tick job', async () => {
    const { app, repository } = await harness();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: VALID_AGENT });
    expect(res.statusCode).toBe(201);
    const created = CreateAgentResponseSchema.parse(res.json());

    const agent = await repository.agents.get('test-world', created.agentId);
    const lineage = await repository.lineages.get('test-world', created.lineageId);
    const organisms = await repository.organisms.listByWorld('test-world', { limit: 1000 });
    await app.close();

    expect(agent?.value.name).toBe(VALID_AGENT.name);
    expect(lineage?.livingCount).toBe(0);
    expect(lineage?.births).toBe(0);
    // The API wrote intent only: no organism belongs to the new lineage yet.
    expect(organisms.items.some((o) => o.lineageId === created.lineageId)).toBe(false);
  });

  it('materialises the founding cell only when the simulation advances', async () => {
    const { app, repository, world } = await harness();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: VALID_AGENT });
    const created = CreateAgentResponseSchema.parse(res.json());
    await app.close();

    const { state } = await world.load();
    const advanced = advanceTick(state).state;
    const current = await repository.worlds.get('test-world');
    await saveWorldBundle(repository, toRecords(advanced), {
      previous: toRecords(state),
      worldEtag: current?.etag,
    });

    const organisms = await repository.organisms.listByWorld('test-world', { limit: 2000 });
    expect(organisms.items.some((o) => o.lineageId === created.lineageId)).toBe(true);
  });

  it('rejects malformed authoring requests with field-level detail and no storage leakage', async () => {
    const { app } = await harness();
    const bad = [
      {},
      { ...VALID_AGENT, name: '' },
      { ...VALID_AGENT, name: '<script>alert(1)</script>' },
      { ...VALID_AGENT, habitat: 'moon' },
      { ...VALID_AGENT, visualSeed: -1 },
      { ...VALID_AGENT, visualSeed: 1e9 },
      {
        ...VALID_AGENT,
        drives: {
          survive: 1000,
          forage: 1000,
          reproduce: 1000,
          explore: 1000,
          cooperate: 1000,
          build: 1000,
        },
      },
      { ...VALID_AGENT, aspiration: 'x' },
    ];

    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/agents', payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      const body = res.body;
      expect(body).not.toMatch(/table|azure|core\.windows\.net|partitionKey|rowKey/iu);
    }
    await app.close();
  });

  it('enforces the daily creation quota per creator', async () => {
    const { app } = await harness();
    const first = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: VALID_AGENT });
    const cookie = cookieFrom(first.headers as Record<string, unknown>);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { ...VALID_AGENT, name: 'Second' },
      headers: { cookie },
    });
    const third = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { ...VALID_AGENT, name: 'Third' },
      headers: { cookie },
    });
    await app.close();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: 'quotaExceeded' } });
  });

  it('replays an idempotent creation instead of creating a second lineage', async () => {
    const { app, repository } = await harness();
    const headers = { 'idempotency-key': 'create-once-0001' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: VALID_AGENT,
      headers,
    });
    const cookie = cookieFrom(first.headers as Record<string, unknown>);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: VALID_AGENT,
      headers: { ...headers, cookie },
    });
    const lineages = await repository.lineages.listByWorld('test-world', { limit: 100 });
    await app.close();

    expect(first.json()).toMatchObject({ agentId: second.json().agentId });
    // Eight seeded lineages plus exactly one authored lineage.
    expect(lineages.items.filter((l) => l.name === VALID_AGENT.name)).toHaveLength(1);
  });

  it('does not consume quota when the request is a replay', async () => {
    const { app } = await harness();
    const headers = { 'idempotency-key': 'replay-quota-001' };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: VALID_AGENT,
      headers,
    });
    const cookie = cookieFrom(first.headers as Record<string, unknown>);
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: VALID_AGENT,
      headers: { ...headers, cookie },
    });
    const creator = await app.inject({
      method: 'GET',
      url: '/api/v1/creator',
      headers: { cookie },
    });
    await app.close();
    expect(creator.json().agentsRemainingToday).toBe(1);
  });
});

describe('broad goals', () => {
  async function withAgent() {
    const h = await harness();
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/agents', payload: VALID_AGENT });
    return {
      ...h,
      agentId: CreateAgentResponseSchema.parse(res.json()).agentId,
      cookie: cookieFrom(res.headers as Record<string, unknown>),
    };
  }

  it('accepts a broad goal as pending motivation, not an instruction', async () => {
    const { app, agentId, cookie, repository } = await withAgent();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/goals`,
      payload: { text: 'Seek the ocean and remember the way.' },
      headers: { cookie },
    });
    const goals = await repository.goals.listByAgent('test-world', agentId, { limit: 10 });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(SubmitGoalResponseSchema.parse(res.json()).status).toBe('pending');
    expect(goals.items[0]?.status).toBe('pending');
  });

  it('enforces the daily goal quota', async () => {
    const { app, agentId, cookie } = await withAgent();
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agentId}/goals`,
        payload: { text: 'Protect your descendants above all.' },
        headers: { cookie },
      });

    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(202);
    const third = await send();
    await app.close();
    expect(third.statusCode).toBe(429);
  });

  it('rejects an oversized or empty goal', async () => {
    const { app, agentId, cookie } = await withAgent();
    for (const text of ['', 'ab', 'x'.repeat(400)]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/agents/${agentId}/goals`,
        payload: { text },
        headers: { cookie },
      });
      expect(res.statusCode, JSON.stringify(text).slice(0, 20)).toBe(400);
    }
    await app.close();
  });

  it('returns 404 for a goal aimed at an unknown agent', async () => {
    const { app, cookie } = await withAgent();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/ag-does-not-exist/goals',
      payload: { text: 'Seek the ocean.' },
      headers: { cookie },
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });
});

describe('transport safety', () => {
  it('rejects a body larger than the configured limit', async () => {
    const { app } = await harness({ maxRequestBodyBytes: 2_048 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { ...VALID_AGENT, aspiration: 'x'.repeat(8_000) },
    });
    await app.close();
    expect([400, 413]).toContain(res.statusCode);
  });

  it('sets security headers and a correlation id on every response', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    await app.close();
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options'] ?? res.headers['content-security-policy']).toBeDefined();
  });

  it('echoes a supplied correlation id but refuses a malformed one', async () => {
    const { app } = await harness();
    const good = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-correlation-id': 'trace-123' },
    });
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-correlation-id': 'a'.repeat(500) },
    });
    await app.close();
    expect(good.headers['x-correlation-id']).toBe('trace-123');
    expect(bad.headers['x-correlation-id']).not.toBe('a'.repeat(500));
  });

  it('issues a signed creator cookie that a tampered value cannot impersonate', async () => {
    const { app } = await harness();
    const first = await app.inject({ method: 'GET', url: '/api/v1/creator' });
    const cookie = cookieFrom(first.headers as Record<string, unknown>);
    const forged = `${CREATOR_COOKIE}=${cookie.split('=')[1]?.split('.')[0]}.deadbeef`;

    const second = await app.inject({ method: 'GET', url: '/api/v1/creator', headers: { cookie } });
    const third = await app.inject({
      method: 'GET',
      url: '/api/v1/creator',
      headers: { cookie: forged },
    });
    await app.close();

    expect(second.json().creatorId).toBe(first.json().creatorId);
    expect(third.json().creatorId).not.toBe(first.json().creatorId);
  });
});

describe('configuration guards', () => {
  it('refuses local seeding in production', () => {
    expect(() =>
      loadWebConfig({
        NODE_ENV: 'production',
        AUTOCOSM_ALLOW_LOCAL_SEEDING: 'true',
        AZURE_TABLE_ENDPOINT: 'https://example.table.core.windows.net',
        AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
      } as NodeJS.ProcessEnv),
    ).toThrow(InvalidConfiguration);
  });

  it('refuses a non-Azure storage driver in production', () => {
    expect(() =>
      loadWebConfig({
        NODE_ENV: 'production',
        AUTOCOSM_STORAGE_DRIVER: 'memory',
      } as NodeJS.ProcessEnv),
    ).toThrow(InvalidConfiguration);
  });

  it('defaults to a safe local configuration', () => {
    const config = loadWebConfig({} as NodeJS.ProcessEnv);
    expect(config.storage.driver).toBe('memory');
    expect(config.allowLocalSeeding).toBe(false);
    expect(config.heuristicOnly).toBe(true);
  });
});
