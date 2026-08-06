import type {
  AgentDetailResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  CreatorIdentityResponse,
  EventHistoryResponse,
  GlossaryResponse,
  LineageDetailResponse,
  OrganismDetailResponse,
  SnapshotResponse,
  StructureDetailResponse,
  SubmitGoalResponse,
  WorldMetaResponse,
} from '@autocosm/domain';

/**
 * Typed client for `/api/v1`.
 *
 * Two things matter here. First, the client is read-mostly: exactly two methods mutate anything,
 * and both are authoring requests rather than world manipulation. Second, snapshots are polled
 * with an ETag so an unchanged world costs a 304 and no payload — this is the whole reason the
 * deployment needs no websockets.
 */

const BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly string[];

  constructor(status: number, code: string, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface Cached<T> {
  readonly value: T;
  readonly etag?: string;
  readonly unchanged: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function toError(response: Response): Promise<ApiError> {
  let code = 'unknown';
  let message = `request failed with status ${response.status}`;
  let details: string[] = [];
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: string[] };
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    details = body.error?.details ?? [];
  } catch {
    // A non-JSON error body is still an error; the status alone is enough to report.
  }
  return new ApiError(response.status, code, message, details);
}

export async function fetchWorldMeta(): Promise<WorldMetaResponse> {
  return request<WorldMetaResponse>('/world');
}

/** Conditional snapshot fetch. A 304 returns the previous value untouched. */
export async function fetchSnapshot(
  options: { regionId?: string; radius?: number; etag?: string; previous?: SnapshotResponse } = {},
): Promise<Cached<SnapshotResponse>> {
  const query = new URLSearchParams();
  if (options.regionId !== undefined) query.set('regionId', options.regionId);
  if (options.radius !== undefined) query.set('radius', String(options.radius));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  const response = await fetch(`${BASE}/snapshot${suffix}`, {
    headers: {
      Accept: 'application/json',
      ...(options.etag === undefined ? {} : { 'If-None-Match': options.etag }),
    },
    credentials: 'same-origin',
  });

  if (response.status === 304 && options.previous) {
    return { value: options.previous, unchanged: true, ...tagOf(options.etag) };
  }
  if (!response.ok) throw await toError(response);

  const value = (await response.json()) as SnapshotResponse;
  return { value, unchanged: false, ...tagOf(response.headers.get('ETag') ?? undefined) };
}

function tagOf(etag: string | undefined): { etag?: string } {
  return etag === undefined ? {} : { etag };
}

export async function fetchAgent(agentId: string): Promise<AgentDetailResponse> {
  return request<AgentDetailResponse>(`/agents/${encodeURIComponent(agentId)}`);
}

export async function fetchOrganism(organismId: string): Promise<OrganismDetailResponse> {
  return request<OrganismDetailResponse>(`/organisms/${encodeURIComponent(organismId)}`);
}

export async function fetchLineage(
  lineageId: string,
  cursor?: string,
): Promise<LineageDetailResponse> {
  const suffix = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return request<LineageDetailResponse>(`/lineages/${encodeURIComponent(lineageId)}${suffix}`);
}

export async function fetchStructure(structureId: string): Promise<StructureDetailResponse> {
  return request<StructureDetailResponse>(`/structures/${encodeURIComponent(structureId)}`);
}

/**
 * The glossary never changes while the page is open, so fetch it once and share the promise.
 *
 * A failed fetch is not cached, so a transient error does not permanently strip explanations from
 * the UI for the rest of the session.
 */
let glossaryPromise: Promise<GlossaryResponse> | undefined;
export async function fetchGlossary(): Promise<GlossaryResponse> {
  glossaryPromise ??= request<GlossaryResponse>('/glossary').catch((cause: unknown) => {
    glossaryPromise = undefined;
    throw cause;
  });
  return glossaryPromise;
}

export async function fetchEvents(
  options: { regionId?: string; agentId?: string; limit?: number; cursor?: string } = {},
): Promise<EventHistoryResponse> {
  const query = new URLSearchParams();
  if (options.regionId !== undefined) query.set('regionId', options.regionId);
  if (options.agentId !== undefined) query.set('agentId', options.agentId);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<EventHistoryResponse>(`/events${suffix}`);
}

export async function fetchIdentity(): Promise<CreatorIdentityResponse> {
  return request<CreatorIdentityResponse>('/creator');
}

/**
 * The first of exactly two mutations a human may perform.
 *
 * The idempotency key means a double submit from a flaky connection authors one lineage, not two.
 */
export async function createAgent(
  body: CreateAgentRequest,
  idempotencyKey: string,
): Promise<CreateAgentResponse> {
  return request<CreateAgentResponse>('/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** The second mutation: a broad motivation the agent is free to reinterpret or reject. */
export async function submitGoal(
  agentId: string,
  text: string,
  idempotencyKey: string,
): Promise<SubmitGoalResponse> {
  return request<SubmitGoalResponse>(`/agents/${encodeURIComponent(agentId)}/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ text }),
  });
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
