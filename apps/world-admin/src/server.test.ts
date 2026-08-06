import { describe, expect, it } from 'vitest';
import { Logger } from '@autocosm/observability';
import type {
  RawTablePage,
  RawTableReadOptions,
  RawTableReader,
  RuntimeSettings,
  SettingsStore,
} from '@autocosm/storage';
import { loadAdminConfig } from './config.js';
import { buildAdminServer } from './server.js';

/**
 * The inspector is exercised against a fake reader: the Azure Table SDK path is the same
 * managed-identity client the storage package already covers, so these tests pin the HTTP
 * contract, the error mapping, and the read-only shape instead.
 */

class FakeReader implements RawTableReader {
  readonly tables = ['worlds', 'agents', 'control'] as const;
  lastTable: string | undefined;
  lastOptions: RawTableReadOptions | undefined;

  async read(table: string, options?: RawTableReadOptions): Promise<RawTablePage> {
    this.lastTable = table;
    this.lastOptions = options;
    if (options?.continuation === 'page2') {
      return { table, rows: [row('B', '2')] };
    }
    return { table, rows: [row('A', '1')], continuation: 'page2' };
  }
}

function row(partitionKey: string, rowKey: string): RawTablePage['rows'][number] {
  return { partitionKey, rowKey, rv: 3, record: { hello: 'world' }, raw: { partitionKey, rowKey } };
}

class FakeSettings implements SettingsStore {
  value: boolean | undefined;
  async read(): Promise<RuntimeSettings> {
    return this.value === undefined ? {} : { logOpenAiIo: this.value };
  }
  async setLogOpenAiIo(enabled: boolean): Promise<void> {
    this.value = enabled;
  }
}

function buildConfig() {
  return loadAdminConfig({
    NODE_ENV: 'test',
    AUTOCOSM_STORAGE_DRIVER: 'azureTables',
    AZURE_TABLE_ENDPOINT: 'https://example.table.core.windows.net/',
  });
}

function buildConfigWithAuth() {
  return loadAdminConfig({
    NODE_ENV: 'test',
    AUTOCOSM_STORAGE_DRIVER: 'azureTables',
    AZURE_TABLE_ENDPOINT: 'https://example.table.core.windows.net/',
    AUTOCOSM_ADMIN_AUTH_CLIENT_ID: '3be836a8-3b6c-4744-9079-5791ac3bbc3c',
    AZURE_TENANT_ID: '7af8f68a-896b-44d5-994a-1c9bf336f8d7',
  });
}

async function makeApp(
  reader: RawTableReader,
  settings: SettingsStore = new FakeSettings(),
  config = buildConfig(),
) {
  return buildAdminServer({
    config,
    reader,
    settings,
    logger: new Logger({ level: 'error', context: { mode: 'admin' } }),
  });
}

describe('admin inspector server', () => {
  it('reports health', async () => {
    const app = await makeApp(new FakeReader());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('lists the inspectable tables', async () => {
    const app = await makeApp(new FakeReader());
    const res = await app.inject({ method: 'GET', url: '/api/tables' });
    expect(res.statusCode).toBe(200);
    expect(res.json().tables).toContain('agents');
    await app.close();
  });

  it('returns rows for a known table and passes the page size through', async () => {
    const reader = new FakeReader();
    const app = await makeApp(reader);
    const res = await app.inject({ method: 'GET', url: '/api/tables/agents?limit=25' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows[0]).toMatchObject({ partitionKey: 'A', rowKey: '1' });
    expect(body.continuation).toBe('page2');
    expect(reader.lastOptions?.limit).toBe(25);
    await app.close();
  });

  it('follows a continuation token', async () => {
    const reader = new FakeReader();
    const app = await makeApp(reader);
    const res = await app.inject({ method: 'GET', url: '/api/tables/agents?continuation=page2' });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0]).toMatchObject({ rowKey: '2' });
    expect(res.json().continuation).toBeUndefined();
    await app.close();
  });

  it('404s an unknown but well-formed table name', async () => {
    const app = await makeApp(new FakeReader());
    const res = await app.inject({ method: 'GET', url: '/api/tables/nosuchtable' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('unknownTable');
    await app.close();
  });

  it('400s a malformed table name', async () => {
    const app = await makeApp(new FakeReader());
    const res = await app.inject({ method: 'GET', url: '/api/tables/Bad-Name' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('serves the inspector page and its script from separate routes', async () => {
    const app = await makeApp(new FakeReader());
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Storage Inspector');
    expect(page.body).toContain('/app.js');

    const script = await app.inject({ method: 'GET', url: '/app.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    await app.close();
  });

  it('sets a strict content security policy with no inline-script allowance', async () => {
    const app = await makeApp(new FakeReader());
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // The token endpoint is the only cross-origin connection the page may open.
    expect(csp).toContain("connect-src 'self' https://login.microsoftonline.com");
    await app.close();
  });

  it('serves an empty auth-config when no external sign-in is configured', async () => {
    const app = await makeApp(new FakeReader());
    const res = await app.inject({ method: 'GET', url: '/api/auth-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    await app.close();
  });

  it('serves the sign-in client and tenant when configured for external access', async () => {
    const app = await makeApp(new FakeReader(), new FakeSettings(), buildConfigWithAuth());
    const res = await app.inject({ method: 'GET', url: '/api/auth-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      clientId: '3be836a8-3b6c-4744-9079-5791ac3bbc3c',
      tenantId: '7af8f68a-896b-44d5-994a-1c9bf336f8d7',
    });
    await app.close();
  });

  it('serves the sign-in popup callback page and its script from separate routes', async () => {
    const app = await makeApp(new FakeReader());
    const page = await app.inject({ method: 'GET', url: '/auth/callback' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('/auth-callback.js');

    const script = await app.inject({ method: 'GET', url: '/auth-callback.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(script.body).toContain('postMessage');
    await app.close();
  });

  it('reads the current openai logging setting, defaulting to off', async () => {
    const app = await makeApp(new FakeReader());
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ logOpenAiIo: false });
    await app.close();
  });

  it('toggles openai logging and persists it through the settings store', async () => {
    const settings = new FakeSettings();
    const app = await makeApp(new FakeReader(), settings);
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/openai-logging',
      headers: { 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ logOpenAiIo: true });
    expect(settings.value).toBe(true);

    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json()).toEqual({ logOpenAiIo: true });
    await app.close();
  });

  it('rejects a non-boolean logging toggle', async () => {
    const app = await makeApp(new FakeReader());
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/openai-logging',
      headers: { 'content-type': 'application/json' },
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('reports the signed-in user from the platform auth header, or null', async () => {
    const app = await makeApp(new FakeReader());
    const anon = await app.inject({ method: 'GET', url: '/api/me' });
    expect(anon.json()).toEqual({ user: null });
    const authed = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { 'x-ms-client-principal-name': 'jane@example.com' },
    });
    expect(authed.json()).toEqual({ user: 'jane@example.com' });
    await app.close();
  });
});
