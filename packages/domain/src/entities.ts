import type { Position } from './geometry.js';
import type {
  AgentId,
  CreatorId,
  GoalId,
  LineageId,
  MaterialId,
  MemoryId,
  OrganismId,
  RegionId,
  ResourceNodeId,
  StructureId,
  WorldId,
} from './ids.js';
import type { MaterialComponent } from './materials.js';
import type { Genotype, TraitId } from './traits.js';
import type { Eu, Hp, Mu, PerMille, TickIndex } from './units.js';
import type { WorldCalendar } from './time.js';

/** Terrain classification of a point or region. */
export type Biome = 'abyss' | 'shallows' | 'shore' | 'plain' | 'highland' | 'ridge';

export interface Region {
  readonly id: RegionId;
  readonly worldId: WorldId;
  readonly biome: Biome;
  /** Mean elevation relative to sea level, in `cu`. */
  readonly meanElevationCu: number;
  /** Fraction of the region below sea level, in per-mille. */
  readonly waterCoverage: PerMille;
  /** Baseline temperature in per-mille where 500‰ is temperate. */
  readonly baseTemperature: PerMille;
  /** Multiplier applied to ambient light, in per-mille. */
  readonly lightModifier: PerMille;
  /** Mineral abundance, in per-mille. */
  readonly mineralRichness: PerMille;
  /** Standing biomass, in `mu`. Regenerates with light and water. */
  readonly biomass: Mu;
}

export interface ResourceNode {
  readonly id: ResourceNodeId;
  readonly regionId: RegionId;
  readonly position: Position;
  readonly materialId: MaterialId;
  readonly quantity: Mu;
  /** Regeneration per tick, in `mu`. Zero for finite mineral deposits. */
  readonly regenPerTick: number;
  readonly capacity: Mu;
}

/** Environmental pressure applied to the whole world for a bounded window. */
export type PressureKind = 'heatwave' | 'coldSnap' | 'drought' | 'bloom' | 'storm' | 'calm';

export interface EnvironmentalPressure {
  readonly kind: PressureKind;
  readonly startedAtTick: TickIndex;
  readonly endsAtTick: TickIndex;
  readonly severity: PerMille;
}

export interface World {
  readonly id: WorldId;
  readonly name: string;
  readonly seed: number;
  readonly tick: TickIndex;
  readonly createdAtTick: TickIndex;
  readonly calendar: WorldCalendar;
  readonly pressure: EnvironmentalPressure;
  readonly stats: WorldStats;
}

export interface WorldStats {
  readonly livingOrganisms: number;
  readonly activeLineages: number;
  readonly extinctLineages: number;
  readonly structures: number;
  readonly discoveredMaterials: number;
  readonly totalBirths: number;
  readonly totalDeaths: number;
}

/** A drive is a standing motivation weight in per-mille. Drives are heritable-ish context. */
export const DRIVE_IDS = [
  'survive',
  'forage',
  'reproduce',
  'explore',
  'cooperate',
  'build',
] as const;
export type DriveId = (typeof DRIVE_IDS)[number];
export type Drives = Readonly<Record<DriveId, PerMille>>;

export type Temperament = 'cautious' | 'balanced' | 'bold' | 'gregarious' | 'solitary';

/** Habitat bands a creator may target when authoring a founding cell. */
export const HABITAT_PREFERENCES = ['abyss', 'shallows', 'shore', 'plain', 'highland'] as const;
export type HabitatPreference = (typeof HABITAT_PREFERENCES)[number];

export interface AgentGoal {
  readonly id: GoalId;
  readonly agentId: AgentId;
  readonly text: string;
  readonly submittedByCreatorId: CreatorId;
  readonly submittedAtTick: TickIndex;
  /**
   * Motivational only. `pending` goals have not yet been considered; the simulation may
   * move them to `adopted`, `deferred` or `rejected` based on the agent's state. A human
   * can never force adoption.
   */
  readonly status: 'pending' | 'adopted' | 'deferred' | 'rejected' | 'fulfilled';
  readonly resolvedAtTick?: TickIndex;
  readonly resolutionNote?: string;
}

export type MemoryKind =
  'foodSource' | 'threat' | 'ally' | 'materialSite' | 'structure' | 'territory' | 'lesson';

export interface Memory {
  readonly id: MemoryId;
  readonly agentId: AgentId;
  readonly kind: MemoryKind;
  readonly createdAtTick: TickIndex;
  /** Strength in per-mille. Memories fade and are evicted once they reach zero. */
  readonly salience: PerMille;
  readonly position?: Position;
  readonly subjectId?: string;
  /** Short, bounded description. Never contains model reasoning. */
  readonly note: string;
}

/** Maximum characters retained in a memory note. */
export const MAX_MEMORY_NOTE_LENGTH = 160;

/**
 * Culturally transmitted knowledge held at lineage scope.
 *
 * Knowledge only spreads when an organism can signal and the recipient can remember, so a
 * lineage without memory and communication cannot accumulate culture at all.
 */
export interface LineageKnowledge {
  readonly knownMaterialIds: readonly MaterialId[];
  readonly recipes: readonly KnownRecipe[];
  readonly knownStructureIds: readonly StructureId[];
}

export interface KnownRecipe {
  /**
   * Content-addressed identity from {@link deriveRecipeKey}. All matching, teaching and
   * deduplication goes through this. Never match on `label`.
   */
  readonly key: string;
  /** Display text only. Free to be rewritten without affecting behaviour. */
  readonly label: string;
  readonly components: readonly MaterialComponent[];
  readonly learnedAtTick: TickIndex;
  readonly learnedFromLineageId?: LineageId;
}

