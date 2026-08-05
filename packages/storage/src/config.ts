import { z } from 'zod';
import { InMemoryWorldRepository } from './memory-repository.js';
import { AzureTableWorldRepository } from './azure-repository.js';
import { assertProductionSafeStorage } from './guardrails.js';
import type { WorldRepository } from './ports.js';

/**
 * Storage selection, validated once at startup.
 *
 * There are exactly two supported drivers. `memory` is for the local demo and tests. `azureTables`
 * is managed-identity only. There is deliberately no connection-string or shared-key driver, so no
 * amount of environment configuration can produce one.
 */

export const STORAGE_DRIVERS = ['memory', 'azureTables'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export const StorageConfigSchema = z
  .object({
    driver: z.enum(STORAGE_DRIVERS).default('memory'),
    /** Bare `https://<account>.table.core.windows.net`. Never a SAS or connection string. */
    tableEndpoint: z.string().max(300).optional(),
    managedIdentityClientId: z.string().min(1).max(64).optional(),
    isProduction: z.boolean().default(false),
  })
  .superRefine((config, ctx) => {
    if (config.driver === 'azureTables' && !config.tableEndpoint) {
      ctx.addIssue({
        code: 'custom',
        path: ['tableEndpoint'],
        message: 'AZURE_TABLE_ENDPOINT is required when AUTOCOSM_STORAGE_DRIVER=azureTables',
      });
    }
    if (config.driver === 'memory' && config.isProduction) {
      ctx.addIssue({
        code: 'custom',
        path: ['driver'],
        message: 'The in-memory repository is a local-development driver and loses all state',
      });
    }
  });

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export function createRepository(config: StorageConfig): WorldRepository {
  if (config.driver === 'memory') return new InMemoryWorldRepository();

  const tableEndpoint = config.tableEndpoint ?? '';
  assertProductionSafeStorage({
    mode: 'managedIdentity',
    isProduction: config.isProduction,
    tableEndpoint,
  });

  return new AzureTableWorldRepository({
    tableEndpoint,
    isProduction: config.isProduction,
    ...(config.managedIdentityClientId === undefined
      ? {}
      : { managedIdentityClientId: config.managedIdentityClientId }),
  });
}
