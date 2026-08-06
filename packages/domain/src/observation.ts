import { z } from 'zod';
import { AgentActionSchema, type AgentAction } from './actions.js';
import type { Position } from './geometry.js';
import { DRIVE_IDS, SIGNAL_CHANNELS } from './entities.js';
import type { Biome, DriveId, SignalChannel, Temperament } from './entities.js';
import { STRUCTURE_FUNCTIONS, STRUCTURE_PATTERNS } from './structures.js';
import type { StructureFunctionId, StructurePattern } from './structures.js';
import { asId, isValidId } from './ids.js';
import type {
  AgentId,
  DecisionId,
  LineageId,
  MaterialId,
  OrganismId,
  RegionId,
  ResourceNodeId,
  StructureId,
  WorldId,
} from './ids.js';
import type { PerMille, TickIndex } from './units.js';

/**
 * Bounded local observation supplied to a decision provider.
 *
 * This is the *only* world information an agent ever sees. Nothing global leaks in: no
 * world statistics, no other regions, no organisms outside perception radius, no hidden
 * traits of neighbours. Every list is capped so prompts stay bounded and cheap.
 */
export const MAX_OBSERVED_ORGANISMS = 8;
export const MAX_OBSERVED_RESOURCES = 8;
export const MAX_OBSERVED_STRUCTURES = 6;
export const MAX_OBSERVED_SIGNALS = 6;
export const MAX_OBSERVED_MEMORIES = 8;
export const MAX_OBSERVED_GOALS = 3;

export interface ObservedSelf {
  readonly organismId: OrganismId;
  readonly agentId: AgentId;
  readonly lineageId: LineageId;
  readonly position: Position;
  readonly regionId: RegionId;
  readonly energy: number;
  readonly maxEnergy: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly ageTicks: number;
  readonly maxAgeTicks: number;
  readonly mature: boolean;
  /**
   * Whether the reproductive refractory period has elapsed.
   *
   * An organism perceives its own body. Without this it cannot tell a cooldown from a
   * failure, so every policy — heuristic or model — spends the whole turn proposing a
   * reproduction the simulation is certain to refuse.
   */
  readonly reproductionReady: boolean;
  readonly generation: number;
  readonly inventory: readonly { readonly materialId: MaterialId; readonly quantity: number }[];
  /**
   * Total material the body can hold, in `mu`.
   *
   * An organism knows when its hands are full. Without this a policy cannot distinguish
   * "nothing left to pick up" from "nowhere left to put it", so it spends the turn proposing
   * a collection the simulation is certain to refuse.
   */
  readonly carryCapacity: number;
  /**
   * How many *distinct* materials the body can hold at once.
   *
   * Capacity and slots are separate limits: a nearly empty organism holding eight kinds of
   * material cannot accept a ninth. Both must be visible or the difference is unlearnable.
   */
  readonly inventorySlotLimit: number;
  readonly attachedStructureId?: StructureId | undefined;
  /** Effective, emergent deliberation capacity. Low values mean shallow reasoning. */
  readonly planning: PerMille;
  readonly manipulation: PerMille;
  readonly memorySlots: number;
  readonly speedCuPerTick: number;
  /**
   * Energy spent per 100 cu travelled. Paired with `speedCuPerTick` this makes the cost of a
   * step computable, so an organism can tell "too tired to walk" before spending the turn
   * discovering it.
   */
  readonly moveCostPer100Cu: number;
  readonly perceptionRadiusCu: number;
}

export interface ObservedOrganism {
  readonly organismId: OrganismId;
  readonly lineageId: LineageId;
  /** True when the observed organism belongs to the observer's own lineage. */
  readonly kin: boolean;
  readonly position: Position;
  readonly distanceCu: number;
  /** Coarse size band rather than exact traits: neighbours are not transparent. */
  readonly sizeBand: 'tiny' | 'small' | 'medium' | 'large';
  readonly threatBand: 'harmless' | 'wary' | 'dangerous';
  readonly healthBand: 'weak' | 'fair' | 'strong';
  /**
   * Coarse hunger, which is what `share` actually transfers.
   *
   * Health and energy are independent: a well-fed organism can be badly wounded. Judging
   * hunger by `healthBand` targets the injured, and the simulation then refuses the
   * transfer because their reserve is already full.
   */
  readonly energyBand: 'starving' | 'lean' | 'fed';
}

export interface ObservedResource {
  readonly resourceNodeId: ResourceNodeId;
  readonly materialId: MaterialId;
  readonly position: Position;
  readonly distanceCu: number;
  readonly quantity: number;
  readonly nutritionPerUnit: number;
  readonly known: boolean;
}

