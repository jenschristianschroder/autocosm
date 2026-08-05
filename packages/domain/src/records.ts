import { z } from 'zod';
import { DRIVE_IDS, HABITAT_PREFERENCES, SIGNAL_CHANNELS } from './entities.js';
import { MATERIAL_PROPERTY_IDS } from './materials.js';
import { STRUCTURE_FUNCTIONS, STRUCTURE_PATTERNS } from './structures.js';
import { TRAIT_IDS } from './traits.js';
import { WORLD_SPAN_CU } from './geometry.js';

/**
 * Versioned storage records.
 *
 * Everything persisted is validated on write *and* on read. Each record carries a `rv`
 * (record version) so a future schema change can be up-converted rather than guessed at.
 * A record that fails validation is surfaced as an error, never silently coerced.
 */
export const RECORD_VERSION = 1;

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const perMille = z.number().int().min(0).max(1000);
const coordinate = z
  .number()
  .int()
  .min(0)
  .max(WORLD_SPAN_CU - 1);
const nonNegative = z.number().int().min(0);

const versioned = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ rv: z.number().int().min(1).max(RECORD_VERSION), ...shape });

export const PositionRecordSchema = z.object({ x: coordinate, z: coordinate });

export const GenotypeRecordSchema = z.object(
  Object.fromEntries(TRAIT_IDS.map((id) => [id, perMille])) as {
    [K in (typeof TRAIT_IDS)[number]]: typeof perMille;
  },
);

export const MaterialPropertiesRecordSchema = z.object(
  Object.fromEntries(MATERIAL_PROPERTY_IDS.map((id) => [id, perMille])) as {
    [K in (typeof MATERIAL_PROPERTY_IDS)[number]]: typeof perMille;
  },
);

export const DrivesRecordSchema = z.object(
  Object.fromEntries(DRIVE_IDS.map((id) => [id, perMille])) as {
    [K in (typeof DRIVE_IDS)[number]]: typeof perMille;
  },
);

export const MaterialComponentRecordSchema = z.object({
  materialId: idSchema,
  quantity: z.number().int().min(0).max(1_000_000),
});

export const WorldRecordSchema = versioned({
  id: idSchema,
  name: z.string().min(1).max(80),
  seed: z.number().int(),
  tick: nonNegative,
  createdAtTick: nonNegative,
  calendar: z.object({
    ticksPerDay: z.number().int().min(1).max(100_000),
    ticksPerPressureCycle: z.number().int().min(1).max(1_000_000),
    simulatedMinutesPerTick: z.number().int().min(1).max(10_000),
  }),
  pressure: z.object({
    kind: z.enum(['heatwave', 'coldSnap', 'drought', 'bloom', 'storm', 'calm']),
    startedAtTick: nonNegative,
    endsAtTick: nonNegative,
    severity: perMille,
  }),
  stats: z.object({
    livingOrganisms: nonNegative,
    activeLineages: nonNegative,
    extinctLineages: nonNegative,
    structures: nonNegative,
    discoveredMaterials: nonNegative,
    totalBirths: nonNegative,
    totalDeaths: nonNegative,
  }),
});

export type WorldRecord = z.infer<typeof WorldRecordSchema>;

export const RegionRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  biome: z.enum(['abyss', 'shallows', 'shore', 'plain', 'highland', 'ridge']),
  meanElevationCu: z.number().int(),
  waterCoverage: perMille,
  baseTemperature: perMille,
  lightModifier: perMille,
  mineralRichness: perMille,
  biomass: nonNegative,
});

export type RegionRecord = z.infer<typeof RegionRecordSchema>;

