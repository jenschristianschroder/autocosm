import {
  ACTION_PROPOSAL_VERSION,
  ActionProposalSchema,
  AgentActionSchema,
  type ActionProposal,
  type AgentAction,
  type Observation,
  type PendingDecision,
} from '@autocosm/domain';

/**
 * The boundary between the authoritative simulation and any model.
 *
 * A provider is handed a bounded observation and returns a *proposal*. It has no access to
 * storage, the network beyond its own model endpoint, the filesystem, or the world. Whatever it
 * returns is untrusted until the simulation re-validates capabilities, ranges, costs and
 * preconditions in `resolve.ts`.
 */
export interface DecisionProvider {
  /** Stable provider identifier recorded on every proposal for audit. */
  readonly name: string;
  /** True when the provider can serve a request right now. */
  isAvailable(): boolean;
  propose(request: DecisionRequest): Promise<ActionProposal>;
}

export interface DecisionRequest {
  readonly decisionId: string;
  readonly observation: Observation;
  readonly reason: string;
  /** Wall-clock budget for this single proposal. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export function requestFromDecision(
  decision: PendingDecision,
  timeoutMs: number,
  signal?: AbortSignal,
): DecisionRequest {
  return {
    decisionId: decision.id,
    observation: decision.observation,
    reason: decision.reason,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  };
}

/** Raised when a configured provider fails. Never swallowed into a silent fallback. */
export class DecisionProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;

  constructor(provider: string, message: string, retryable: boolean, options?: ErrorOptions) {
    super(`${provider}: ${message}`, options);
    this.name = 'DecisionProviderError';
    this.provider = provider;
    this.retryable = retryable;
  }
}

/** Raised when model output does not satisfy the versioned proposal contract. */
export class ProposalRejected extends Error {
  readonly provider: string;
  readonly detail: string;

  constructor(provider: string, detail: string) {
    super(`${provider} returned an unusable proposal: ${detail}`);
    this.name = 'ProposalRejected';
    this.provider = provider;
    this.detail = detail;
  }
}

/** Longest rationale we keep; anything longer is truncated rather than rejected. */
export const MAX_RATIONALE_CHARS = 180;

/**
 * Parse untrusted provider output into a proposal.
 *
 * This is a *shape* gate only. It proves the text is a well-formed action of a type the organism
 * is currently allowed to attempt. It deliberately does not check range, cost, ownership or
 * visibility — those belong to the simulation, which is the only authority on the world.
 */
export function parseProposal(
  provider: string,
  raw: unknown,
  observation: Observation,
): { action: AgentAction; rationale: string } {
  const candidate = typeof raw === 'string' ? safeJson(provider, raw) : raw;

  const parsed = ActionProposalSchema.safeParse(normaliseVersion(candidate));
  if (!parsed.success) {
    throw new ProposalRejected(provider, summariseIssues(parsed.error.issues));
  }

  const allowed = new Set(observation.availableActions);
  if (!allowed.has(parsed.data.action.type)) {
    throw new ProposalRejected(
      provider,
      `action "${parsed.data.action.type}" is not in availableActions`,
    );
  }

  return {
    action: parsed.data.action,
    rationale: parsed.data.rationale.slice(0, MAX_RATIONALE_CHARS),
  };
}

/**
 * Accept a proposal that omits `version`, since a model that otherwise produced a valid action
 * should not fail on a constant we already know. Any *wrong* version still fails.
 */
function normaliseVersion(candidate: unknown): unknown {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return candidate;
  }
  const record = candidate as Record<string, unknown>;
  if (record['version'] === undefined) {
    return { ...record, version: ACTION_PROPOSAL_VERSION };
  }
  return record;
}

function safeJson(provider: string, text: string): unknown {
  const trimmed = extractJsonObject(text);
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    throw new ProposalRejected(
      provider,
      `output was not JSON (${cause instanceof Error ? cause.message : 'parse error'})`,
    );
  }
}

/** Tolerate a fenced code block or surrounding prose without ever executing model text. */
function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return body.trim();
  return body.slice(start, end + 1);
}

function summariseIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Assemble the audit record stored alongside a decision. Hidden reasoning is never included. */
export function toProposal(input: {
  provider: string;
  model?: string;
  action: AgentAction;
  rationale: string;
  startedAtEpochMs: number;
  nowEpochMs: number;
  promptTokens?: number;
  completionTokens?: number;
}): ActionProposal {
  return {
    version: ACTION_PROPOSAL_VERSION,
    action: AgentActionSchema.parse(input.action),
    rationale: input.rationale.slice(0, MAX_RATIONALE_CHARS),
    provider: input.provider,
    ...(input.model === undefined ? {} : { model: input.model }),
    proposedAtEpochMs: input.nowEpochMs,
    latencyMs: Math.max(0, input.nowEpochMs - input.startedAtEpochMs),
    ...(input.promptTokens === undefined ? {} : { promptTokens: input.promptTokens }),
    ...(input.completionTokens === undefined ? {} : { completionTokens: input.completionTokens }),
  };
}
