import { RestError, TableClient } from '@azure/data-tables';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { TABLE_NAMES } from './azure-repository.js';
import type { StorageConfig } from './config.js';
import { assertProductionSafeStorage } from './guardrails.js';

/**
 * Runtime settings shared across processes.
 *
 * A small set of operational switches that must be togglable at runtime from the admin inspector
 * and read by a *different* process — the think job — on its next scheduled run. They live in a
 * dedicated, namespaced partition of the existing `control` table, so no new table is required and
 * they never collide with the simulation's own control rows.
 *
 * This is the ONLY thing the inspector is permitted to write: its identity holds table-contributor
 * rights on `control` alone and reader everywhere else. The setter validates and writes exactly one
 * well-known row, so even the write path cannot be turned into a general-purpose table writer.
 */

const SETTINGS_TABLE = TABLE_NAMES.control;
const SETTINGS_PARTITION = 'runtime-settings';
const OPENAI_IO_ROW = 'openai-io-logging';

export interface RuntimeSettings {
  /**
   * Whether the think job writes raw Azure OpenAI request/response bodies to stdout. `undefined`
   * means "unset", so the reader keeps its own default (the `AUTOCOSM_LOG_OPENAI_IO` env value).
   */
  readonly logOpenAiIo?: boolean;
}

export interface SettingsStore {
  read(): Promise<RuntimeSettings>;
  setLogOpenAiIo(enabled: boolean): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof RestError && error.statusCode === 404;
}

class AzureSettingsStore implements SettingsStore {
  readonly #client: TableClient;

  constructor(endpoint: string, credential: TokenCredential) {
    this.#client = new TableClient(endpoint.replace(/\/+$/u, ''), SETTINGS_TABLE, credential);
  }

  async read(): Promise<RuntimeSettings> {
    try {
      const entity = await this.#client.getEntity<{ enabled?: boolean }>(
        SETTINGS_PARTITION,
        OPENAI_IO_ROW,
      );
      return typeof entity.enabled === 'boolean' ? { logOpenAiIo: entity.enabled } : {};
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
  }

  async setLogOpenAiIo(enabled: boolean): Promise<void> {
    await this.#client.upsertEntity(
      { partitionKey: SETTINGS_PARTITION, rowKey: OPENAI_IO_ROW, enabled },
      'Replace',
    );
  }
}

/** Process-local store for the in-memory driver — local development and tests only. */
class MemorySettingsStore implements SettingsStore {
  #logOpenAiIo: boolean | undefined;

  async read(): Promise<RuntimeSettings> {
    return this.#logOpenAiIo === undefined ? {} : { logOpenAiIo: this.#logOpenAiIo };
  }

  async setLogOpenAiIo(enabled: boolean): Promise<void> {
    this.#logOpenAiIo = enabled;
  }
}

export function createSettingsStore(config: StorageConfig): SettingsStore {
  if (config.driver === 'memory') return new MemorySettingsStore();

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
  return new AzureSettingsStore(endpoint, credential);
}