export interface ObservedStructure {
  readonly structureId: StructureId;
  readonly position: Position;
  readonly distanceCu: number;
  readonly pattern: StructurePattern;
  readonly integrity: PerMille;
  /** Derived functions, only visible once the observer has inspected or built it. */
  readonly functions: readonly StructureFunctionId[];
  readonly builtByOwnLineage: boolean;
  readonly inspected: boolean;
}

export interface ObservedSignal {
  readonly channel: SignalChannel;
  readonly fromLineageId: LineageId;
  readonly kin: boolean;
  readonly distanceCu: number;
  readonly intensity: PerMille;
  /** Identity of the taught recipe. Quote this back in a `teach` signal, never the label. */
  readonly recipeKey?: string | undefined;
  readonly recipeLabel?: string | undefined;
}

/** A recipe the observer already knows. `key` is the handle; `label` is only for comprehension. */
export interface ObservedRecipe {
  readonly key: string;
  readonly label: string;
}

export interface ObservedEnvironment {
  readonly biome: Biome;
  readonly lightPerMille: PerMille;
  readonly temperature: PerMille;
  readonly waterCoverage: PerMille;
  readonly biomass: number;
  readonly pressure: string;
  readonly pressureSeverity: PerMille;
}

export interface ObservedMemory {
  readonly kind: string;
  readonly note: string;
  readonly salience: PerMille;
  readonly ageTicks: number;
}

export interface ObservedGoal {
  readonly goalId: string;
  readonly text: string;
  readonly submittedAtTick: TickIndex;
}

export interface Observation {
  readonly version: 1;
  readonly worldId: WorldId;
  readonly tick: TickIndex;
  readonly self: ObservedSelf;
  readonly environment: ObservedEnvironment;
  readonly organisms: readonly ObservedOrganism[];
  readonly resources: readonly ObservedResource[];
  readonly structures: readonly ObservedStructure[];
  readonly signals: readonly ObservedSignal[];
  readonly memories: readonly ObservedMemory[];
  readonly goals: readonly ObservedGoal[];
  readonly drives: Readonly<Record<DriveId, PerMille>>;
  readonly temperament: Temperament;
  readonly aspiration: string;
  readonly knownRecipes: readonly ObservedRecipe[];
  /** Actions the organism's evolved capabilities currently permit. */
  readonly availableActions: readonly string[];
}

/** Why the simulation asked for a considered decision rather than acting reflexively. */
export const DECISION_REASONS = [
  'novelDiscovery',
  'newCreatorGoal',
  'reproductionStrategy',
  'constructionOpportunity',
  'socialConflict',
  'cooperationOpportunity',
  'environmentalShift',
  'starvationRisk',
] as const;

export type DecisionReason = (typeof DECISION_REASONS)[number];

export type DecisionStatus = 'pending' | 'claimed' | 'proposed' | 'applied' | 'expired' | 'failed';

export interface PendingDecision {
  readonly id: DecisionId;
  readonly worldId: WorldId;
  readonly agentId: AgentId;
  readonly lineageId: LineageId;
  readonly organismId: OrganismId;
  readonly regionId: RegionId;
  readonly createdAtTick: TickIndex;
  /** Decisions not resolved by this tick are discarded so the queue cannot grow forever. */
  readonly expiresAtTick: TickIndex;
  readonly reason: DecisionReason;
  readonly status: DecisionStatus;
  readonly observation: Observation;
  readonly claimedBy?: string;
  readonly claimExpiresAtEpochMs?: number;
  readonly proposal?: ActionProposal;
  readonly attempts: number;
}

export const ACTION_PROPOSAL_VERSION = 1;

/**
 * Runtime schema for a persisted observation.
 *
 * The simulation writes observations; the think job reads them back, potentially after a
 * deployment that changed the shape. Validating on read means a stale or corrupt row fails one
 * decision instead of feeding a model half-truths about the world.
 */
const perMille = z.number().int().min(0).max(1_000);
const positionSchema = z.object({ x: z.number().finite(), z: z.number().finite() });
const boundedText = (max: number) => z.string().max(max);
/** Validates the identifier pattern *before* branding, so the cast is never unchecked. */
const brandedId = <T extends string>() =>
  z
    .string()
    .max(64)
    .refine(isValidId, 'invalid identifier')
    .transform((value) => asId<T>(value));

const observedSelfSchema = z.object({
  organismId: brandedId<'OrganismId'>(),
  agentId: brandedId<'AgentId'>(),
  lineageId: brandedId<'LineageId'>(),
  position: positionSchema,
  regionId: brandedId<'RegionId'>(),
  energy: z.number().finite(),
  maxEnergy: z.number().finite(),
  health: z.number().finite(),
  maxHealth: z.number().finite(),
  ageTicks: z.number().int().min(0),
  maxAgeTicks: z.number().int().min(0),
  mature: z.boolean(),
  reproductionReady: z.boolean(),
  generation: z.number().int().min(0),
  inventory: z
    .array(z.object({ materialId: brandedId<'MaterialId'>(), quantity: z.number().finite() }))
    .max(32),
  attachedStructureId: brandedId<'StructureId'>().optional(),
  planning: perMille,
  manipulation: perMille,
  memorySlots: z.number().int().min(0).max(64),
  carryCapacity: z.number().int().min(0),
  inventorySlotLimit: z.number().int().min(0),
  speedCuPerTick: z.number().finite(),
  moveCostPer100Cu: z.number().finite(),
  perceptionRadiusCu: z.number().finite(),
});

