import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { AzureOpenAI } from 'openai';
import type { ActionProposal } from '@autocosm/domain';
import {
  DecisionProviderError,
  parseProposal,
  toProposal,
  type DecisionProvider,
  type DecisionRequest,
} from './ports.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

/**
 * Azure OpenAI decision provider.
 *
 * Authentication is managed identity only — there is no API-key path, so a key cannot be
 * introduced by configuration drift. Endpoint and deployment name are configuration, not secrets.
 *
 * On failure this throws. It never silently degrades to the heuristic policy: a configured but
 * broken model must surface as an explicit degraded state (see `ResilientDecisionProvider`), so
 * that operators can tell "AI is off" apart from "AI is quietly failing".
 */

const AZURE_COGNITIVE_SCOPE = 'https://cognitiveservices.azure.com/.default';

/**
 * A single raw model-IO event, handed to an optional recorder.
 *
 * This is the one place the system can surface *unredacted* prompt and response text. It exists
 * only for deliberate, opt-in debugging: the shared structured logger intentionally redacts
 * prompts and reasoning, so a caller that wants the raw bytes must provide a recorder and accept
 * responsibility for where they go. The provider never bounds, stores or ships these itself.
 */
export interface ModelIoLogEntry {
  readonly phase: 'request' | 'response' | 'error';
  readonly decisionId: string;
  readonly deployment: string;
  readonly reason: string;
  readonly systemPrompt?: string;
  readonly userPrompt?: string;
  readonly responseText?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly errorMessage?: string;
}

export interface AzureOpenAIProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiVersion: string;
  /** Explicit workload identity client id, so credential selection is never ambiguous. */
  readonly managedIdentityClientId?: string;
  readonly maxCompletionTokens: number;
  readonly maxRetries: number;
  readonly now?: () => number;
  /** Injectable for tests; production always builds a managed-identity client. */
  readonly client?: MinimalChatClient;
  /**
   * Optional sink for raw request/response bodies. Absent by default, so nothing is emitted.
   * Wired only when `AUTOCOSM_LOG_OPENAI_IO=true`. See `ModelIoLogEntry`.
   */
  readonly recordModelIo?: (entry: ModelIoLogEntry) => void;
}

/** The narrow slice of the OpenAI client this provider uses, so tests need no network. */
export interface MinimalChatClient {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          messages: readonly { role: 'system' | 'user'; content: string }[];
          max_completion_tokens: number;
          response_format: { type: 'json_object' };
        },
        options?: { signal?: AbortSignal },
      ): Promise<{
        choices: readonly { message?: { content?: string | null } | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      }>;
    };
  };
}

export class AzureOpenAIDecisionProvider implements DecisionProvider {
  readonly name = 'azure-openai';
  readonly #options: AzureOpenAIProviderOptions;
  readonly #now: () => number;
  readonly #recordModelIo: ((entry: ModelIoLogEntry) => void) | undefined;
  #client: MinimalChatClient | undefined;

  constructor(options: AzureOpenAIProviderOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#client = options.client;
    this.#recordModelIo = options.recordModelIo;
    if (options.endpoint.includes('api-key') || /[?&]sig=/u.test(options.endpoint)) {
      throw new Error('Azure OpenAI endpoint must not embed credentials');
    }
  }

  isAvailable(): boolean {
    return this.#options.endpoint.length > 0 && this.#options.deployment.length > 0;
  }

  async propose(request: DecisionRequest): Promise<ActionProposal> {
    const startedAtEpochMs = this.#now();
    const client = this.#resolveClient();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);
    request.signal?.addEventListener('abort', () => {
      controller.abort();
    });

    const userPrompt = buildUserPrompt(request.observation, request.reason);
    this.#recordModelIo?.({
      phase: 'request',
      decisionId: request.decisionId,
      deployment: this.#options.deployment,
      reason: request.reason,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
    });

    try {
      const completion = await client.chat.completions.create(
        {
          model: this.#options.deployment,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_completion_tokens: this.#options.maxCompletionTokens,
          response_format: { type: 'json_object' },
        },
        { signal: controller.signal },
      );

      const content = completion.choices[0]?.message?.content ?? '';
      const usage = completion.usage ?? undefined;
      this.#recordModelIo?.({
        phase: 'response',
        decisionId: request.decisionId,
        deployment: this.#options.deployment,
        reason: request.reason,
        responseText: content,
        ...(usage?.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
        ...(usage?.completion_tokens === undefined
          ? {}
          : { completionTokens: usage.completion_tokens }),
      });
      if (content.trim().length === 0) {
        throw new DecisionProviderError(this.name, 'model returned an empty completion', true);
      }

      const { action, rationale } = parseProposal(this.name, content, request.observation);
      return toProposal({
        provider: this.name,
        model: this.#options.deployment,
        action,
        rationale,
        startedAtEpochMs,
        nowEpochMs: this.#now(),
        ...(usage?.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
        ...(usage?.completion_tokens === undefined
          ? {}
          : { completionTokens: usage.completion_tokens }),
      });
    } catch (cause) {
      this.#recordModelIo?.({
        phase: 'error',
        decisionId: request.decisionId,
        deployment: this.#options.deployment,
        reason: request.reason,
        errorMessage: describe(cause),
      });
      if (cause instanceof DecisionProviderError) throw cause;
      if (isProposalRejection(cause)) throw cause;
      throw new DecisionProviderError(this.name, describe(cause), isRetryable(cause), {
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #resolveClient(): MinimalChatClient {
    if (this.#client) return this.#client;
    const credential = new DefaultAzureCredential(
      this.#options.managedIdentityClientId === undefined
        ? {}
        : { managedIdentityClientId: this.#options.managedIdentityClientId },
    );
    const client = new AzureOpenAI({
      endpoint: this.#options.endpoint,
      apiVersion: this.#options.apiVersion,
      deployment: this.#options.deployment,
      azureADTokenProvider: getBearerTokenProvider(credential, AZURE_COGNITIVE_SCOPE),
      maxRetries: this.#options.maxRetries,
    });
    this.#client = client as unknown as MinimalChatClient;
    return this.#client;
  }
}

function isProposalRejection(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'ProposalRejected';
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return 'unknown provider failure';
}

/** 408/429/5xx and aborts are worth another attempt later; 4xx configuration errors are not. */
function isRetryable(cause: unknown): boolean {
  const status = (cause as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  if (cause instanceof Error && cause.name === 'AbortError') return true;
  return true;
}
