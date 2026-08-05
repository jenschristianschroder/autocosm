/**
 * Storage guardrails.
 *
 * These are the code-side half of the non-negotiable security posture; the other half lives in
 * Bicep. Infrastructure can be edited by hand, so the application refuses to start in a
 * configuration that would require Shared Key, a connection string, or a SAS token.
 *
 * The only permitted production credential is a workload managed identity.
 */

export type StorageAuthMode = 'managedIdentity' | 'localEmulator';

export interface StorageGuardInput {
  readonly mode: StorageAuthMode;
  readonly isProduction: boolean;
  readonly tableEndpoint: string;
  /** Present only in local mode. Rejected outright in production. */
  readonly connectionString?: string | undefined;
}

export class InsecureStorageConfiguration extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureStorageConfiguration';
  }
}

const SECRET_MARKERS = [
  'accountkey=',
  'sharedaccesssignature',
  'sig=',
  'defaultendpointsprotocol=',
  '?sv=',
  'se=',
];

/**
 * Fail closed on any credential material that is not a managed identity.
 *
 * Called at startup by every workload that touches storage. Throwing here is deliberate: a
 * degraded-but-running process that silently authenticated with a shared key would be worse
 * than a crash loop that is immediately visible.
 */
export function assertProductionSafeStorage(input: StorageGuardInput): void {
  const endpoint = input.tableEndpoint.trim();
  if (endpoint === '') {
    throw new InsecureStorageConfiguration('Table endpoint is required');
  }

  const lowerEndpoint = endpoint.toLowerCase();
  for (const marker of SECRET_MARKERS) {
    if (lowerEndpoint.includes(marker)) {
      throw new InsecureStorageConfiguration(
        'Table endpoint contains credential material. Use a bare https://<account>.table.core.windows.net endpoint with managed identity.',
      );
    }
  }

  if (!input.isProduction) {
    if (input.mode === 'localEmulator') return;
  }

  if (input.mode === 'localEmulator') {
    throw new InsecureStorageConfiguration(
      'The local storage emulator is not permitted in production. Set AUTOCOSM_STORAGE_AUTH=managedIdentity.',
    );
  }

  if (input.connectionString !== undefined && input.connectionString.trim() !== '') {
    throw new InsecureStorageConfiguration(
      'A storage connection string was supplied in production. Shared Key and SAS authorisation are disabled by policy.',
    );
  }

  if (!lowerEndpoint.startsWith('https://')) {
    throw new InsecureStorageConfiguration('Production table endpoint must use HTTPS');
  }

  if (!lowerEndpoint.includes('.table.')) {
    throw new InsecureStorageConfiguration(
      'Production table endpoint must be the Table service endpoint for the storage account',
    );
  }
}
