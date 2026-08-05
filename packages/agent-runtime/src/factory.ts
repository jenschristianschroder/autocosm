import { z } from 'zod';
import { AzureOpenAIDecisionProvider } from './azure-openai-provider.js';
import { HeuristicDecisionProvider } from './heuristic-provider.js';
import type { DecisionProvider } from './ports.js';

/**
 * Provider selection.
 *
 * `heuristic` is the default so the repository builds, tests and runs with no cloud account.
 * `azure-openai` is opt-in and, once selected, is never silently replaced: if it is chosen but
 * misconfigured, construction fails loudly at startup rather than at 3am on a schedule.
 */

export const DECISION_PROVIDERS = ['heuristic', 'azure-openai'] as const;
export type DecisionProviderKind = (typeof DECISION_PROVIDERS)[number];

export const DecisionProviderConfigSchema = z.object({
  kind: z.enum(DECISION_PROVIDERS).default('heuristic'),
  azureOpenAiEndpoint: z.string().url().optional(),
  azureOpenAiDeployment: z.string().min(1).max(64).optional(),
  azureOpenAiApiVersion: z.string().min(1).max(32).default('2024-10-21'),
  managedIdentityClientId: z.string().min(1).max(64).optional(),
  maxCompletionTokens: z.number().int().min(32).max(4_096).default(320),
  maxRetries: z.number().int().min(0).max(5).default(1),
});

export type DecisionProviderConfig = z.infer<typeof DecisionProviderConfigSchema>;

export function createDecisionProvider(config: DecisionProviderConfig): DecisionProvider {
  if (config.kind === 'heuristic') return new HeuristicDecisionProvider();

  if (!config.azureOpenAiEndpoint || !config.azureOpenAiDeployment) {
    throw new Error(
      'AUTOCOSM_DECISION_PROVIDER=azure-openai requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT',
    );
  }

  return new AzureOpenAIDecisionProvider({
    endpoint: config.azureOpenAiEndpoint,
    deployment: config.azureOpenAiDeployment,
    apiVersion: config.azureOpenAiApiVersion,
    ...(config.managedIdentityClientId === undefined
      ? {}
      : { managedIdentityClientId: config.managedIdentityClientId }),
    maxCompletionTokens: config.maxCompletionTokens,
    maxRetries: config.maxRetries,
  });
}

/** True when a provider failure must surface as a degraded state instead of a quiet fallback. */
export function shouldFailClosed(config: DecisionProviderConfig): boolean {
  return config.kind !== 'heuristic';
}
