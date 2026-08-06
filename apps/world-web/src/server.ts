import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import {
  API_VERSION,
  CreateAgentResponseSchema,
  EventHistoryResponseSchema,
  GLOSSARY_VERSION,
  GlossaryResponseSchema,
  HistoryQuerySchema,
  SnapshotQuerySchema,
  SubmitGoalResponseSchema,
  buildGlossary,
} from '@autocosm/domain';
import type { ApiError } from '@autocosm/domain';
import type { Logger, Metrics } from '@autocosm/observability';
import type { WebConfig } from './config.js';
import { CREATOR_COOKIE, type CreatorIdentity } from './identity.js';
import {
  composeAgentDetail,
  composeEventHistory,
  composeLineageDetail,
  composeOrganismDetail,
  composeSnapshot,
  composeStructureDetail,
  composeWorldMeta,
} from './read-model.js';
import {
  AgentNotFound,
  QuotaExceeded,
  WorldNotSeeded,
  type WorldService,
} from './world-service.js';

/**
 * The public HTTP surface.
 *
 * Two properties matter more than anything else here:
 *
 * 1. There is no route that mutates authoritative world state. The only writes an observer can
 *    perform are authoring an agent and submitting a broad goal, both of which record *intent*
 *    for the tick job to resolve. A test asserts that the mutation surface is exactly these two.
 * 2. Nothing about the deployment leaks outward. Errors are mapped to short codes, and storage
 *    endpoints, table names and partition keys never appear in a response.
 */

export const SERVICE_VERSION = '0.1.0';

export interface ServerDependencies {
  readonly config: WebConfig;
  readonly world: WorldService;
  readonly identity: CreatorIdentity;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Reports whether a configured AI provider is currently failing, for honest degraded status. */
  readonly aiDegraded?: () => boolean;
  readonly now?: () => number;
}

const PREFIX = `/api/${API_VERSION}`;

/** Routes that mutate anything. Kept explicit so the boundary test can assert the whole set. */
export const MUTATION_ROUTES: readonly string[] = [
  `POST ${PREFIX}/agents`,
  `POST ${PREFIX}/agents/:agentId/goals`,
];

/**
 * The glossary is static for the lifetime of the process, so build and validate it once at module
 * load. A schema violation then fails at startup rather than on a spectator's first request.
 */
const GLOSSARY_BODY = GlossaryResponseSchema.parse(buildGlossary());

