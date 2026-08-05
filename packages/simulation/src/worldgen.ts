import {
  BASE_MATERIALS,
  DEFAULT_CALENDAR,
  Prng,
  TerrainField,
  WORLD_SPAN_CU,
  REGION_GRID,
  REGION_SPAN_CU,
  allRegionIds,
  asAgentId,
  asCreatorId,
  asLineageId,
  asMaterialId,
  asOrganismId,
  asResourceNodeId,
  asWorldId,
  biomeForElevation,
  clampPerMille,
  complexityScore,
  derivePhenotype,
  hashSeed,
  makePosition,
  normaliseGenotype,
  regionCoordFromId,
  regionIdOf,
  seedGenotype,
  type Agent,
  type AgentId,
  type Biome,
  type Drives,
  type Genotype,
  type HabitatPreference,
  type Lineage,
  type LineageId,
  type LineageNode,
  type MaterialDefinition,
  type MaterialId,
  type Organism,
  type OrganismId,
  type Position,
  type Region,
  type RegionId,
  type ResourceNode,
  type ResourceNodeId,
  type Temperament,
  type TickIndex,
  type TraitId,
  type World,
  type WorldId,
} from '@autocosm/domain';
import type { WorldState } from './state.js';
import { DEFAULT_SIMULATION_CONFIG, type SimulationConfig } from './config.js';

/**
 * World generation.
 *
 * Everything below is a pure function of the world seed. Regenerating a world from the same
 * seed produces byte-identical terrain, resources and founding lineages, which is what makes
 * the local demo reproducible without any cloud service.
 */

/** Founding lineage archetypes seeded into every new world. */
export interface Archetype {
  readonly key: string;
  readonly name: string;
  readonly aspiration: string;
  readonly habitat: HabitatPreference;
  readonly temperament: Temperament;
  readonly drives: Drives;
  readonly traits: Partial<Record<TraitId, number>>;
  readonly founders: number;
}

function drives(
  survive: number,
  forage: number,
  reproduce: number,
  explore: number,
  cooperate: number,
  build: number,
): Drives {
  return Object.freeze({ survive, forage, reproduce, explore, cooperate, build });
}

/**
 * The eight seeded lineages.
 *
 * They are deliberately unequal: some are fragile, some are slow, some cannot build at all.
 * The Weavers are the only lineage that begins above the manipulation threshold, so the
 * first constructions in a fresh world are theirs — and other lineages must discover them.
 */
export const ARCHETYPES: readonly Archetype[] = Object.freeze([
  {
    key: 'drifters',
    name: 'Drifters',
    aspiration: 'Ride the currents and turn light into life.',
    habitat: 'shallows',
    temperament: 'cautious',
    drives: drives(700, 600, 620, 300, 250, 60),
    traits: {
      photosynthesis: 700,
      buoyancy: 820,
      motility: 140,
      bodySize: 120,
      energyReserve: 380,
    },
    founders: 4,
  },
  {
    key: 'grazers',
    name: 'Grazers',
    aspiration: 'Find the richest fields and never go hungry.',
    habitat: 'shore',
    temperament: 'balanced',
    drives: drives(650, 820, 560, 480, 300, 80),
    traits: { motility: 620, chemoreception: 600, metabolicRate: 520, bodySize: 300 },
    founders: 4,
  },
  {
    key: 'anchorites',
    name: 'Anchorites',
    aspiration: 'Hold one place and outlast every storm.',
    habitat: 'shore',
    temperament: 'solitary',
    drives: drives(880, 420, 500, 60, 120, 200),
    traits: {
      photosynthesis: 620,
      armor: 620,
      motility: 60,
      thermalTolerance: 560,
      longevity: 620,
      bodySize: 380,
    },
    founders: 3,
  },
  {
    key: 'hunters',
    name: 'Hunters',
    aspiration: 'Take what the slow cannot keep.',
    habitat: 'plain',
    temperament: 'bold',
    drives: drives(600, 700, 540, 620, 100, 60),
    traits: { aggression: 720, motility: 700, bodySize: 520, chemoreception: 480, armor: 260 },
    founders: 3,
  },
  {
    key: 'weavers',
    name: 'Weavers',
    aspiration: 'Build shelters that outlive us.',
    habitat: 'shore',
    temperament: 'balanced',
    drives: drives(620, 620, 480, 380, 520, 900),
    traits: {
      manipulation: 780,
      memoryCapacity: 620,
      perceptionRange: 460,
      chemoreception: 460,
      motility: 380,
      armor: 120,
      energyReserve: 520,
      metabolicRate: 520,
    },
    founders: 4,
  },
  {
    key: 'chorus',
    name: 'Chorus',
    aspiration: 'Let no discovery be lost to silence.',
    habitat: 'shore',
    temperament: 'gregarious',
    drives: drives(600, 620, 520, 460, 880, 420),
    traits: {
      sociality: 760,
      signalStrength: 700,
      memoryCapacity: 560,
      perceptionRange: 420,
      motility: 400,
      manipulation: 300,
    },
    founders: 4,
  },
  {
    key: 'delvers',
    name: 'Delvers',
    aspiration: 'Eat the stone others fear.',
    habitat: 'highland',
    temperament: 'solitary',
    drives: drives(760, 700, 480, 420, 160, 300),
    traits: {
      toxinResistance: 760,
      armor: 560,
      thermalTolerance: 620,
      chemoreception: 520,
      buoyancy: 120,
      manipulation: 320,
    },
    founders: 3,
  },
  {
    key: 'seers',
    name: 'Seers',
    aspiration: 'Understand the world before it changes us.',
    habitat: 'plain',
    temperament: 'cautious',
    drives: drives(700, 560, 460, 780, 420, 300),
    traits: {
      perceptionRange: 720,
      photoreception: 680,
      memoryCapacity: 700,
      learningRate: 520,
      planningDepth: 460,
      motility: 420,
      energyReserve: 520,
      manipulation: 240,
    },
    founders: 3,
  },
]);

