import {
  asEventId,
  boundSummary,
  eventIdFor,
  WORLD_EVENT_VERSION,
  type AgentId,
  type EventPayloads,
  type LineageId,
  type OrganismId,
  type RegionId,
  type WorldEvent,
  type WorldEventKind,
  type WorldId,
} from '@autocosm/domain';

/**
 * Deterministic event emission.
 *
 * Ordinals increase within a tick and identifiers are a pure function of
 * `(worldId, tick, ordinal)`. Replaying a tick therefore rewrites exactly the same rows
 * instead of appending duplicates, which is what makes tick execution idempotent.
 */
export interface EmitOptions<K extends WorldEventKind> {
  readonly summary: string;
  readonly payload: EventPayloads[K];
  readonly agentId?: AgentId;
  readonly lineageId?: LineageId;
  readonly organismId?: OrganismId;
  readonly causationId?: string;
  readonly correlationId?: string;
}

export class EventSink {
  readonly #worldId: WorldId;
  readonly #tick: number;
  readonly #events: WorldEvent[] = [];
  readonly #limit: number;
  #ordinal = 0;
  #dropped = 0;

  constructor(worldId: WorldId, tick: number, limit = 4000) {
    this.#worldId = worldId;
    this.#tick = tick;
    this.#limit = limit;
  }

  emit<K extends WorldEventKind>(kind: K, regionId: RegionId, options: EmitOptions<K>): void {
    if (this.#events.length >= this.#limit) {
      this.#dropped += 1;
      return;
    }
    const ordinal = this.#ordinal;
    this.#ordinal += 1;
    const base = {
      id: asEventId(eventIdFor(this.#worldId, this.#tick, ordinal)),
      version: WORLD_EVENT_VERSION,
      worldId: this.#worldId,
      regionId,
      tick: this.#tick,
      ordinal,
      kind,
      summary: boundSummary(options.summary),
      payload: options.payload,
      ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
      ...(options.organismId === undefined ? {} : { organismId: options.organismId }),
      ...(options.causationId === undefined ? {} : { causationId: options.causationId }),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    };
    this.#events.push(base as WorldEvent);
  }

  /** Events produced this tick, in emission order. */
  drain(): readonly WorldEvent[] {
    return this.#events;
  }

  /** Count of events discarded because the per-tick bound was reached. */
  get droppedCount(): number {
    return this.#dropped;
  }
}
