import { z } from 'zod';
import { DRIVE_IDS, HABITAT_PREFERENCES } from './entities.js';
import { REGION_GRID, WORLD_SPAN_CU } from './geometry.js';
import { STRUCTURE_FUNCTIONS, STRUCTURE_PATTERNS } from './structures.js';
import { TRAIT_IDS } from './traits.js';

/**
 * Public API contracts for `/api/v1`.
 *
 * These types are the versioned boundary between the world and the browser. They contain
 * only opaque domain identifiers: no Azure endpoints, no partition or row keys, no
 * credentials. Every response is validated on the way out as well as the way in.
 */
export const API_VERSION = 'v1';

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

export const TEMPERAMENTS = ['cautious', 'balanced', 'bold', 'gregarious', 'solitary'] as const;

export const SENSORY_BIASES = ['light', 'chemical', 'balanced'] as const;

/**
 * Agent authoring request.
 *
 * A creator chooses *starting nature and habitat*, not an outcome. Nothing here guarantees
 * survival: the founding cell can and often does die.
 */
export const CreateAgentRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(
      /^[\p{L}\p{N} '-]+$/u,
      'name may contain letters, numbers, spaces, apostrophes, hyphens',
    ),
  aspiration: z.string().trim().min(4).max(160),
  habitat: z.enum(HABITAT_PREFERENCES),
  temperament: z.enum(TEMPERAMENTS),
  sensoryBias: z.enum(SENSORY_BIASES),
  visualSeed: z.number().int().min(0).max(65_535),
  drives: z
    .object({
      survive: z.number().int().min(0).max(1000),
      forage: z.number().int().min(0).max(1000),
      reproduce: z.number().int().min(0).max(1000),
      explore: z.number().int().min(0).max(1000),
      cooperate: z.number().int().min(0).max(1000),
      build: z.number().int().min(0).max(1000),
    })
    .refine(
      (d) => DRIVE_IDS.reduce((sum, id) => sum + d[id], 0) <= 3000,
      'total drive weight may not exceed 3000',
    ),
});

export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/** Broad, motivational goal. Immutable once submitted; the agent may reject it. */
export const SubmitGoalRequestSchema = z.object({
  text: z.string().trim().min(4).max(160),
});

export type SubmitGoalRequest = z.infer<typeof SubmitGoalRequestSchema>;

export const SnapshotQuerySchema = z.object({
  regionId: idSchema.optional(),
  /** Snapshot radius in regions. Bounded so a snapshot can never span the whole world. */
  radius: z.coerce.number().int().min(0).max(2).default(1),
});

export type SnapshotQuery = z.infer<typeof SnapshotQuerySchema>;

export const HistoryQuerySchema = z.object({
  regionId: idSchema.optional(),
  agentId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(256).optional(),
});

export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(400),
    details: z.array(z.string().max(200)).max(20).optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const VisualDtoSchema = z.object({
  hue: z.number().int(),
  saturation: z.number().int(),
  luminance: z.number().int(),
  scale: z.number().int(),
  elongation: z.number().int(),
  appendages: z.number().int(),
  spines: z.number().int(),
  plating: z.number().int(),
  translucency: z.number().int(),
  eyes: z.number().int(),
  glow: z.number().int(),
});

export const OrganismDtoSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  lineageId: idSchema,
  regionId: idSchema,
  x: z.number().int().min(0).max(WORLD_SPAN_CU),
  z: z.number().int().min(0).max(WORLD_SPAN_CU),
  elevation: z.number().int(),
  energy: z.number().int().min(0),
  maxEnergy: z.number().int().min(0),
  health: z.number().int().min(0),
  maxHealth: z.number().int().min(0),
  ageTicks: z.number().int().min(0),
  maxAgeTicks: z.number().int().min(0),
  generation: z.number().int().min(0),
  visual: VisualDtoSchema,
});

export type OrganismDto = z.infer<typeof OrganismDtoSchema>;

export const StructureDtoSchema = z.object({
  id: idSchema,
  regionId: idSchema,
  x: z.number().int(),
  z: z.number().int(),
  elevation: z.number().int(),
  pattern: z.enum(STRUCTURE_PATTERNS),
  label: z.string().max(80),
  integrity: z.number().int().min(0).max(1000),
  volume: z.number().int().min(0),
  functions: z.array(z.object({ id: z.enum(STRUCTURE_FUNCTIONS), magnitude: z.number().int() })),
  createdByAgentId: idSchema,
  createdByLineageId: idSchema,
  createdAtTick: z.number().int().min(0),
});

export type StructureDto = z.infer<typeof StructureDtoSchema>;