export async function buildServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const { config, world, identity, logger, metrics } = deps;
  const startedAt = deps.now?.() ?? Date.now();
  const aiDegraded = deps.aiDegraded ?? ((): boolean => false);

  const app = Fastify({
    logger: false,
    bodyLimit: config.maxRequestBodyBytes,
    trustProxy: true,
    genReqId: (req) => {
      const header = req.headers['x-correlation-id'];
      const supplied = Array.isArray(header) ? header[0] : header;
      return typeof supplied === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(supplied)
        ? supplied
        : randomUUID();
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Babylon compiles shaders and Vite emits inline module preloads; both need
        // 'unsafe-inline' for styles and 'wasm-unsafe-eval' for the WebGPU/WASM paths.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // Same-origin in production: the browser is served by this very app, so no cross-origin
  // request is legitimate. Local development allows the Vite dev server only.
  await app.register(cors, {
    origin:
      config.nodeEnv === 'production'
        ? false
        : [/^http:\/\/localhost:\d+$/u, /^http:\/\/127\.0\.0\.1:\d+$/u],
    credentials: true,
    methods: ['GET', 'POST'],
  });

  await app.register(cookie, {});
  await app.register(rateLimit, {
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (req) => creatorCookieId(req) ?? req.ip,
    errorResponseBuilder: () => errorBody('rateLimited', 'Too many requests. Slow down.'),
  });

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-correlation-id', String(req.id));
    done();
  });

  app.addHook('onResponse', (req, reply, done) => {
    metrics.observeDuration('api.durationMs', reply.elapsedTime);
    metrics.increment('api.requests');
    if (reply.statusCode === 304) metrics.increment('api.notModified');
    if (reply.statusCode >= 500) metrics.increment('api.serverErrors');
    else if (reply.statusCode >= 400) metrics.increment('api.errors');
    logger
      .child({ correlationId: String(req.id), route: req.routeOptions.url ?? req.url })
      .debug('request.completed', {
        method: req.method,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    done();
  });

  // One not-found handler for the instance. Fastify refuses a second one at the same prefix, and
  // the behaviour differs by whether a browser bundle is being served: with static hosting the
  // client is a single-page app, so an unknown non-API path has to fall through to index.html or
  // a deep link is a 404. `/api/` never falls through — an unknown route there is a real 404 and
  // returning HTML would break every client error path.
  const serveStatic = config.staticRoot !== undefined;
  app.setNotFoundHandler((req, reply) => {
    if (!serveStatic || req.url.startsWith('/api/')) {
      void reply.code(404).send(errorBody('notFound', 'No such route.'));
      return;
    }
    void reply.sendFile('index.html');
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    const mapped = mapError(error);
    if (mapped.status >= 500) {
      metrics.increment('api.serverErrors');
      logger.child({ correlationId: String(req.id), outcome: 'error' }).error('request.failed', {
        message: error instanceof Error ? error.message : 'unknown',
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
    void reply.code(mapped.status).send(mapped.body);
  });

  registerRoutes(app, { ...deps, aiDegraded, startedAt });

  // Local development only. Without a bundle this app is API-only, so `/` answers a bare JSON 404
  // and reads as a broken server — the client is on a separate Vite port. A signpost is friendlier
  // than a puzzle. Gated on a non-production build *and* the absence of static hosting, so it can
  // never shadow the real index.html.
  if (!serveStatic && config.nodeEnv !== 'production') {
    app.get('/', (_req, reply) => {
      void reply.type('text/html; charset=utf-8').send(devLandingPage(config.devClientUrl));
    });
  }

  if (config.staticRoot !== undefined) {
    await app.register(fastifyStatic, {
      root: config.staticRoot,
      // Hashed bundles are immutable; index.html must not be, or a deploy is invisible.
      setHeaders: (reply: FastifyReply, path: string) => {
        void reply.header(
          'cache-control',
          path.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
        );
      },
    });
  }

  void world;
  void identity;
  return app;
}

/**
 * A development-only signpost served at `/` when there is no browser bundle to host.
 *
 * Deliberately dependency-free and inert: no scripts, no styles from disk, no state. The client
 * URL is escaped even though the config schema already constrains it to `http(s)` with no quote
 * or angle-bracket characters, because "validated upstream" is a poor reason to interpolate raw
 * text into markup.
 */
function devLandingPage(clientUrl: string | undefined): string {
  const link =
    clientUrl === undefined
      ? '<p>Start the client with <code>npm run dev</code>.</p>'
      : `<p><a href="${escapeHtml(clientUrl)}">Open the Autocosm observatory →</a></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autocosm — API only</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b1020;color:#e8ecf8}
main{max-width:34rem;padding:2rem}a{color:#8ab4ff}code{background:#1a2138;padding:.1rem .35rem;border-radius:.25rem}</style>
</head><body><main>
<h1>Autocosm world-web</h1>
<p>This port serves the JSON API only. The 3D observatory runs on the Vite dev server.</p>
${link}
<p>API health: <a href="/api/v1/health"><code>/api/v1/health</code></a></p>
<p><small>Development build. This page is never served in production.</small></p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ??
      /* c8 ignore next */ c,
  );
}

interface RouteDependencies extends ServerDependencies {
  readonly aiDegraded: () => boolean;
  readonly startedAt: number;
}

function registerRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { config, world, identity, metrics } = deps;
  const now = deps.now ?? Date.now;

  /** Resolve (or mint) the anonymous creator and refresh the signed cookie. */
  const creatorOf = (req: FastifyRequest, reply: FastifyReply): string => {
    const token = identity.resolve(req.cookies[CREATOR_COOKIE]);
    if (token.cookieValue !== req.cookies[CREATOR_COOKIE]) {
      void reply.setCookie(CREATOR_COOKIE, token.cookieValue, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.nodeEnv === 'production',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return token.creatorId;
  };

  app.get(`${PREFIX}/health`, (_req, reply) => {
    void reply.header('cache-control', 'no-store').send({
      status: deps.aiDegraded() ? 'degraded' : 'ok',
      version: SERVICE_VERSION,
      uptimeSeconds: Math.max(0, Math.floor((now() - deps.startedAt) / 1000)),
    });
  });

  app.get(`${PREFIX}/readiness`, async (_req, reply) => {
    let storage: 'ok' | 'unavailable' = 'ok';
    let detail: string | undefined;
    try {
      await world.repository.ping();
    } catch (cause) {
      storage = 'unavailable';
      detail = cause instanceof Error ? cause.name : 'storage probe failed';
    }
    const seeded = storage === 'ok' ? await world.isSeeded() : false;
    void reply
      .code(storage === 'ok' && seeded ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({
        status: storage === 'ok' && seeded ? 'ready' : 'notReady',
        storage,
        worldSeeded: seeded,
        ...(detail === undefined ? {} : { detail }),
      });
  });

  app.get(`${PREFIX}/creator`, async (req, reply) => {
    const creatorId = creatorOf(req, reply);
    const remaining = await world.remainingToday(creatorId);
    void reply.header('cache-control', 'no-store').send({
      creatorId,
      kind: 'anonymous-browser',
      agentsRemainingToday: remaining.agents,
    });
  });

  app.get(`${PREFIX}/world`, async (_req, reply) => {
    const { state, etag } = await world.load();
    void reply
      .header('etag', etag)
      .header('cache-control', `public, max-age=${config.snapshotCacheSeconds}`)
      .send(
        composeWorldMeta(state, {
          heuristicOnly: config.heuristicOnly,
          aiDegraded: deps.aiDegraded(),
        }),
      );
  });

  app.get(`${PREFIX}/snapshot`, async (req, reply) => {
    const query = SnapshotQuerySchema.parse(req.query);
    const { state, etag } = await world.load();
    // Conditional GET: a polling browser costs one storage-free 304 between ticks.
    if (matchesEtag(req.headers['if-none-match'], etag)) {
      void reply.code(304).header('etag', etag).send();
      return;
    }
    const snapshot = composeSnapshot(state, {
      ...(query.regionId === undefined ? {} : { regionId: query.regionId }),
      radius: query.radius,
    });
    const body = JSON.stringify(snapshot);
    metrics.gauge('api.snapshotBytes', Buffer.byteLength(body));
    void reply
      .header('etag', etag)
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', `public, max-age=${config.snapshotCacheSeconds}`)
      .send(body);
  });

  app.get<{ Params: { agentId: string } }>(`${PREFIX}/agents/:agentId`, async (req, reply) => {
    const { state } = await world.load();
    const detail = composeAgentDetail(state, req.params.agentId);
    if (!detail) {
      void reply.code(404).send(errorBody('notFound', 'No such agent.'));
      return;
    }
    void reply.header('cache-control', 'no-store').send(detail);
  });

  app.get<{ Params: { organismId: string } }>(
    `${PREFIX}/organisms/:organismId`,
    async (req, reply) => {
      const { state } = await world.load();
      const detail = composeOrganismDetail(state, req.params.organismId);
      if (!detail) {
        void reply.code(404).send(errorBody('notFound', 'No such organism.'));
        return;
      }
      void reply.header('cache-control', 'no-store').send(detail);
    },
  );

  app.get<{ Params: { structureId: string } }>(
    `${PREFIX}/structures/:structureId`,
    async (req, reply) => {
      const { state } = await world.load();
      const detail = composeStructureDetail(state, req.params.structureId);
      if (!detail) {
        void reply.code(404).send(errorBody('notFound', 'No such structure.'));
        return;
      }
      void reply.header('cache-control', 'no-store').send(detail);
    },
  );

  /**
   * The glossary is compiled into the binary and changes only when the domain does, so it is safe to
   * cache hard. `GLOSSARY_VERSION` is carried in the body and the ETag so a client that has cached
   * an older shape can tell.
   */
  app.get(`${PREFIX}/glossary`, async (_req, reply) => {
    void reply
      .header('cache-control', 'public, max-age=3600')
      .header('etag', `"glossary-v${GLOSSARY_VERSION}"`)
      .send(GLOSSARY_BODY);
  });

  app.get<{ Params: { lineageId: string }; Querystring: { cursor?: string } }>(
    `${PREFIX}/lineages/:lineageId`,
    async (req, reply) => {
      const { state } = await world.load();
      const offset = Number.parseInt(req.query.cursor ?? '0', 10);
      const detail = composeLineageDetail(
        state,
        req.params.lineageId,
        Number.isFinite(offset) && offset >= 0 ? offset : 0,
      );
      if (!detail) {
        void reply.code(404).send(errorBody('notFound', 'No such lineage.'));
        return;
      }
      void reply.header('cache-control', 'no-store').send(detail);
    },
  );

  app.get(`${PREFIX}/events`, async (req, reply) => {
    const query = HistoryQuerySchema.parse(req.query);
    const page = await world.repository.events.query({
      worldId: world.worldId,
      limit: query.limit,
      ...(query.regionId === undefined ? {} : { regionId: query.regionId }),
      ...(query.cursor === undefined ? {} : { continuation: query.cursor }),
    });
    const filtered =
      query.agentId === undefined
        ? page.items
        : page.items.filter((e) => e.agentId === query.agentId);
    const body = composeEventHistory(filtered, page.continuation);
    void reply.header('cache-control', 'no-store').send(EventHistoryResponseSchema.parse(body));
  });

  app.post(`${PREFIX}/agents`, async (req, reply) => {
    const creatorId = creatorOf(req, reply);
    const response = await world.createAgent(creatorId, req.body, idempotencyKey(req));
    metrics.increment('api.agentsCreated');
    void reply.code(201).send(CreateAgentResponseSchema.parse(response));
  });

  app.post<{ Params: { agentId: string } }>(
    `${PREFIX}/agents/:agentId/goals`,
    async (req, reply) => {
      const creatorId = creatorOf(req, reply);
      const response = await world.submitGoal(
        creatorId,
        req.params.agentId,
        req.body,
        idempotencyKey(req),
      );
      metrics.increment('api.goalsSubmitted');
      void reply.code(202).send(SubmitGoalResponseSchema.parse(response));
    },
  );
}

function idempotencyKey(req: FastifyRequest): string | undefined {
  const header = req.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  return /^[A-Za-z0-9_.:-]{8,128}$/u.test(value) ? value : undefined;
}

function creatorCookieId(req: FastifyRequest): string | undefined {
  const raw = req.headers.cookie;
  if (raw === undefined) return undefined;
  const match = new RegExp(`${CREATOR_COOKIE}=([^;.]+)`, 'u').exec(raw);
  return match?.[1];
}

function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return false;
  return value
    .split(',')
    .map((part) => part.trim())
    .some((candidate) => candidate === etag || candidate === `W/${etag}` || candidate === '*');
}

function errorBody(code: string, message: string, details?: readonly string[]): ApiError {
  return {
    error: {
      code,
      message,
      ...(details === undefined || details.length === 0
        ? {}
        : { details: details.slice(0, 20).map((d) => d.slice(0, 200)) }),
    },
  };
}

/**
 * Map an internal failure to a public error.
 *
 * Unknown failures collapse to a generic 500 with no message from the cause, so an Azure or
 * storage detail can never reach the browser.
 */
export function mapError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: errorBody(
        'invalidRequest',
        'Request failed validation.',
        error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      ),
    };
  }
  if (error instanceof QuotaExceeded) {
    return { status: 429, body: errorBody('quotaExceeded', error.message) };
  }
  if (error instanceof AgentNotFound) {
    return { status: 404, body: errorBody('notFound', 'No such agent.') };
  }
  if (error instanceof WorldNotSeeded) {
    return {
      status: 503,
      body: errorBody('worldNotReady', 'The world has not been seeded yet. Try again shortly.'),
    };
  }
  const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    const code = statusCode === 413 ? 'payloadTooLarge' : 'badRequest';
    return { status: statusCode, body: errorBody(code, 'Request rejected.') };
  }
  return { status: 500, body: errorBody('internalError', 'Something went wrong.') };
}