export const MAX_KNOWN_RECIPES = 12;
export const MAX_KNOWN_MATERIALS = 32;
export const MAX_KNOWN_STRUCTURES = 24;

/**
 * The persistent autonomous actor.
 *
 * An agent outlives any individual organism: identity continues through descendants. When
 * every organism of the lineage dies the agent becomes `extinct` and stops thinking.
 */
export interface Agent {
  readonly id: AgentId;
  readonly worldId: WorldId;
  readonly lineageId: LineageId;
  readonly name: string;
  readonly createdByCreatorId: CreatorId;
  readonly createdAtTick: TickIndex;
  readonly status: 'active' | 'extinct';
  readonly drives: Drives;
  readonly temperament: Temperament;
  readonly habitat: HabitatPreference;
  readonly aspiration: string;
  readonly knowledge: LineageKnowledge;
  /** Tick of the most recent AI decision, used to rate-limit model spend per lineage. */
  readonly lastDecisionTick: TickIndex;
  readonly decisionCount: number;
  readonly visualSeed: number;
  readonly extinctAtTick?: TickIndex;
}

export interface Lineage {
  readonly id: LineageId;
  readonly worldId: WorldId;
  readonly agentId: AgentId;
  readonly name: string;
  readonly foundedAtTick: TickIndex;
  /** Region the founding cell appeared in. Stable for the life of the lineage. */
  readonly originRegionId: RegionId;
  readonly generations: number;
  readonly births: number;
  readonly deaths: number;
  readonly livingCount: number;
  /** Running mean genome across living members, for lineage-level presentation. */
  readonly meanGenotype: Genotype;
  /**
   * The genome this lineage started from. Fixed for life.
   *
   * Drift is measured against this rather than against `meanGenotype`, because the mean tracks
   * the living population and therefore chases it: measured over 3000 ticks, a newborn sits a
   * flat ~10 from its lineage mean no matter how long the world has run, while distance from the
   * founding genome grows steadily past 50. Only a fixed reference can register that a lineage
   * has become a different kind of thing.
   */
  readonly foundingGenotype: Genotype;
  readonly extinctAtTick?: TickIndex;
}

/** One node of the genealogy tree. Bounded and append-only. */
export interface LineageNode {
  readonly organismId: OrganismId;
  readonly lineageId: LineageId;
  readonly parentOrganismId?: OrganismId;
  readonly bornAtTick: TickIndex;
  readonly diedAtTick?: TickIndex;
  readonly generation: number;
  readonly causeOfDeath?: DeathCause;
  readonly complexity: number;
}

/**
 * Every way an organism can die.
 *
 * Declared as a const array rather than a bare union so the glossary, the API schema and any
 * completeness test all read from one source: adding a cause here surfaces it everywhere.
 */
export const DEATH_CAUSES = ['starvation', 'age', 'predation', 'environment', 'toxicity'] as const;

export type DeathCause = (typeof DEATH_CAUSES)[number];

/** Lifetime, non-heritable adaptation acquired by an individual organism. */
export interface LifetimeState {
  /** Per-trait lifetime emphasis in per-mille, bounded and decaying. Not inherited. */
  readonly emphasis: Readonly<Partial<Record<TraitId, PerMille>>>;
  /** Successful action counts, used by the deterministic policy for lifetime learning. */
  readonly successes: Readonly<Partial<Record<string, number>>>;
  readonly failures: Readonly<Partial<Record<string, number>>>;
}

export const MAX_TRAIT_EMPHASIS: PerMille = 250;

export interface InventoryEntry {
  readonly materialId: MaterialId;
  readonly quantity: Mu;
}

export const MAX_INVENTORY_ENTRIES = 8;

export interface Organism {
  readonly id: OrganismId;
  readonly worldId: WorldId;
  readonly agentId: AgentId;
  readonly lineageId: LineageId;
  readonly regionId: RegionId;
  readonly position: Position;
  readonly genotype: Genotype;
  readonly lifetime: LifetimeState;
  readonly energy: Eu;
  readonly health: Hp;
  readonly ageTicks: number;
  readonly bornAtTick: TickIndex;
  readonly generation: number;
  readonly parentOrganismId?: OrganismId;
  readonly inventory: readonly InventoryEntry[];
  /** Tick when this organism may next attempt reproduction. */
  readonly reproductionReadyTick: TickIndex;
  /** Structure the organism is currently attached to, if any. */
  readonly attachedStructureId?: StructureId;
  readonly alive: boolean;
  readonly diedAtTick?: TickIndex;
  readonly causeOfDeath?: DeathCause;
}

/** A signal emitted into a region, visible to organisms within range for one tick window. */
export interface Signal {
  readonly organismId: OrganismId;
  readonly lineageId: LineageId;
  readonly agentId: AgentId;
  readonly position: Position;
  readonly regionId: RegionId;
  readonly channel: SignalChannel;
  readonly intensity: PerMille;
  readonly radiusCu: number;
  readonly emittedAtTick: TickIndex;
  /** Optional payload: a recipe the emitter is teaching. Only carried by `teach` signals. */
  readonly recipe?: KnownRecipe;
}

export const SIGNAL_CHANNELS = ['alarm', 'food', 'mate', 'teach', 'claim'] as const;
export type SignalChannel = (typeof SIGNAL_CHANNELS)[number];

/** Signals persist for this many ticks before expiring. */
export const SIGNAL_LIFETIME_TICKS = 2;
