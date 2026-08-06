import { z } from 'zod';
import { STRUCTURE_PATTERNS } from './structures.js';
import { SIGNAL_CHANNELS } from './entities.js';
import { TRAIT_IDS } from './traits.js';
import { WORLD_SPAN_CU } from './geometry.js';

/**
 * Actions an agent may propose.
 *
 * Every proposal is untrusted input. Parsing with these schemas establishes shape only;
 * the simulation independently re-checks visibility, range, ownership, cost, cooldown,
 * evolved capability, target existence and world version before anything is applied.
 */

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'identifier may only contain letters, digits, hyphen and underscore');

const coordinate = z
  .number()
  .int()
  .min(0)
  .max(WORLD_SPAN_CU - 1);
const perMille = z.number().int().min(0).max(1000);
const quantity = z.number().int().min(1).max(10_000);

export const PositionSchema = z.object({ x: coordinate, z: coordinate });

const componentSchema = z.object({ materialId: idSchema, quantity });

/** Upper bound on components in a single combine or build proposal. */
export const MAX_ACTION_COMPONENTS = 6;

export const MoveActionSchema = z.object({
  type: z.literal('move'),
  target: PositionSchema,
});

export const ConsumeActionSchema = z.object({
  type: z.literal('consume'),
  targetKind: z.enum(['resourceNode', 'organism', 'biomass']),
  targetId: idSchema.optional(),
});

export const AttackActionSchema = z.object({
  type: z.literal('attack'),
  targetOrganismId: idSchema,
});

export const SignalActionSchema = z.object({
  type: z.literal('signal'),
  channel: z.enum(SIGNAL_CHANNELS),
  intensity: perMille,
  /** Content-addressed recipe key, not a label — see `deriveRecipeKey`. */
  recipeKey: z.string().min(1).max(64).optional(),
});

export const AttachActionSchema = z.object({
  type: z.literal('attach'),
  structureId: idSchema,
});

export const ShareActionSchema = z.object({
  type: z.literal('share'),
  targetOrganismId: idSchema,
  energy: z.number().int().min(1).max(10_000),
});

export const ReproduceActionSchema = z.object({
  type: z.literal('reproduce'),
  investment: perMille,
  partnerOrganismId: idSchema.optional(),
});

export const ExpressTraitActionSchema = z.object({
  type: z.literal('expressTrait'),
  traitId: z.enum(TRAIT_IDS),
});

export const CollectActionSchema = z.object({
  type: z.literal('collect'),
  resourceNodeId: idSchema,
  quantity,
});

export const CombineActionSchema = z.object({
  type: z.literal('combine'),
  label: z.string().min(1).max(48),
  components: z.array(componentSchema).min(2).max(MAX_ACTION_COMPONENTS),
});

export const BuildActionSchema = z.object({
  type: z.literal('build'),
  pattern: z.enum(STRUCTURE_PATTERNS),
  components: z.array(componentSchema).min(1).max(MAX_ACTION_COMPONENTS),
});

export const InspectActionSchema = z.object({
  type: z.literal('inspect'),
  targetKind: z.enum(['structure', 'organism', 'resourceNode']),
  targetId: idSchema,
});

export const RepurposeActionSchema = z.object({
  type: z.literal('repurpose'),
  structureId: idSchema,
  pattern: z.enum(STRUCTURE_PATTERNS),
});

export const RestActionSchema = z.object({ type: z.literal('rest') });

export const AgentActionSchema = z.discriminatedUnion('type', [
  MoveActionSchema,
  ConsumeActionSchema,
  AttackActionSchema,
  SignalActionSchema,
  AttachActionSchema,
  ShareActionSchema,
  ReproduceActionSchema,
  ExpressTraitActionSchema,
  CollectActionSchema,
  CombineActionSchema,
  BuildActionSchema,
  InspectActionSchema,
  RepurposeActionSchema,
  RestActionSchema,
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentActionType = AgentAction['type'];

export const AGENT_ACTION_TYPES = [
  'move',
  'consume',
  'attack',
  'signal',
  'attach',
  'share',
  'reproduce',
  'expressTrait',
  'collect',
  'combine',
  'build',
  'inspect',
  'repurpose',
  'rest',
] as const satisfies readonly AgentActionType[];

/** Reasons the simulation may refuse an otherwise well-formed proposal. */
export const REJECTION_REASONS = [
  'unknownTarget',
  'outOfRange',
  'notVisible',
  'insufficientEnergy',
  'insufficientMaterial',
  'capabilityNotEvolved',
  'onCooldown',
  'notMature',
  'targetDead',
  'selfTarget',
  'staleWorldVersion',
  'inventoryFull',
  'notOwner',
  'malformed',
  'rateLimited',
  'actionUnavailable',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export class ActionRejected extends Error {
  readonly reason: RejectionReason;
  readonly actionType: AgentActionType;

  constructor(actionType: AgentActionType, reason: RejectionReason, message?: string) {
    super(message ?? `${actionType} rejected: ${reason}`);
    this.name = 'ActionRejected';
    this.reason = reason;
    this.actionType = actionType;
  }
}

/**
 * Capability gate.
 *
 * Actions become available only when the genome supports them. This is checked after Zod
 * parsing, so a model can never unlock a behaviour by asking nicely.
 */
export interface CapabilityRequirement {
  readonly action: AgentActionType;
  /** Minimum effective phenotype scores required, keyed by phenotype field. */
  readonly minManipulation?: number;
  readonly minSignalRadiusCu?: number;
  readonly minMemorySlots?: number;
  readonly minPlanning?: number;
  readonly requiresMaturity?: boolean;
}

export const CAPABILITY_REQUIREMENTS: readonly CapabilityRequirement[] = Object.freeze([
  { action: 'collect', minManipulation: 120 },
  { action: 'combine', minManipulation: 220, minMemorySlots: 2 },
  { action: 'build', minManipulation: 250, minMemorySlots: 2 },
  { action: 'repurpose', minManipulation: 400, minMemorySlots: 3, minPlanning: 120 },
  { action: 'signal', minSignalRadiusCu: 200 },
  { action: 'inspect', minMemorySlots: 1 },
  { action: 'reproduce', requiresMaturity: true },
]);