export const AgentRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  lineageId: idSchema,
  name: z.string().min(1).max(64),
  createdByCreatorId: idSchema,
  createdAtTick: nonNegative,
  status: z.enum(['active', 'extinct']),
  drives: DrivesRecordSchema,
  temperament: z.enum(['cautious', 'balanced', 'bold', 'gregarious', 'solitary']),
  habitat: z.enum(HABITAT_PREFERENCES),
  aspiration: z.string().max(200),
  knowledge: z.object({
    knownMaterialIds: z.array(idSchema).max(64),
    recipes: z
      .array(
        z.object({
          label: z.string().max(64),
          components: z.array(MaterialComponentRecordSchema).max(8),
          learnedAtTick: nonNegative,
          learnedFromLineageId: idSchema.optional(),
        }),
      )
      .max(24),
    knownStructureIds: z.array(idSchema).max(48),
  }),
  lastDecisionTick: nonNegative,
  decisionCount: nonNegative,
  visualSeed: z.number().int().min(0).max(65_535),
  extinctAtTick: nonNegative.optional(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export const OrganismRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  agentId: idSchema,
  lineageId: idSchema,
  regionId: idSchema,
  position: PositionRecordSchema,
  genotype: GenotypeRecordSchema,
  lifetime: z.object({
    // Partial by design: only emphasised traits appear. A required-key record schema would
    // reject organisms that have never expressed a trait.
    emphasis: z.record(z.string().max(32), perMille),
    successes: z.record(z.string().max(32), z.number().int().min(0).max(1_000_000)),
    failures: z.record(z.string().max(32), z.number().int().min(0).max(1_000_000)),
  }),
  energy: nonNegative,
  health: nonNegative,
  ageTicks: nonNegative,
  bornAtTick: nonNegative,
  generation: nonNegative,
  parentOrganismId: idSchema.optional(),
  inventory: z.array(MaterialComponentRecordSchema).max(16),
  reproductionReadyTick: nonNegative,
  attachedStructureId: idSchema.optional(),
  alive: z.boolean(),
  diedAtTick: nonNegative.optional(),
  causeOfDeath: z.enum(['starvation', 'age', 'predation', 'environment', 'toxicity']).optional(),
});

export type OrganismRecord = z.infer<typeof OrganismRecordSchema>;

export const LineageRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  agentId: idSchema,
  name: z.string().max(64),
  foundedAtTick: nonNegative,
  originRegionId: idSchema,
  generations: nonNegative,
  births: nonNegative,
  deaths: nonNegative,
  livingCount: nonNegative,
  meanGenotype: GenotypeRecordSchema,
  extinctAtTick: nonNegative.optional(),
});

export type LineageRecord = z.infer<typeof LineageRecordSchema>;

export const LineageNodeRecordSchema = versioned({
  organismId: idSchema,
  lineageId: idSchema,
  parentOrganismId: idSchema.optional(),
  bornAtTick: nonNegative,
  diedAtTick: nonNegative.optional(),
  generation: nonNegative,
  complexity: nonNegative,
  causeOfDeath: z.enum(['starvation', 'age', 'predation', 'environment', 'toxicity']).optional(),
});

export type LineageNodeRecord = z.infer<typeof LineageNodeRecordSchema>;

export const MaterialRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  label: z.string().max(64),
  origin: z.enum(['mineral', 'organic', 'fluid', 'composite']),
  properties: MaterialPropertiesRecordSchema,
  nutritionPerUnit: z.number().int().min(0).max(1000),
  derivedFrom: z.array(MaterialComponentRecordSchema).max(8).optional(),
  discoveredAtTick: nonNegative.optional(),
});

export type MaterialRecord = z.infer<typeof MaterialRecordSchema>;

export const ResourceNodeRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  regionId: idSchema,
  position: PositionRecordSchema,
  materialId: idSchema,
  quantity: nonNegative,
  regenPerTick: z.number().int().min(0).max(10_000),
  capacity: nonNegative,
});

export type ResourceNodeRecord = z.infer<typeof ResourceNodeRecordSchema>;

export const StructureRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  regionId: idSchema,
  position: PositionRecordSchema,
  pattern: z.enum(STRUCTURE_PATTERNS),
  components: z.array(MaterialComponentRecordSchema).max(8),
  functions: z.array(z.object({ id: z.enum(STRUCTURE_FUNCTIONS), magnitude: perMille })).max(12),
  properties: MaterialPropertiesRecordSchema,
  volume: nonNegative,
  integrity: perMille,
  createdByAgentId: idSchema,
  createdByLineageId: idSchema,
  createdByOrganismId: idSchema,
  createdAtTick: nonNegative,
  lastChangedAtTick: nonNegative,
  label: z.string().max(80),
  usage: z
    .array(
      z.object({
        tick: nonNegative,
        organismId: idSchema,
        lineageId: idSchema,
        kind: z.enum(['shelter', 'inspect', 'harvest', 'repair', 'damage', 'repurpose']),
      }),
    )
    .max(12),
});

export type StructureRecord = z.infer<typeof StructureRecordSchema>;

export const MemoryRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  agentId: idSchema,
  kind: z.enum([
    'foodSource',
    'threat',
    'ally',
    'materialSite',
    'structure',
    'territory',
    'lesson',
  ]),
  createdAtTick: nonNegative,
  salience: perMille,
  position: PositionRecordSchema.optional(),
  subjectId: idSchema.optional(),
  note: z.string().max(160),
});

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const GoalRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  agentId: idSchema,
  text: z.string().max(200),
  submittedByCreatorId: idSchema,
  submittedAtTick: nonNegative,
  status: z.enum(['pending', 'adopted', 'deferred', 'rejected', 'fulfilled']),
  resolvedAtTick: nonNegative.optional(),
  resolutionNote: z.string().max(200).optional(),
});

