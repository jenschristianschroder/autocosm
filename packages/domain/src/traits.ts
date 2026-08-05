import { type PerMille, clampPerMille, isqrt, scaleByPerMille, toInt } from './units.js';

/**
 * Heritable traits.
 *
 * Every trait is expressed in per-mille (0..1000) and every trait carries a real cost.
 * There is deliberately no linear upgrade ladder: raising any trait raises upkeep, mass,
 * or an opposing capability, so a genome that maximises everything starves.
 *
 * Cognition is not purchasable. `planningDepth` only becomes *effective* when sensing,
 * memory and spare energy support it (see {@link derivePhenotype}); paying for it without
 * that support is a pure loss.
 */
export const TRAIT_IDS = [
  // Metabolism
  'metabolicRate',
  'energyReserve',
  'photosynthesis',
  'thermalTolerance',
  'toxinResistance',
  // Movement
  'motility',
  'buoyancy',
  'bodySize',
  // Sensing
  'photoreception',
  'chemoreception',
  'perceptionRange',
  // Defence
  'armor',
  'regeneration',
  'camouflage',
  // Social
  'aggression',
  'sociality',
  'signalStrength',
  // Cognition
  'memoryCapacity',
  'learningRate',
  'planningDepth',
  // Manipulation
  'manipulation',
  // Life history
  'reproductiveInvestment',
  'mutability',
  'longevity',
] as const;

export type TraitId = (typeof TRAIT_IDS)[number];

export type TraitCategory =
  | 'metabolism'
  | 'movement'
  | 'sensing'
  | 'defence'
  | 'social'
  | 'cognition'
  | 'manipulation'
  | 'lifeHistory';

export interface TraitDefinition {
  readonly id: TraitId;
  readonly category: TraitCategory;
  readonly label: string;
  readonly benefit: string;
  /** The cost paid for expressing this trait. Never empty: every trait trades something. */
  readonly cost: string;
  /** Energy upkeep per tick at full expression, in `eu`. */
  readonly upkeepAtFull: number;
  /** Body mass added at full expression, in `mu`. Mass slows movement and raises upkeep. */
  readonly massAtFull: number;
  /** Traits whose effectiveness this trait actively suppresses. */
  readonly suppresses: readonly TraitId[];
  /** Default expression for a freshly authored basic cell. */
  readonly seedValue: PerMille;
}

/**
 * The trait catalogue.
 *
 * `upkeepAtFull + massAtFull > 0` for every entry; a regression test enforces it so a
 * future "free" trait cannot silently create a linear upgrade ladder.
 */
