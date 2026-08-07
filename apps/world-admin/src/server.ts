import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { z, ZodError } from 'zod';
import type { Logger } from '@autocosm/observability';
import { UnknownTable, type RawTableReader, type SettingsStore } from '@autocosm/storage';
import type { AdminConfig } from './config.js';
import { AUTH_CALLBACK_HTML, AUTH_CALLBACK_JS, INDEX_HTML, INSPECTOR_JS } from './ui.js';

/**
 * The admin inspector's HTTP surface.
 *
 * This process is deployed with **internal ingress by default** (see infra/app.bicep): it is
 * reachable from inside the Container Apps environment, and only from the public internet when
 * explicitly opted in — in which case it is fronted by Microsoft Entra sign-in at the platform.
 * Its ONLY write is a single runtime setting — the OpenAI request/response logging toggle — for
 * which its identity holds table-contributor rights on the `control` table alone; every table read
 * is reader-only. The browser it serves receives rendered JSON only; it never receives a storage
 * endpoint, key, connection string, or SAS.
 *
 * Because its entire purpose is to expose the raw store, partition/row keys DO appear in its
 * responses. That is the deliberate difference from the public `world-web` contract, and the
 * reason the two never share external ingress.
 */

export const ADMIN_VERSION = '0.1.0';

export interface AdminServerDependencies {
  readonly config: AdminConfig;
  readonly reader: RawTableReader;
  readonly settings: SettingsStore;
  readonly logger: Logger;
  readonly now?: () => number;
}

const ReadQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  continuation: z.string().min(1).max(8192).optional(),
});

const TableParamsSchema = z.object({
  table: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+$/u),
});

const ToggleSchema = z.object({ enabled: z.boolean() });

interface AdminError {
  readonly error: { readonly code: string; readonly message: string };
}

const errorBody = (code: string, message: string): AdminError => ({ error: { code, message } });

export async function buildAdminServer(deps: AdminServerDependencies): Promise<FastifyInstance> {
  const { config, reader, logger, settings } = deps;
  const startedAt = deps.now?.() ?? Date.now();

  const app = Fastify({
    logger: false,
    bodyLimit: 16_384,
    trustProxy: true,
    genReqId: (req) => {
      const header = req.headers['x-correlation-id'];
      const supplied = Array.isArray(header) ? header[0] : header;
      return typeof supplied === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(supplied)
        ? supplied
        : randomUUID();
    },
  });

  // A single inline script would otherwise need 'unsafe-inline'; the inspector script is served
  // from its own route so the policy can stay `script-src 'self'`. Styles are inline in the page,
  // which is why style-src permits 'unsafe-inline' and nothing else does.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        // The Entra token endpoint is reached only to exchange a sign-in authorization code for an
        // ID token (external deployment). Everything else stays same-origin.
        connectSrc: ["'self'", 'https://login.microsoftonline.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-correlation-id', String(req.id));
    done();
  });

  app.addHook('onResponse', (req, reply, done) => {
    logger
      .child({ correlationId: String(req.id), route: req.routeOptions.url ?? req.url })
      .debug('request.completed', {
        method: req.method,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    done();
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send(errorBody('badRequest', 'Invalid request.'));
      return;
    }
    if (error instanceof UnknownTable) {
      void reply.status(404).send(errorBody('unknownTable', 'No such table.'));
      return;
    }
    // Never surface storage endpoints, credentials, or internal detail. Log it, return a code.
    logger.error('request.failed', {
      correlationId: String(req.id),
      detail: error instanceof Error ? error.message : String(error),
    });
    void reply.status(500).send(errorBody('internal', 'Unexpected error reading storage.'));
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send(errorBody('notFound', 'Not found.'));
  });

  app.get('/api/health', async (_req, reply) => {
    await reply.send({
      status: 'ok',
      version: ADMIN_VERSION,
      uptimeSeconds: Math.round(((deps.now?.() ?? Date.now()) - startedAt) / 1000),
    });
  });

  // Readiness deliberately does NOT touch storage: an admin tool that probed a table every few
  // seconds could never scale to zero. Storage is exercised on demand by the table routes.
  app.get('/api/readiness', async (_req, reply) => {
    await reply.send({ status: 'ready' });
  });

  app.get('/api/tables', async (_req, reply) => {
    await reply.send({ tables: reader.tables });
  });

  app.get('/api/tables/:table', async (req, reply) => {
    const params = TableParamsSchema.parse(req.params);
    const query = ReadQuerySchema.parse(req.query);
    if (!reader.tables.includes(params.table)) {
      await reply.status(404).send(errorBody('unknownTable', 'No such table.'));
      return;
    }
    const page = await reader.read(params.table, {
      limit: query.limit ?? config.pageSize,
      ...(query.continuation === undefined ? {} : { continuation: query.continuation }),
    });
    await reply.send(page);
  });

  app.get('/api/settings', async (_req, reply) => {
    const current = await settings.read();
    await reply.send({ logOpenAiIo: current.logOpenAiIo ?? false });
  });

  // The only write the inspector performs. The body is a single validated boolean and the setter
  // can touch only the one runtime-settings row — it is not a general table writer. A JSON body plus
  // no CORS means a cross-origin site cannot forge this call. The think job picks the change up on
  // its next scheduled run.
  app.post('/api/settings/openai-logging', async (req, reply) => {
    const { enabled } = ToggleSchema.parse(req.body);
    await settings.setLogOpenAiIo(enabled);
    logger.warn('admin.openaiLoggingToggled', { enabled });
    await reply.send({ logOpenAiIo: enabled });
  });

  // When the app is fronted by Entra sign-in, the platform injects the caller's identity as a
  // header. Absent (internal ingress) it is simply null and the page shows no user chip.
  app.get('/api/me', async (req, reply) => {
    const principal = req.headers['x-ms-client-principal-name'];
    const user = Array.isArray(principal) ? principal[0] : principal;
    await reply.send({ user: typeof user === 'string' && user.length > 0 ? user : null });
  });

  // Public sign-in parameters for the browser. These are non-secret app-registration identifiers.
  // The object is empty when the inspector runs internally (no Easy Auth layer), which is the
  // page's signal to post its toggle directly rather than attaching a bearer token.
  app.get('/api/auth-config', async (_req, reply) => {
    const { clientId, tenantId } = config.auth;
    await reply
      .header('cache-control', 'no-store')
      .send(clientId !== undefined && tenantId !== undefined ? { clientId, tenantId } : {});
  });

  // The sign-in popup lands here after Microsoft Entra returns an authorization code. The page's
  // only job is to hand the code to the main window (through localStorage, which survives the
  // cross-origin-opener isolation the page sets) and close; the PKCE token exchange runs there.
  // Served with its script on a separate route so the CSP keeps script-src 'self' with no
  // inline-script exception.
  app.get('/auth/callback', async (_req, reply) => {
    await reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(AUTH_CALLBACK_HTML);
  });

  app.get('/auth-callback.js', async (_req, reply) => {
    await reply
      .header('content-type', 'application/javascript; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(AUTH_CALLBACK_JS);
  });

  app.get('/app.js', async (_req, reply) => {
    await reply
      .header('content-type', 'application/javascript; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(INSPECTOR_JS);
  });

  app.get('/', async (_req, reply) => {
    await reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(INDEX_HTML);
  });

  return app;
}