export const ResourceDtoSchema = z.object({
  id: idSchema,
  materialId: idSchema,
  x: z.number().int(),
  z: z.number().int(),
  elevation: z.number().int(),
  quantity: z.number().int().min(0),
  capacity: z.number().int().min(0),
});

export const RegionDtoSchema = z.object({
  id: idSchema,
  col: z
    .number()
    .int()
    .min(0)
    .max(REGION_GRID - 1),
  row: z
    .number()
    .int()
    .min(0)
    .max(REGION_GRID - 1),
  biome: z.enum(['abyss', 'shallows', 'shore', 'plain', 'highland', 'ridge']),
  meanElevationCu: z.number().int(),
  waterCoverage: z.number().int().min(0).max(1000),
  baseTemperature: z.number().int().min(0).max(1000),
  mineralRichness: z.number().int().min(0).max(1000),
  biomass: z.number().int().min(0),
});

export const SnapshotResponseSchema = z.object({
  worldId: idSchema,
  worldName: z.string().max(80),
  tick: z.number().int().min(0),
  seed: z.number().int(),
  lightPerMille: z.number().int().min(0).max(1000),
  dayPhasePerMille: z.number().int().min(0).max(1000),
  pressure: z.object({
    kind: z.enum(['heatwave', 'coldSnap', 'drought', 'bloom', 'storm', 'calm']),
    severity: z.number().int().min(0).max(1000),
    endsAtTick: z.number().int().min(0),
  }),
  centreRegionId: idSchema,
  radius: z.number().int().min(0).max(2),
  regions: z.array(RegionDtoSchema).max(25),
  organisms: z.array(OrganismDtoSchema).max(600),
  structures: z.array(StructureDtoSchema).max(300),
  resources: z.array(ResourceDtoSchema).max(400),
  stats: z.object({
    livingOrganisms: z.number().int().min(0),
    activeLineages: z.number().int().min(0),
    extinctLineages: z.number().int().min(0),
    structures: z.number().int().min(0),
    discoveredMaterials: z.number().int().min(0),
    totalBirths: z.number().int().min(0),
    totalDeaths: z.number().int().min(0),
  }),
  truncated: z.boolean(),
});

export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;

export const TraitDtoSchema = z.object({
  id: z.enum(TRAIT_IDS),
  value: z.number().int().min(0).max(1000),
  effective: z.number().int().min(0).max(1000),
});

export const AgentDetailResponseSchema = z.object({
  id: idSchema,
  lineageId: idSchema,
  name: z.string().max(64),
  aspiration: z.string().max(200),
  status: z.enum(['active', 'extinct']),
  temperament: z.enum(TEMPERAMENTS),
  createdAtTick: z.number().int().min(0),
  extinctAtTick: z.number().int().min(0).optional(),
  drives: z.record(z.string(), z.number().int()),
  decisionCount: z.number().int().min(0),
  lastDecisionTick: z.number().int().min(0),
  livingOrganisms: z.number().int().min(0),
  generations: z.number().int().min(0),
  births: z.number().int().min(0),
  deaths: z.number().int().min(0),
  meanTraits: z.array(TraitDtoSchema),
  /**
   * Materials this lineage has encountered, with their derived names.
   *
   * Carries the label rather than the bare id because an id like `mx1a2b3c` tells a spectator
   * nothing. The subtitle answers "what is this stuff" from the same numbers the property bars show.
   */
  knownMaterials: z
    .array(
      z.object({
        id: idSchema,
        label: z.string().max(64),
        subtitle: z.string().max(200),
      }),
    )
    .max(64),
  /**
   * Designs this lineage knows how to make.
   *
   * `label` is joined from the material the recipe produces rather than read from the stored recipe,
   * so a design is called the same thing as the thing it makes even when it was learned before the
   * naming rules existed.
   */
  knownRecipes: z
    .array(
      z.object({
        key: z.string().max(64),
        label: z.string().max(64),
        producesMaterialId: idSchema,
        components: z
          .array(
            z.object({
              materialId: idSchema,
              label: z.string().max(64),
              quantity: z.number().int().min(0),
            }),
          )
          .max(8),
        learnedAtTick: z.number().int().min(0),
      }),
    )
    .max(24),
  goals: z
    .array(
      z.object({
        id: idSchema,
        text: z.string().max(200),
        status: z.enum(['pending', 'adopted', 'deferred', 'rejected', 'fulfilled']),
        submittedAtTick: z.number().int().min(0),
        resolutionNote: z.string().max(200).optional(),
      }),
    )
    .max(20),
  recentMemories: z
    .array(
      z.object({
        kind: z.string().max(32),
        note: z.string().max(200),
        salience: z.number().int(),
        createdAtTick: z.number().int().min(0),
      }),
    )
    .max(16),
});