export interface GenerateWorldOptions {
  readonly worldId?: string;
  readonly name?: string;
  readonly seed: number;
  readonly config?: SimulationConfig;
  readonly systemCreatorId?: string;
}

/** The creator identity attributed to the seeded lineages. */
export const SYSTEM_CREATOR_ID = 'system-genesis';

export function generateWorld(options: GenerateWorldOptions): WorldState {
  const config = options.config ?? DEFAULT_SIMULATION_CONFIG;
  const worldId = asWorldId(options.worldId ?? 'genesis');
  const seed = options.seed >>> 0;
  const terrain = new TerrainField(seed);
  const creatorId = asCreatorId(options.systemCreatorId ?? SYSTEM_CREATOR_ID);

  const regions = new Map<RegionId, Region>();
  for (const regionId of allRegionIds()) {
    regions.set(regionId, buildRegion(worldId, regionId, terrain, seed));
  }

  const materials = new Map<MaterialId, MaterialDefinition>();
  for (const material of BASE_MATERIALS) {
    materials.set(material.id, material);
  }

  const resources = new Map<ResourceNodeId, ResourceNode>();
  for (const regionId of allRegionIds()) {
    const region = regions.get(regionId);
    if (!region) continue;
    for (const node of buildResourceNodes(regionId, region, seed)) {
      resources.set(node.id, node);
    }
  }

  const agents = new Map<AgentId, Agent>();
  const lineages = new Map<LineageId, Lineage>();
  const organisms = new Map<OrganismId, Organism>();
  const lineageNodes = new Map<OrganismId, LineageNode>();

  ARCHETYPES.forEach((archetype, index) => {
    const rng = new Prng(hashSeed('archetype', seed, archetype.key));
    const agentId = asAgentId(`ag-${archetype.key}`);
    const lineageId = asLineageId(`ln-${archetype.key}`);
    const genotype = normaliseGenotype({ ...seedGenotype(), ...archetype.traits });

    agents.set(agentId, {
      id: agentId,
      worldId,
      lineageId,
      name: archetype.name,
      createdByCreatorId: creatorId,
      createdAtTick: 0,
      status: 'active',
      drives: archetype.drives,
      temperament: archetype.temperament,
      habitat: archetype.habitat,
      aspiration: archetype.aspiration,
      knowledge: { knownMaterialIds: [], recipes: [], knownStructureIds: [] },
      lastDecisionTick: 0,
      decisionCount: 0,
      visualSeed: hashSeed('visual', archetype.key) % 65_536,
    });

    const anchor = habitatAnchor(terrain, archetype.habitat, seed, index);

    lineages.set(lineageId, {
      id: lineageId,
      worldId,
      agentId,
      name: archetype.name,
      foundedAtTick: 0,
      originRegionId: regionIdOf(anchor),
      generations: 1,
      births: archetype.founders,
      deaths: 0,
      livingCount: archetype.founders,
      meanGenotype: genotype,
    });

    for (let i = 0; i < archetype.founders; i += 1) {
      const organismId = asOrganismId(`or-${archetype.key}-${i}`);
      const position = scatter(anchor, rng, 900);
      const organism = foundingOrganism({
        organismId,
        worldId,
        agentId,
        lineageId,
        genotype,
        position,
        tick: 0,
      });
      organisms.set(organismId, organism);
      lineageNodes.set(organismId, foundingNode(organismId, lineageId, genotype));
    }
  });

  const world: World = {
    id: worldId,
    name: options.name ?? 'Autocosm Genesis',
    seed,
    tick: 0,
    createdAtTick: 0,
    calendar: DEFAULT_CALENDAR,
    pressure: { kind: 'calm', startedAtTick: 0, endsAtTick: 0, severity: 0 },
    stats: {
      livingOrganisms: organisms.size,
      activeLineages: lineages.size,
      extinctLineages: 0,
      structures: 0,
      discoveredMaterials: materials.size,
      totalBirths: organisms.size,
      totalDeaths: 0,
    },
  };

  void config;

  return {
    world,
    terrain,
    regions,
    agents,
    lineages,
    lineageNodes,
    organisms,
    materials,
    resources,
    structures: new Map(),
    memories: new Map(),
    goals: new Map(),
    signals: [],
  };
}