export const ObservationSchema = z.object({
  version: z.literal(1),
  worldId: brandedId<'WorldId'>(),
  tick: z.number().int().min(0),
  self: observedSelfSchema,
  environment: z.object({
    biome: z.enum(['abyss', 'shallows', 'shore', 'plain', 'highland', 'ridge']),
    lightPerMille: perMille,
    temperature: perMille,
    waterCoverage: perMille,
    biomass: z.number().finite(),
    pressure: boundedText(32),
    pressureSeverity: perMille,
  }),
  organisms: z
    .array(
      z.object({
        organismId: brandedId<'OrganismId'>(),
        lineageId: brandedId<'LineageId'>(),
        kin: z.boolean(),
        position: positionSchema,
        distanceCu: z.number().finite(),
        sizeBand: z.enum(['tiny', 'small', 'medium', 'large']),
        threatBand: z.enum(['harmless', 'wary', 'dangerous']),
        healthBand: z.enum(['weak', 'fair', 'strong']),
        energyBand: z.enum(['starving', 'lean', 'fed']),
      }),
    )
    .max(MAX_OBSERVED_ORGANISMS),
  resources: z
    .array(
      z.object({
        resourceNodeId: brandedId<'ResourceNodeId'>(),
        materialId: brandedId<'MaterialId'>(),
        position: positionSchema,
        distanceCu: z.number().finite(),
        quantity: z.number().finite(),
        nutritionPerUnit: z.number().finite(),
        known: z.boolean(),
      }),
    )
    .max(MAX_OBSERVED_RESOURCES),
  structures: z
    .array(
      z.object({
        structureId: brandedId<'StructureId'>(),
        position: positionSchema,
        distanceCu: z.number().finite(),
        pattern: z.enum(STRUCTURE_PATTERNS),
        integrity: perMille,
        functions: z.array(z.enum(STRUCTURE_FUNCTIONS)).max(STRUCTURE_FUNCTIONS.length),
        builtByOwnLineage: z.boolean(),
        inspected: z.boolean(),
      }),
    )
    .max(MAX_OBSERVED_STRUCTURES),
  signals: z
    .array(
      z.object({
        channel: z.enum(SIGNAL_CHANNELS),
        fromLineageId: brandedId<'LineageId'>(),
        kin: z.boolean(),
        distanceCu: z.number().finite(),
        intensity: perMille,
        recipeKey: boundedText(64).optional(),
        recipeLabel: boundedText(64).optional(),
      }),
    )
    .max(MAX_OBSERVED_SIGNALS),
  memories: z
    .array(
      z.object({
        kind: boundedText(32),
        note: boundedText(160),
        salience: perMille,
        ageTicks: z.number().int().min(0),
      }),
    )
    .max(MAX_OBSERVED_MEMORIES),
  goals: z
    .array(
      z.object({
        goalId: brandedId<'GoalId'>(),
        text: boundedText(280),
        submittedAtTick: z.number().int().min(0),
      }),
    )
    .max(MAX_OBSERVED_GOALS),
  drives: z.record(z.enum(DRIVE_IDS), perMille),
  temperament: z.enum(['cautious', 'balanced', 'bold', 'gregarious', 'solitary']),
  aspiration: boundedText(280),
  knownRecipes: z.array(z.object({ key: boundedText(64), label: boundedText(64) })).max(32),
  availableActions: z.array(boundedText(32)).max(32),
});

/** Structured output contract for a decision provider. */
export const ActionProposalSchema = z.object({
  version: z.literal(ACTION_PROPOSAL_VERSION),
  action: AgentActionSchema,
  /** Short, safe, audit-friendly justification. Hidden reasoning is never persisted. */
  rationale: z.string().min(1).max(180),
});

export type ActionProposalContent = z.infer<typeof ActionProposalSchema>;

export interface ActionProposal {
  readonly version: number;
  readonly action: AgentAction;
  readonly rationale: string;
  readonly provider: string;
  readonly model?: string;
  readonly proposedAtEpochMs: number;
  readonly latencyMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

/** The JSON schema the model is instructed to produce, published for documentation. */
export const ACTION_PROPOSAL_JSON_SHAPE = `{
  "version": 1,
  "action": { "type": "<one of the availableActions>", ... },
  "rationale": "<max 180 characters, no chain of thought>"
}`;
