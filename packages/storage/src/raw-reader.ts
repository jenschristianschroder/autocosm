import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { TABLE_NAMES } from './azure-repository.js';
import type { StorageConfig } from './config.js';
import { assertProductionSafeStorage } from './guardrails.js';

/**
 * Read-only, generic access to the raw Table entities, for the internal admin inspector.
 *
 * This deliberately sits *outside* the schema-validated `WorldRepository`: the inspector's job is
 * to show what is actually stored — including a malformed, partial or legacy row that the typed
 * repository would reject — so it decodes leniently and never validates. It never writes, never
 * creates a table, and only ever touches the known Autocosm tables. The same managed-identity
 * guardrails as the main adapter apply: no key, connection string or SAS is ever accepted.
 */

const TABLE_LIST: readonly string[] = Object.freeze(Object.values(TABLE_NAMES));
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export interface RawTableRow {
  readonly partitionKey: string;
  readonly rowKey: string;
  readonly timestamp?: string;
  readonly rv?: number;
  /** The decoded domain record when the row follows the envelope shape (`body` JSON); else absent. */
  readonly record?: unknown;
  /** Every stored property verbatim, so a row that does not follow the envelope is still visible. */
  readonly raw: Record<string, unknown>;
}

export interface RawTablePage {
  readonly table: string;
  readonly rows: readonly RawTableRow[];
  /** Opaque token for the next page; absent when the scan is complete. */
  readonly continuation?: string;
}

export interface RawTableReadOptions {
  readonly limit?: number;
  readonly continuation?: string;
}

export interface RawTableReader {
  /** The fixed set of inspectable tables. */
  readonly tables: readonly string[];
  read(table: string, options?: RawTableReadOptions): Promise<RawTablePage>;
}

export class UnknownTable extends Error {
  constructor(table: string) {
    super(`unknown table '${table}'`);
    this.name = 'UnknownTable';
  }
}

// Continuation tokens are opaque to callers; encode so they survive a query-string round trip.
const encodeToken = (token: string): string => Buffer.from(token, 'utf8').toString('base64url');
const decodeToken = (token: string): string => Buffer.from(token, 'base64url').toString('utf8');

function boundedPage(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.max(1, Math.trunc(limit)));
}

function toRow(entity: Record<string, unknown>): RawTableRow {
  const partitionKey = String(entity['partitionKey'] ?? '');
  const rowKey = String(entity['rowKey'] ?? '');
  const timestampValue = entity['timestamp'];
  const timestamp = typeof timestampValue === 'string' ? timestampValue : undefined;
  const rvValue = entity['rv'];
  const rv = typeof rvValue === 'number' ? rvValue : undefined;
  let record: unknown;
  const body = entity['body'];
  if (typeof body === 'string') {
    try {
      record = JSON.parse(body);
    } catch {
      record = body;
    }
  }
  return {
    partitionKey,
    rowKey,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(rv === undefined ? {} : { rv }),
    ...(record === undefined ? {} : { record }),
    raw: { ...entity },
  };
}

class AzureRawTableReader implements RawTableReader {
  readonly tables = TABLE_LIST;
  readonly #endpoint: string;
  readonly #credential: TokenCredential;
  readonly #clients = new Map<string, TableClient>();

  constructor(endpoint: string, credential: TokenCredential) {
    this.#endpoint = endpoint.replace(/\/+$/u, '');
    this.#credential = credential;
  }

  #client(name: string): TableClient {
    const existing = this.#clients.get(name);
    if (existing) return existing;
    const client = new TableClient(this.#endpoint, name, this.#credential);
    this.#clients.set(name, client);
    return client;
  }

  async read(table: string, options?: RawTableReadOptions): Promise<RawTablePage> {
    if (!TABLE_LIST.includes(table)) throw new UnknownTable(table);
    const limit = boundedPage(options?.limit);
    const iterator = this.#client(table)
      .listEntities<Record<string, unknown>>()
      .byPage({
        maxPageSize: limit,
        ...(options?.continuation === undefined
          ? {}
          : { continuationToken: decodeToken(options.continuation) }),
      });
    const first = await iterator.next();
    if (first.done === true) return { table, rows: [] };
    const page = first.value;
    const rows = page.map((entity) => toRow(entity));
    const token = page.continuationToken;
    return token === undefined || token === ''
      ? { table, rows }
      : { table, rows, continuation: encodeToken(token) };
  }
}

/**
 * Build the raw reader. Azure Tables only: the inspector exists to look at the deployed store, and
 * the in-memory driver holds nothing across processes. A `memory` driver is a configuration error.
 */
export function createRawTableReader(config: StorageConfig): RawTableReader {
  if (config.driver !== 'azureTables') {
    throw new Error('the storage inspector requires AUTOCOSM_STORAGE_DRIVER=azureTables');
  }
  const endpoint = config.tableEndpoint ?? '';
  assertProductionSafeStorage({
    mode: 'managedIdentity',
    isProduction: config.isProduction,
    tableEndpoint: endpoint,
  });
  const credential = new DefaultAzureCredential(
    config.managedIdentityClientId === undefined
      ? {}
      : { managedIdentityClientId: config.managedIdentityClientId },
  );
  return new AzureRawTableReader(endpoint, credential);
}