function foundingNode(
  organismId: OrganismId,
  lineageId: LineageId,
  genotype: Genotype,
): LineageNode {
  return {
    organismId,
    lineageId,
    bornAtTick: 0,
    generation: 0,
    complexity: complexityScore(genotype),
  };
}

interface FoundingArgs {
  readonly organismId: OrganismId;
  readonly worldId: WorldId;
  readonly agentId: AgentId;
  readonly lineageId: LineageId;
  readonly genotype: Genotype;
  readonly position: Position;
  readonly tick: TickIndex;
}

/** Create a viable basic cell. Viable means "able to act", never "guaranteed to survive". */
export function foundingOrganism(args: FoundingArgs): Organism {
  const phenotype = derivePhenotype(args.genotype);
  return {
    id: args.organismId,
    worldId: args.worldId,
    agentId: args.agentId,
    lineageId: args.lineageId,
    regionId: regionIdOf(args.position),
    position: args.position,
    genotype: args.genotype,
    lifetime: { emphasis: {}, successes: {}, failures: {} },
    energy: Math.trunc((phenotype.maxEnergy * 3) / 4),
    health: phenotype.maxHealth,
    ageTicks: 0,
    bornAtTick: args.tick,
    generation: 0,
    inventory: [],
    reproductionReadyTick: args.tick + phenotype.maturityAgeTicks,
    alive: true,
  };
}

function buildRegion(
  worldId: WorldId,
  regionId: RegionId,
  terrain: TerrainField,
  seed: number,
): Region {
  const coord = regionCoordFromId(regionId) ?? { col: 0, row: 0 };
  const survey = terrain.survey(
    coord.col * REGION_SPAN_CU,
    coord.row * REGION_SPAN_CU,
    REGION_SPAN_CU,
  );
  const biome: Biome = biomeForElevation(survey.meanElevationCu);
  const rng = new Prng(hashSeed('region', seed, regionId));
  // Equatorial rows are warmer; the poles of the toroidal world are cooler.
  const latitude = Math.abs(coord.row - (REGION_GRID - 1) / 2) / ((REGION_GRID - 1) / 2);
  const baseTemperature = clampPerMille(
    Math.trunc(760 - latitude * 320 - survey.meanElevationCu / 24 + rng.nextRange(-40, 40)),
  );
  const lightModifier = clampPerMille(
    survey.meanElevationCu < -1200 ? 260 : survey.meanElevationCu < 0 ? 720 : 1000,
  );
  const mineralRichness = clampPerMille(
    240 + Math.trunc(survey.meanElevationCu / 12) + rng.nextRange(0, 220),
  );
  const biomass = Math.max(
    120,
    Math.trunc((lightModifier * 3 + survey.waterCoveragePerMille * 2) / 2) + rng.nextRange(0, 400),
  );

  return {
    id: regionId,
    worldId,
    biome,
    meanElevationCu: survey.meanElevationCu,
    waterCoverage: clampPerMille(survey.waterCoveragePerMille),
    baseTemperature,
    lightModifier,
    mineralRichness,
    biomass,
  };
}