export const TRAIT_CATALOGUE: Readonly<Record<TraitId, TraitDefinition>> = Object.freeze({
  metabolicRate: {
    id: 'metabolicRate',
    category: 'metabolism',
    label: 'Metabolic rate',
    benefit: 'Converts consumed biomass and minerals into usable energy faster.',
    cost: 'Burns reserve energy every tick even while resting, and shortens lifespan.',
    upkeepAtFull: 9,
    massAtFull: 0,
    suppresses: ['longevity'],
    seedValue: 400,
  },
  energyReserve: {
    id: 'energyReserve',
    category: 'metabolism',
    label: 'Energy reserve',
    benefit: 'Raises maximum stored energy, buffering famine and long journeys.',
    cost: 'Stored reserve is carried mass, slowing movement and raising upkeep.',
    upkeepAtFull: 3,
    massAtFull: 90,
    suppresses: ['motility'],
    seedValue: 300,
  },
  photosynthesis: {
    id: 'photosynthesis',
    category: 'metabolism',
    label: 'Photosynthesis',
    benefit: 'Harvests ambient light into energy without foraging.',
    cost: 'Requires exposed surface: heavily penalises movement and raises predation risk.',
    upkeepAtFull: 2,
    massAtFull: 40,
    suppresses: ['motility', 'camouflage'],
    seedValue: 250,
  },
  thermalTolerance: {
    id: 'thermalTolerance',
    category: 'metabolism',
    label: 'Thermal tolerance',
    benefit: 'Survives heat waves and cold snaps with reduced damage.',
    cost: 'Insulating tissue costs constant upkeep whether or not the weather is extreme.',
    upkeepAtFull: 6,
    massAtFull: 30,
    suppresses: [],
    seedValue: 200,
  },
  toxinResistance: {
    id: 'toxinResistance',
    category: 'metabolism',
    label: 'Toxin resistance',
    benefit: 'Allows feeding on toxic materials and blunts toxic defences.',
    cost: 'Detoxification runs continuously and competes with growth.',
    upkeepAtFull: 5,
    massAtFull: 20,
    suppresses: ['regeneration'],
    seedValue: 150,
  },
  motility: {
    id: 'motility',
    category: 'movement',
    label: 'Motility',
    benefit: 'Increases distance covered per tick.',
    cost: 'Locomotive tissue is expensive to maintain and to use.',
    upkeepAtFull: 7,
    massAtFull: 40,
    suppresses: ['photosynthesis'],
    seedValue: 350,
  },
  buoyancy: {
    id: 'buoyancy',
    category: 'movement',
    label: 'Buoyancy',
    benefit: 'Moves efficiently through water and resists sinking.',
    cost: 'Low-density tissue is fragile on land and reduces effective armour.',
    upkeepAtFull: 2,
    massAtFull: 10,
    suppresses: ['armor'],
    seedValue: 500,
  },
  bodySize: {
    id: 'bodySize',
    category: 'movement',
    label: 'Body size',
    benefit: 'More health, more carrying capacity and more attack force.',
    cost: 'Large bodies are slow, hungry and highly visible.',
    upkeepAtFull: 8,
    massAtFull: 220,
    suppresses: ['camouflage'],
    seedValue: 250,
  },
  photoreception: {
    id: 'photoreception',
    category: 'sensing',
    label: 'Photoreception',
    benefit: 'Senses light gradients and distant shapes during the day.',
    cost: 'Useless in darkness, and neural upkeep is paid regardless.',
    upkeepAtFull: 4,
    massAtFull: 10,
    suppresses: [],
    seedValue: 200,
  },
  chemoreception: {
    id: 'chemoreception',
    category: 'sensing',
    label: 'Chemoreception',
    benefit: 'Senses resources and organisms chemically, day or night.',
    cost: 'Short ranged and easily saturated in dense biomass.',
    upkeepAtFull: 4,
    massAtFull: 8,
    suppresses: [],
    seedValue: 250,
  },
  perceptionRange: {
    id: 'perceptionRange',
    category: 'sensing',
    label: 'Perception range',
    benefit: 'Widens the observation radius supplied to the agent.',
    cost: 'Wide sensing costs energy and floods limited memory with noise.',
    upkeepAtFull: 8,
    massAtFull: 14,
    suppresses: [],
    seedValue: 220,
  },
  armor: {
    id: 'armor',
    category: 'defence',
    label: 'Armour',
    benefit: 'Absorbs damage from attacks and environmental abrasion.',
    cost: 'Heavy plating slows movement and blocks nutrient exchange.',
    upkeepAtFull: 5,
    massAtFull: 160,
    suppresses: ['motility', 'regeneration'],
    seedValue: 150,
  },
  regeneration: {
    id: 'regeneration',
    category: 'defence',
    label: 'Regeneration',
    benefit: 'Repairs damage each tick.',
    cost: 'Repair draws directly on energy that would otherwise fund reproduction.',
    upkeepAtFull: 7,
    massAtFull: 10,
    suppresses: [],
    seedValue: 200,
  },
  camouflage: {
    id: 'camouflage',
    category: 'defence',
    label: 'Camouflage',
    benefit: 'Reduces the range at which other organisms can perceive this one.',
    cost: 'Suppresses signalling: a hidden organism is also hard to cooperate with.',
    upkeepAtFull: 3,
    massAtFull: 6,
    suppresses: ['signalStrength'],
    seedValue: 200,
  },
  aggression: {
    id: 'aggression',
    category: 'social',
    label: 'Aggression',
    benefit: 'Raises attack force and willingness to take contested resources.',
    cost: 'Invites retaliation and suppresses cooperative sharing.',
    upkeepAtFull: 4,
    massAtFull: 20,
    suppresses: ['sociality'],
    seedValue: 200,
  },
  sociality: {
    id: 'sociality',
    category: 'social',
    label: 'Sociality',
    benefit: 'Enables sharing, aggregation bonuses and cultural transmission.',
    cost: 'Sharing gives away energy and suppresses individual aggression.',
    upkeepAtFull: 3,
    massAtFull: 8,
    suppresses: ['aggression'],
    seedValue: 250,
  },
  signalStrength: {
    id: 'signalStrength',
    category: 'social',
    label: 'Signal strength',
    benefit: 'Broadcasts further, enabling knowledge transfer across a lineage.',
    cost: 'Loud signals cost energy and are overheard by predators.',
    upkeepAtFull: 4,
    massAtFull: 8,
    suppresses: ['camouflage'],
    seedValue: 180,
  },
  memoryCapacity: {
    id: 'memoryCapacity',
    category: 'cognition',
    label: 'Memory capacity',
    benefit: 'Retains more experiences, which is a prerequisite for planning and culture.',
    cost: 'Neural tissue is metabolically expensive and slow to mature.',
    upkeepAtFull: 9,
    massAtFull: 24,
    suppresses: [],
    seedValue: 150,
  },
  learningRate: {
    id: 'learningRate',
    category: 'cognition',
    label: 'Learning rate',
    benefit: 'Adapts lifetime behaviour faster from outcomes.',
    cost: 'Rapid adaptation destabilises previously learned behaviour and costs energy.',
    upkeepAtFull: 6,
    massAtFull: 10,
    suppresses: [],
    seedValue: 150,
  },
  planningDepth: {
    id: 'planningDepth',
    category: 'cognition',
    label: 'Planning depth',
    benefit: 'Supports multi-step deliberation — but only when sensing, memory and energy allow.',
    cost: 'The most expensive trait in the genome, and worthless without supporting traits.',
    upkeepAtFull: 14,
    massAtFull: 30,
    suppresses: [],
    seedValue: 80,
  },
  manipulation: {
    id: 'manipulation',
    category: 'manipulation',
    label: 'Manipulation',
    benefit: 'Collects, combines and builds with discovered materials.',
    cost: 'Manipulative appendages are fragile and reduce movement efficiency.',
    upkeepAtFull: 6,
    massAtFull: 34,
    suppresses: ['motility'],
    seedValue: 120,
  },
  reproductiveInvestment: {
    id: 'reproductiveInvestment',
    category: 'lifeHistory',
    label: 'Reproductive investment',
    benefit: 'Endows offspring with more starting energy and a higher survival chance.',
    cost: 'Fewer offspring per unit of energy and a longer recovery before reproducing again.',
    upkeepAtFull: 2,
    massAtFull: 16,
    suppresses: [],
    seedValue: 400,
  },
  mutability: {
    id: 'mutability',
    category: 'lifeHistory',
    label: 'Mutability',
    benefit: 'Explores genotype space faster, which matters under environmental pressure.',
    cost: 'Most mutations are deleterious; high mutability destabilises a working genome.',
    upkeepAtFull: 1,
    massAtFull: 0,
    suppresses: ['longevity'],
    seedValue: 300,
  },
  longevity: {
    id: 'longevity',
    category: 'lifeHistory',
    label: 'Longevity',
    benefit: 'Extends maximum age, allowing more lifetime learning.',
    cost: 'Maintenance upkeep rises and sexual maturity arrives later.',
    upkeepAtFull: 5,
    massAtFull: 12,
    suppresses: ['metabolicRate'],
    seedValue: 300,
  },
} satisfies Record<TraitId, TraitDefinition>);