export type AgentDetailResponse = z.infer<typeof AgentDetailResponseSchema>;

export const OrganismDetailResponseSchema = OrganismDtoSchema.extend({
  traits: z.array(TraitDtoSchema),
  phenotype: z.record(z.string(), z.number().int()),
  inventory: z.array(z.object({ materialId: idSchema, quantity: z.number().int() })).max(16),
  parentOrganismId: idSchema.optional(),
  alive: z.boolean(),
  causeOfDeath: z.string().max(32).optional(),
  attachedStructureId: idSchema.optional(),
});

export type OrganismDetailResponse = z.infer<typeof OrganismDetailResponseSchema>;

export const LineageNodeDtoSchema = z.object({
  organismId: idSchema,
  parentOrganismId: idSchema.optional(),
  bornAtTick: z.number().int().min(0),
  diedAtTick: z.number().int().min(0).optional(),
  generation: z.number().int().min(0),
  complexity: z.number().int().min(0),
  causeOfDeath: z.string().max(32).optional(),
});

export const LineageDetailResponseSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  name: z.string().max(64),
  foundedAtTick: z.number().int().min(0),
  extinctAtTick: z.number().int().min(0).optional(),
  generations: z.number().int().min(0),
  births: z.number().int().min(0),
  deaths: z.number().int().min(0),
  livingCount: z.number().int().min(0),
  meanTraits: z.array(TraitDtoSchema),
  nodes: z.array(LineageNodeDtoSchema).max(400),
  nextCursor: z.string().max(256).optional(),
});

export type LineageDetailResponse = z.infer<typeof LineageDetailResponseSchema>;

export const EventDtoSchema = z.object({
  id: z.string().max(96),
  tick: z.number().int().min(0),
  regionId: idSchema,
  kind: z.string().max(48),
  summary: z.string().max(200),
  agentId: idSchema.optional(),
  lineageId: idSchema.optional(),
  organismId: idSchema.optional(),
});

export const EventHistoryResponseSchema = z.object({
  events: z.array(EventDtoSchema).max(200),
  nextCursor: z.string().max(256).optional(),
});

export type EventHistoryResponse = z.infer<typeof EventHistoryResponseSchema>;

export const CreateAgentResponseSchema = z.object({
  agentId: idSchema,
  lineageId: idSchema,
  name: z.string().max(64),
  acceptedAtTick: z.number().int().min(0),
  /** Founding cells enter at the next tick; nothing about survival is promised. */
  message: z.string().max(200),
});

export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

export const SubmitGoalResponseSchema = z.object({
  goalId: idSchema,
  agentId: idSchema,
  status: z.literal('pending'),
  message: z.string().max(200),
  remainingToday: z.number().int().min(0),
});

export type SubmitGoalResponse = z.infer<typeof SubmitGoalResponseSchema>;

export const WorldMetaResponseSchema = z.object({
  worldId: idSchema,
  name: z.string().max(80),
  tick: z.number().int().min(0),
  seed: z.number().int(),
  regionGrid: z.number().int(),
  regionSpanCu: z.number().int(),
  worldSpanCu: z.number().int(),
  calendar: z.object({
    ticksPerDay: z.number().int(),
    ticksPerPressureCycle: z.number().int(),
    simulatedMinutesPerTick: z.number().int(),
  }),
  stats: SnapshotResponseSchema.shape.stats,
  regions: z.array(RegionDtoSchema).max(REGION_GRID * REGION_GRID),
  agents: z
    .array(
      z.object({
        id: idSchema,
        lineageId: idSchema,
        name: z.string().max(64),
        status: z.enum(['active', 'extinct']),
        livingOrganisms: z.number().int().min(0),
        generations: z.number().int().min(0),
        hue: z.number().int(),
      }),
    )
    .max(200),
  /** True when the deployment is running without a configured AI provider. */
  heuristicOnly: z.boolean(),
  /** True when a configured AI provider is failing and the world is running degraded. */
  aiDegraded: z.boolean(),
});

export type WorldMetaResponse = z.infer<typeof WorldMetaResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string().max(32),
  uptimeSeconds: z.number().int().min(0),
});

export const ReadinessResponseSchema = z.object({
  status: z.enum(['ready', 'notReady']),
  storage: z.enum(['ok', 'unavailable']),
  worldSeeded: z.boolean(),
  detail: z.string().max(200).optional(),
});

export const CreatorIdentityResponseSchema = z.object({
  creatorId: idSchema,
  /** Prototype identity: a signed browser-scoped token, not an account. */
  kind: z.literal('anonymous-browser'),
  agentsRemainingToday: z.number().int().min(0),
});

export type CreatorIdentityResponse = z.infer<typeof CreatorIdentityResponseSchema>;