/** Material availability by biome. Constrains what a lineage can possibly discover locally. */
const BIOME_MATERIALS: Readonly<Record<Biome, readonly string[]>> = Object.freeze({
  abyss: ['silt', 'mineralSalt', 'stone', 'biofilm'],
  shallows: ['silt', 'algaeMat', 'biofilm', 'sand', 'fibre'],
  shore: ['sand', 'clay', 'fibre', 'algaeMat', 'resin', 'biofilm'],
  plain: ['clay', 'fibre', 'resin', 'chitin', 'sand', 'toxinSac'],
  highland: ['stone', 'mineralSalt', 'chitin', 'clay', 'carapaceShard'],
  ridge: ['stone', 'lightCrystal', 'mineralSalt', 'carapaceShard'],
});

function buildResourceNodes(regionId: RegionId, region: Region, seed: number): ResourceNode[] {
  const coord = regionCoordFromId(regionId) ?? { col: 0, row: 0 };
  const rng = new Prng(hashSeed('resources', seed, regionId));
  const palette = BIOME_MATERIALS[region.biome];
  // Density is tuned so a typical perception radius usually contains at least one deposit.
  // Sparser than this and material-gathering — and therefore construction — never emerges.
  const count = 14 + rng.nextInt(9);
  const nodes: ResourceNode[] = [];
  for (let i = 0; i < count; i += 1) {
    const materialKey = palette[rng.nextInt(palette.length)] ?? 'silt';
    const position = makePosition(
      coord.col * REGION_SPAN_CU + rng.nextInt(REGION_SPAN_CU),
      coord.row * REGION_SPAN_CU + rng.nextInt(REGION_SPAN_CU),
    );
    const organic = ['algaeMat', 'biofilm', 'fibre', 'resin', 'toxinSac'].includes(materialKey);
    const capacity = organic ? 260 + rng.nextInt(340) : 420 + rng.nextInt(620);
    nodes.push({
      id: asResourceNodeId(`rn-${regionId}-${i}`),
      regionId,
      position,
      materialId: asMaterialId(materialKey),
      quantity: capacity,
      // Organic deposits regrow; mineral deposits are finite until something recycles them.
      regenPerTick: organic ? 1 + rng.nextInt(3) : 0,
      capacity,
    });
  }
  return nodes;
}

/** Deterministically find a position matching a habitat preference. */
export function habitatAnchor(
  terrain: TerrainField,
  habitat: HabitatPreference,
  seed: number,
  salt: number,
): Position {
  const rng = new Prng(hashSeed('habitat', seed, habitat, salt));
  const band = HABITAT_BANDS[habitat];
  let best: Position = makePosition(rng.nextInt(WORLD_SPAN_CU), rng.nextInt(WORLD_SPAN_CU));
  let bestScore = Number.POSITIVE_INFINITY;
  // Bounded search: 96 candidate samples, then keep the closest match to the target band.
  for (let i = 0; i < 96; i += 1) {
    const candidate = makePosition(rng.nextInt(WORLD_SPAN_CU), rng.nextInt(WORLD_SPAN_CU));
    const elevation = terrain.elevationAtPosition(candidate);
    const score =
      elevation < band[0] ? band[0] - elevation : elevation > band[1] ? elevation - band[1] : 0;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      if (score === 0) break;
    }
  }
  return best;
}

const HABITAT_BANDS: Readonly<Record<HabitatPreference, readonly [number, number]>> = Object.freeze(
  {
    abyss: [-2400, -1200],
    shallows: [-1200, -150],
    shore: [-150, 150],
    plain: [150, 1100],
    highland: [1100, 2200],
  },
);

function scatter(anchor: Position, rng: Prng, radiusCu: number): Position {
  return makePosition(
    anchor.x + rng.nextRange(-radiusCu, radiusCu),
    anchor.z + rng.nextRange(-radiusCu, radiusCu),
  );
}