/** A genome: one per-mille expression level per heritable trait. */
export type Genotype = Readonly<Record<TraitId, PerMille>>;

/** The genome of a newly authored basic cell before creator biases are applied. */
export function seedGenotype(): Genotype {
  const out: Partial<Record<TraitId, PerMille>> = {};
  for (const id of TRAIT_IDS) {
    out[id] = TRAIT_CATALOGUE[id].seedValue;
  }
  return Object.freeze(out as Record<TraitId, PerMille>);
}

/** Normalise an untrusted partial genome into a complete, clamped genome. */
export function normaliseGenotype(input: Partial<Record<TraitId, number>>): Genotype {
  const seed = seedGenotype();
  const out: Partial<Record<TraitId, PerMille>> = {};
  for (const id of TRAIT_IDS) {
    const raw = input[id];
    out[id] = raw === undefined ? seed[id] : clampPerMille(raw);
  }
  return Object.freeze(out as Record<TraitId, PerMille>);
}

/**
 * Effective expression of a trait after suppression by antagonistic traits.
 *
 * Suppression is what turns the trait list into a set of tradeoffs rather than a ladder:
 * armour genuinely costs mobility, size genuinely costs concealment, and so on.
 */
export function effectiveTrait(genotype: Genotype, id: TraitId): PerMille {
  const base = genotype[id];
  let suppression = 0;
  for (const other of TRAIT_IDS) {
    if (TRAIT_CATALOGUE[other].suppresses.includes(id)) {
      suppression += Math.trunc(genotype[other] / 2);
    }
  }
  return clampPerMille(base - Math.trunc((base * Math.min(900, suppression)) / 2000));
}

