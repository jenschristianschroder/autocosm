/**
 * Branded identifier types.
 *
 * Identifiers are opaque domain strings. They never encode Azure resource topology,
 * partition keys or row keys, so they are safe to place in public API responses.
 */

/**
 * The brand carrier.
 *
 * Exported as a declaration only so branded types remain nameable in emitted `.d.ts` files.
 * It has no runtime value and must never be imported as a value.
 */
export declare const brand: unique symbol;

export type Branded<T extends string> = string & { readonly [brand]: T };

export type WorldId = Branded<'WorldId'>;
export type RegionId = Branded<'RegionId'>;
export type AgentId = Branded<'AgentId'>;
export type LineageId = Branded<'LineageId'>;
export type OrganismId = Branded<'OrganismId'>;
export type MaterialId = Branded<'MaterialId'>;
export type ResourceNodeId = Branded<'ResourceNodeId'>;
export type StructureId = Branded<'StructureId'>;
export type MemoryId = Branded<'MemoryId'>;
export type GoalId = Branded<'GoalId'>;
export type DecisionId = Branded<'DecisionId'>;
export type EventId = Branded<'EventId'>;
export type CreatorId = Branded<'CreatorId'>;
export type CorrelationId = Branded<'CorrelationId'>;

/** Characters permitted in every Autocosm identifier. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/**
 * Narrow an untrusted string into a branded identifier.
 *
 * Validation happens immediately before the cast, which is the only place the codebase
 * permits an identifier assertion.
 */
export function asId<T extends string>(value: string): Branded<T> {
  if (!isValidId(value)) {
    throw new RangeError(`Invalid identifier: ${JSON.stringify(value.slice(0, 80))}`);
  }
  return value as Branded<T>;
}

export const asWorldId = (v: string): WorldId => asId<'WorldId'>(v);
export const asRegionId = (v: string): RegionId => asId<'RegionId'>(v);
export const asAgentId = (v: string): AgentId => asId<'AgentId'>(v);
export const asLineageId = (v: string): LineageId => asId<'LineageId'>(v);
export const asOrganismId = (v: string): OrganismId => asId<'OrganismId'>(v);
export const asMaterialId = (v: string): MaterialId => asId<'MaterialId'>(v);
export const asResourceNodeId = (v: string): ResourceNodeId => asId<'ResourceNodeId'>(v);
export const asStructureId = (v: string): StructureId => asId<'StructureId'>(v);
export const asMemoryId = (v: string): MemoryId => asId<'MemoryId'>(v);
export const asGoalId = (v: string): GoalId => asId<'GoalId'>(v);
export const asDecisionId = (v: string): DecisionId => asId<'DecisionId'>(v);
export const asEventId = (v: string): EventId => asId<'EventId'>(v);
export const asCreatorId = (v: string): CreatorId => asId<'CreatorId'>(v);
export const asCorrelationId = (v: string): CorrelationId => asId<'CorrelationId'>(v);

/**
 * Port for identifier generation.
 *
 * The simulation only ever uses {@link DeterministicIdFactory}; non-deterministic
 * identifier sources are confined to request handling at the API edge.
 */
export interface IdFactory {
  /** Produce the next identifier for the supplied logical namespace. */
  next(namespace: string): string;
}

/**
 * Deterministic identifier factory used by the tick engine.
 *
 * Identifiers are a pure function of `(worldId, tick, namespace, ordinal)`, so replaying a
 * tick regenerates exactly the same identifiers and event writes stay idempotent.
 */
export class DeterministicIdFactory implements IdFactory {
  readonly #prefix: string;
  readonly #counters = new Map<string, number>();

  constructor(worldId: string, tick: TickLike) {
    this.#prefix = `${worldId}-${String(tick).padStart(10, '0')}`;
  }

  next(namespace: string): string {
    const current = this.#counters.get(namespace) ?? 0;
    this.#counters.set(namespace, current + 1);
    return `${namespace}-${this.#prefix}-${current.toString(36).padStart(4, '0')}`;
  }
}

type TickLike = number;