export type GoalRecord = z.infer<typeof GoalRecordSchema>;

export const KnownRecipeRecordSchema = z.object({
  label: z.string().max(64),
  components: z.array(MaterialComponentRecordSchema).max(8),
  learnedAtTick: nonNegative,
  learnedFromLineageId: idSchema.optional(),
});

export const SignalRecordSchema = versioned({
  worldId: idSchema,
  organismId: idSchema,
  lineageId: idSchema,
  agentId: idSchema,
  regionId: idSchema,
  position: PositionRecordSchema,
  channel: z.enum(SIGNAL_CHANNELS),
  intensity: perMille,
  radiusCu: nonNegative,
  emittedAtTick: nonNegative,
  /** Carried only by `teach` signals. Stored in full so a signal survives a job restart. */
  recipe: KnownRecipeRecordSchema.optional(),
});

export type SignalRecord = z.infer<typeof SignalRecordSchema>;

/** Persisted pending decision. The observation is stored compactly as validated JSON. */
export const DecisionRecordSchema = versioned({
  id: idSchema,
  worldId: idSchema,
  agentId: idSchema,
  lineageId: idSchema,
  organismId: idSchema,
  regionId: idSchema,
  createdAtTick: nonNegative,
  expiresAtTick: nonNegative,
  reason: z.string().max(48),
  status: z.enum(['pending', 'claimed', 'proposed', 'applied', 'expired', 'failed']),
  observationJson: z.string().max(28_000),
  claimedBy: z.string().max(80).optional(),
  claimExpiresAtEpochMs: z.number().int().min(0).optional(),
  proposalJson: z.string().max(4_000).optional(),
  attempts: z.number().int().min(0).max(50),
});

export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const WatermarkRecordSchema = versioned({
  worldId: idSchema,
  name: z.string().max(48),
  tick: nonNegative,
  updatedAtIso: z.string().max(40),
});

export type WatermarkRecord = z.infer<typeof WatermarkRecordSchema>;

export const LeaseRecordSchema = versioned({
  worldId: idSchema,
  name: z.string().max(48),
  holder: z.string().max(80),
  expiresAtEpochMs: z.number().int().min(0),
});

export type LeaseRecord = z.infer<typeof LeaseRecordSchema>;

export const CreatorQuotaRecordSchema = versioned({
  worldId: idSchema,
  creatorId: idSchema,
  dayKey: z.string().max(16),
  agentsCreated: z.number().int().min(0).max(10_000),
  goalsSubmitted: z.number().int().min(0).max(10_000),
  /**
   * AI decisions charged to this row today. The think job keeps its world-wide daily spend under
   * a reserved creator id so the same compare-and-set path bounds both human and model activity.
   */
  decisionsRequested: z.number().int().min(0).max(1_000_000).default(0),
});

export type CreatorQuotaRecord = z.infer<typeof CreatorQuotaRecordSchema>;

export const IdempotencyRecordSchema = versioned({
  worldId: idSchema,
  key: z.string().max(128),
  responseJson: z.string().max(4_000),
  createdAtEpochMs: z.number().int().min(0),
});

export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

/**
 * Every record needed to reconstitute a world.
 *
 * The bundle is the contract between the simulation (which projects it to and from its in-memory
 * state) and storage (which reads and writes it). Neither package needs to know about the other.
 * Terrain is absent on purpose: it is a pure function of the world seed.
 */
export interface WorldRecordBundle {
  readonly world: WorldRecord;
  readonly regions: readonly RegionRecord[];
  readonly agents: readonly AgentRecord[];
  readonly lineages: readonly LineageRecord[];
  readonly lineageNodes: readonly LineageNodeRecord[];
  readonly organisms: readonly OrganismRecord[];
  readonly materials: readonly MaterialRecord[];
  readonly resources: readonly ResourceNodeRecord[];
  readonly structures: readonly StructureRecord[];
  readonly memories: readonly MemoryRecord[];
  readonly goals: readonly GoalRecord[];
  readonly signals: readonly SignalRecord[];
}

/**
 * Up-convert a stored record to the current version.
 *
 * Only version 1 exists today. The hook is present so that a future migration has a single
 * obvious home rather than being scattered through read paths.
 */
export function upconvert<T extends { rv: number }>(raw: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
  throw new StoredRecordInvalid(issues);
}

export class StoredRecordInvalid extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Stored record failed validation: ${issues.join('; ')}`);
    this.name = 'StoredRecordInvalid';
    this.issues = issues;
  }
}