/** Derived, non-heritable body statistics computed from a genome and its context. */
export interface Phenotype {
  /** Body mass in `mu`. */
  readonly mass: number;
  /** Energy consumed per tick just to stay alive, in `eu`. */
  readonly upkeepPerTick: number;
  /** Maximum storable energy, in `eu`. */
  readonly maxEnergy: number;
  /** Maximum health, in `hp`. */
  readonly maxHealth: number;
  /** Distance covered per movement action, in `cu`. */
  readonly speedCuPerTick: number;
  /** Energy consumed per 100 cu travelled, in `eu`. */
  readonly moveCostPer100Cu: number;
  /** Observation radius supplied to the agent, in `cu`. */
  readonly perceptionRadiusCu: number;
  /** Radius at which other organisms can perceive this one, in `cu`. */
  readonly conspicuityRadiusCu: number;
  /** Damage inflicted by a successful attack, in `hp`. */
  readonly attackPower: number;
  /** Damage absorbed per incoming attack, in `hp`. */
  readonly defence: number;
  /** Health restored per tick when energy allows, in `hp`. */
  readonly regenerationPerTick: number;
  /** Passive energy captured per tick at full ambient light, in `eu`. */
  readonly photosynthesisAtFullLight: number;
  /** Number of retained memories. */
  readonly memorySlots: number;
  /** Distance a signal carries, in `cu`. */
  readonly signalRadiusCu: number;
  /**
   * Deliberation actually available to the agent, in `[0, 1000]`.
   *
   * This is the emergence rule: planning is capped by sensory input, memory and spare
   * energy. A genome with maximal `planningDepth` and nothing to support it thinks no
   * better than a cell, while still paying full upkeep.
   */
  readonly effectivePlanning: PerMille;
  /** Capacity to collect, combine and build, in `[0, 1000]`. */
  readonly manipulationScore: PerMille;
  /** Maximum age in ticks. */
  readonly maxAgeTicks: number;
  /** Age in ticks at which reproduction becomes possible. */
  readonly maturityAgeTicks: number;
  /** Energy required to attempt reproduction, in `eu`. */
  readonly reproductionCost: number;
  /** Probability, in per-mille, that a given trait mutates during reproduction. */
  readonly mutationChancePerMille: PerMille;
}

const BASE_MASS = 60;
const BASE_UPKEEP = 3;
const BASE_ENERGY = 220;
const BASE_HEALTH = 40;
const BASE_SPEED_CU = 260;
const BASE_PERCEPTION_CU = 420;
const BASE_AGE_TICKS = 340;

/**
 * Compute the derived body from a genome.
 *
 * Pure and integral: the same genome always yields the same phenotype.
 */
export function derivePhenotype(genotype: Genotype): Phenotype {
  let mass = BASE_MASS;
  let upkeep = BASE_UPKEEP;
  for (const id of TRAIT_IDS) {
    const def = TRAIT_CATALOGUE[id];
    const value = genotype[id];
    mass += scaleByPerMille(def.massAtFull, value);
    upkeep += scaleByPerMille(def.upkeepAtFull, value);
  }
  // Carrying mass is itself metabolically expensive.
  upkeep += Math.trunc(mass / 90);

  const eff = (id: TraitId): PerMille => effectiveTrait(genotype, id);

  const motility = eff('motility');
  const size = eff('bodySize');
  const armor = eff('armor');
  const reserve = genotype.energyReserve;

  const maxEnergy = BASE_ENERGY + scaleByPerMille(900, reserve) + scaleByPerMille(300, size);
  const maxHealth = BASE_HEALTH + scaleByPerMille(160, size) + scaleByPerMille(90, armor);

  // Mass resists motion: speed falls as mass rises, and never reaches zero.
  const speedCuPerTick = Math.max(
    20,
    Math.trunc((BASE_SPEED_CU * (200 + motility)) / 1200 / (1 + Math.trunc(mass / 260))),
  );
  const moveCostPer100Cu = Math.max(1, 1 + Math.trunc(mass / 70));

  const sensory = Math.trunc(
    (eff('perceptionRange') * 2 + eff('photoreception') + eff('chemoreception')) / 4,
  );
  const perceptionRadiusCu = BASE_PERCEPTION_CU + scaleByPerMille(2600, sensory);
  const conspicuityRadiusCu = Math.max(
    80,
    BASE_PERCEPTION_CU + scaleByPerMille(1400, size) - scaleByPerMille(1100, eff('camouflage')),
  );

  const attackPower = scaleByPerMille(26, eff('aggression')) + scaleByPerMille(20, size);
  const defence = scaleByPerMille(30, armor) + Math.trunc(scaleByPerMille(14, size) / 2);
  const regenerationPerTick = Math.trunc(scaleByPerMille(9, eff('regeneration')) / 2);
  const photosynthesisAtFullLight = scaleByPerMille(20, eff('photosynthesis'));

  const memorySlots = Math.min(24, Math.trunc(genotype.memoryCapacity / 60));
  const signalRadiusCu = scaleByPerMille(4200, eff('signalStrength'));

  // Emergent cognition. Deliberation is capped by the weakest supporting system.
  const memorySupport = clampPerMille(memorySlots * 55);
  const sensorySupport = clampPerMille(sensory);
  const energyHeadroom = clampPerMille(Math.trunc((maxEnergy * 1000) / Math.max(1, upkeep * 90)));
  const support = Math.min(memorySupport, sensorySupport, energyHeadroom);
  const effectivePlanning = clampPerMille(Math.min(genotype.planningDepth, support));

  const manipulationScore = clampPerMille(
    eff('manipulation') - Math.trunc(scaleByPerMille(eff('manipulation'), armor) / 3),
  );

  const maxAgeTicks =
    BASE_AGE_TICKS +
    scaleByPerMille(900, genotype.longevity) -
    scaleByPerMille(160, genotype.metabolicRate);
  const maturityAgeTicks = Math.max(
    12,
    Math.trunc(maxAgeTicks / 9) + scaleByPerMille(40, genotype.reproductiveInvestment),
  );
  const reproductionCost =
    Math.trunc(maxEnergy / 3) + scaleByPerMille(320, genotype.reproductiveInvestment);
  const mutationChancePerMille = clampPerMille(20 + Math.trunc(genotype.mutability / 5));

  return {
    mass,
    upkeepPerTick: Math.max(1, upkeep),
    maxEnergy,
    maxHealth,
    speedCuPerTick,
    moveCostPer100Cu,
    perceptionRadiusCu,
    conspicuityRadiusCu,
    attackPower,
    defence,
    regenerationPerTick,
    photosynthesisAtFullLight,
    memorySlots,
    signalRadiusCu,
    effectivePlanning,
    manipulationScore,
    maxAgeTicks: Math.max(60, maxAgeTicks),
    maturityAgeTicks,
    reproductionCost,
    mutationChancePerMille,
  };
}

