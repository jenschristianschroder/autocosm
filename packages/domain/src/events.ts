import { z } from 'zod';
import type {
  AgentId,
  EventId,
  LineageId,
  MaterialId,
  OrganismId,
  RegionId,
  ResourceNodeId,
  StructureId,
  WorldId,
} from './ids.js';
import type { AgentActionType, RejectionReason } from './actions.js';
import type { DeathCause, PressureKind, SignalChannel } from './entities.js';
import type { StructureFunctionId, StructurePattern } from './structures.js';
import type { TraitId } from './traits.js';
import type { TickIndex } from './units.js';

/**
 * The append-only world history.
 *
 * Events are compact, versioned, attributable and idempotent. Event identifiers are a pure
 * function of `(worldId, tick, ordinal)`, so replaying a tick rewrites the same rows rather
 * than duplicating history. Hidden model reasoning is never stored.
 */
export const WORLD_EVENT_VERSION = 1;

export type WorldEventKind =
  | 'agentCreated'
  | 'organismBorn'
  | 'organismDied'
  | 'organismMigrated'
  | 'organismFed'
  | 'organismAttacked'
  | 'energyShared'
  | 'signalEmitted'
  | 'traitExpressed'
  | 'materialCollected'
  | 'materialDiscovered'
  | 'materialCombined'
  | 'structureBuilt'
  | 'structureUsed'
  | 'structureDamaged'
  | 'structureRepaired'
  | 'structureRepurposed'
  | 'structureCollapsed'
  | 'knowledgeShared'
  | 'goalSubmitted'
  | 'goalConsidered'
  | 'environmentalPressure'
  | 'decisionRequested'
  | 'decisionResolved'
  | 'actionRejected'
  | 'lineageExtinct'
  | 'lineageFounded';

export interface WorldEventBase {
  readonly id: EventId;
  readonly version: number;
  readonly worldId: WorldId;
  readonly regionId: RegionId;
  readonly tick: TickIndex;
  /** Position of the event within its tick. Guarantees a total order for replay. */
  readonly ordinal: number;
  readonly kind: WorldEventKind;
  readonly agentId?: AgentId;
  readonly lineageId?: LineageId;
  readonly organismId?: OrganismId;
  /** Links an event to the decision or request that caused it. */
  readonly causationId?: string;
  readonly correlationId?: string;
  /** Short, human-readable summary. Bounded; never contains model reasoning. */
  readonly summary: string;
}

export const MAX_EVENT_SUMMARY_LENGTH = 180;

export interface EventPayloads {
  agentCreated: { readonly name: string; readonly aspiration: string };
  organismBorn: { readonly parentOrganismId?: OrganismId; readonly generation: number };
  organismDied: { readonly cause: DeathCause; readonly ageTicks: number };
  organismMigrated: { readonly fromRegionId: RegionId; readonly toRegionId: RegionId };
  organismFed: { readonly materialId?: MaterialId; readonly energyGained: number };
  organismAttacked: {
    readonly targetOrganismId: OrganismId;
    readonly damage: number;
    readonly lethal: boolean;
  };
  energyShared: { readonly targetOrganismId: OrganismId; readonly energy: number };
  signalEmitted: {
    readonly channel: SignalChannel;
    readonly intensity: number;
    readonly radiusCu: number;
  };
  traitExpressed: { readonly traitId: string; readonly emphasis: number };
  materialCollected: {
    readonly materialId: MaterialId;
    readonly label: string;
    readonly quantity: number;
    readonly resourceNodeId: ResourceNodeId;
    /** Units left in the node afterwards, so depletion is legible without a second lookup. */
    readonly remaining: number;
  };
  materialDiscovered: { readonly materialId: MaterialId };
  materialCombined: {
    readonly materialId: MaterialId;
    readonly label: string;
    readonly componentIds: readonly MaterialId[];
  };
  structureBuilt: {
    readonly structureId: StructureId;
    readonly pattern: StructurePattern;
    readonly functions: readonly StructureFunctionId[];
  };
  structureUsed: { readonly structureId: StructureId; readonly functionId: StructureFunctionId };
  structureDamaged: { readonly structureId: StructureId; readonly integrity: number };
  structureRepaired: {
    readonly structureId: StructureId;
    readonly integrity: number;
    readonly restored: number;
  };
  structureRepurposed: {
    readonly structureId: StructureId;
    readonly pattern: StructurePattern;
    readonly functions: readonly StructureFunctionId[];
  };
  structureCollapsed: { readonly structureId: StructureId };
  knowledgeShared: {
    readonly recipeKey: string;
    readonly recipeLabel: string;
    readonly toLineageIds: readonly LineageId[];
  };
  goalSubmitted: { readonly goalId: string; readonly text: string };
  goalConsidered: {
    readonly goalId: string;
    readonly outcome: 'adopted' | 'deferred' | 'rejected' | 'fulfilled';
  };
  environmentalPressure: {
    readonly pressure: PressureKind;
    readonly severity: number;
    readonly endsAtTick: TickIndex;
  };
  decisionRequested: { readonly decisionId: string; readonly reason: string };
  decisionResolved: {
    readonly decisionId: string;
    readonly actionType: AgentActionType;
    readonly provider: string;
    readonly accepted: boolean;
  };
  actionRejected: { readonly actionType: AgentActionType; readonly reason: RejectionReason };
  lineageExtinct: { readonly generations: number; readonly lifespanTicks: number };
  /**
   * A lineage divided: a newborn drifted far enough from its lineage's mean genome to found one
   * of its own. `divergence` is the mean absolute genome distance that triggered it, and
   * `traitId` the trait that drifted furthest — which is what the new lineage is named for.
   */
  lineageFounded: {
    readonly parentLineageId: string;
    readonly divergence: number;
    readonly traitId: TraitId;
  };
}

export type WorldEvent = {
  [K in WorldEventKind]: WorldEventBase & { readonly kind: K; readonly payload: EventPayloads[K] };
}[WorldEventKind];

/** Deterministic event identifier. Replaying a tick regenerates identical identifiers. */
export function eventIdFor(worldId: string, tick: TickIndex, ordinal: number): string {
  return `e-${worldId}-${String(tick).padStart(10, '0')}-${String(ordinal).padStart(5, '0')}`;
}

/** Runtime schema for stored and transported events. */
export const WorldEventSchema = z.object({
  id: z.string().min(1).max(96),
  version: z.number().int().min(1).max(WORLD_EVENT_VERSION),
  worldId: z.string().min(1).max(64),
  regionId: z.string().min(1).max(64),
  tick: z.number().int().min(0),
  ordinal: z.number().int().min(0).max(1_000_000),
  kind: z.string().min(1).max(48),
  agentId: z.string().max(64).optional(),
  lineageId: z.string().max(64).optional(),
  organismId: z.string().max(64).optional(),
  causationId: z.string().max(96).optional(),
  correlationId: z.string().max(96).optional(),
  summary: z.string().max(MAX_EVENT_SUMMARY_LENGTH),
  payload: z.record(z.string(), z.unknown()),
});

export type StoredWorldEvent = z.infer<typeof WorldEventSchema>;

/** Truncate a summary to the bounded length without splitting surrogate pairs awkwardly. */
export function boundSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_EVENT_SUMMARY_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_EVENT_SUMMARY_LENGTH - 1)}…`;
}