/**
 * A compact visual seed derived from the genome.
 *
 * The browser renders organisms procedurally from these numbers, so inherited traits are
 * literally visible: armoured lineages look plated, photosynthetic lineages look broad and
 * green, motile lineages look streamlined.
 */
export interface VisualPhenotype {
  readonly hue: number;
  readonly saturation: PerMille;
  readonly luminance: PerMille;
  readonly scale: PerMille;
  readonly elongation: PerMille;
  readonly appendages: number;
  readonly spines: number;
  readonly plating: PerMille;
  readonly translucency: PerMille;
  readonly eyes: number;
  readonly glow: PerMille;
}

export function deriveVisual(genotype: Genotype): VisualPhenotype {
  const green = genotype.photosynthesis;
  const red = genotype.aggression;
  const blue = genotype.buoyancy;
  // Hue slides from ocean blue through leaf green to predatory amber.
  const hue =
    (200 +
      Math.trunc((green * 130) / 1000) -
      Math.trunc((red * 190) / 1000) +
      Math.trunc((blue * 20) / 1000) +
      360) %
    360;
  return {
    hue,
    saturation: clampPerMille(320 + Math.trunc((green + red) / 4)),
    luminance: clampPerMille(
      300 + Math.trunc(genotype.camouflage / -6) + Math.trunc(genotype.photoreception / 5),
    ),
    scale: clampPerMille(150 + Math.trunc((genotype.bodySize * 7) / 10)),
    elongation: clampPerMille(
      200 + Math.trunc(genotype.motility / 2) - Math.trunc(genotype.armor / 4),
    ),
    appendages: Math.min(8, Math.trunc((genotype.motility + genotype.manipulation) / 260)),
    spines: Math.min(12, Math.trunc((genotype.armor + genotype.aggression) / 200)),
    plating: clampPerMille(genotype.armor),
    translucency: clampPerMille(
      700 - Math.trunc(genotype.bodySize / 2) - Math.trunc(genotype.armor / 2),
    ),
    eyes: Math.min(6, Math.trunc(genotype.photoreception / 180)),
    glow: clampPerMille(
      Math.trunc(genotype.signalStrength / 2) + Math.trunc(genotype.photoreception / 6),
    ),
  };
}

/** Aggregate "how advanced is this lineage" score used only for presentation and sorting. */
export function complexityScore(genotype: Genotype): number {
  let total = 0;
  for (const id of TRAIT_IDS) {
    total += genotype[id];
  }
  return isqrt(toInt(total));
}
