import {
  MAX_INVENTORY_ENTRIES,
  MAX_OBSERVED_GOALS,
  MAX_OBSERVED_MEMORIES,
  MAX_OBSERVED_ORGANISMS,
  MAX_OBSERVED_RESOURCES,
  MAX_OBSERVED_SIGNALS,
  MAX_OBSERVED_STRUCTURES,
  ambientLightPerMille,
  clampPerMille,
  derivePhenotype,
  distance,
  regionNeighbourhood,
  scaleByPerMille,
  type Observation,
  type ObservedEnvironment,
  type ObservedGoal,
  type ObservedMemory,
  type ObservedOrganism,
  type ObservedResource,
  type ObservedSelf,
  type ObservedSignal,
  type ObservedStructure,
  type Organism,
  type Phenotype,
  type Structure,
} from '@autocosm/domain';
import { availableActions } from './capabilities.js';
import { DEFAULT_SIMULATION_CONFIG, type SimulationConfig } from './config.js';
import { sortedIds, countLivingOrganisms, type WorldState } from './state.js';
import {
  beaconRangeBonusCu,
  effectiveCarryCapacity,
  effectiveSpeedCuPerTick,
  structureEffectsAt,
} from './structure-effects.js';

/**
 * Extra sight range granted to a construction, in cu, capped by its own bulk. Structures are
 * static landmarks; organisms are not. A built object is legible — and therefore learnable —
 * from further away than a moving neighbour, which is what lets knowledge cross lineages.
 */
const STRUCTURE_LANDMARK_BONUS_CU = 1800;

/**
 * How far away a given construction is legible. Observation and action resolution must agree on
 * this, or an agent could see a structure it is then refused permission to inspect.
 *
 * Takes the structure rather than its volume so a `beacon`'s extra range cannot be applied at one
 * call site and forgotten at the other.
 */
export function structureVisibilityRadiusCu(
  perceptionRadiusCu: number,
  structure: Pick<Structure, 'volume' | 'functions' | 'integrity'>,
): number {
  return (
    perceptionRadiusCu +
    Math.min(STRUCTURE_LANDMARK_BONUS_CU, structure.volume * 8) +
    beaconRangeBonusCu(structure)
  );
}

/**
 * Extra sight range granted to a deposit, in cu, capped by how much of it is left. A seam of stone
 * or a crystal outcrop is a static feature of the terrain, not a moving animal, so the same
 * reasoning that makes a construction a landmark applies to it.
 *
 * This exists because deposit density was tuned against the sharpest eye in the world rather than
 * the median one. `buildResourceNodes` places 14-22 deposits in a 6000x6000 cu region and its
 * comment claims "a typical perception radius usually contains at least one" — measured at 1200
 * ticks, only 12/45 and 19/44 organisms could perceive *any* deposit, and 0/45 and 0/44 could
 * perceive one hard enough to build shelter with, in a world where 39 of 64 regions hold one.
 * The comment then names the exact consequence that followed: "sparser than this and
 * material-gathering — and therefore construction — never emerges."
 *
 * Scaling by remaining quantity means a rich seam is a landmark and an exhausted one fades back
 * into the ground, so this reveals where material *is* without flattening the search for it.
 */
const DEPOSIT_LANDMARK_BONUS_CU = 1200;

/**
 * How far away a given deposit is legible. Unlike a structure this constrains observation only:
 * `applyCollect` gates on `interactionRadiusCu`, so seeing a seam still means walking to it.
 */
export function resourceVisibilityRadiusCu(perceptionRadiusCu: number, quantity: number): number {
  return perceptionRadiusCu + Math.min(DEPOSIT_LANDMARK_BONUS_CU, Math.max(0, quantity) * 2);
}

/**
 * Compose the bounded local observation an agent is permitted to see.
 *
 * Nothing global leaks in. Only entities inside the organism's perception radius appear,
 * neighbours are described in coarse bands rather than exact traits, and every list is
 * truncated to a documented cap so prompts stay small and predictable.
 */
export function observe(
  draft: WorldState,
  organism: Organism,
  phenotype?: Phenotype,
  config: SimulationConfig = DEFAULT_SIMULATION_CONFIG,
): Observation {
  const p = phenotype ?? derivePhenotype(organism.genotype);
  const agent = draft.agents.get(organism.agentId);
  const region = draft.regions.get(organism.regionId);
  const radius = p.perceptionRadiusCu;
  const neighbourhood = new Set(regionNeighbourhood(organism.regionId));
  // What the constructions around this organism do for it, or to it. Reported through the fields
  // below rather than as a separate block: an organism experiences a wider grip or a slower step,
  // it does not reason about the building causing them. Every one of these is read identically by
  // the resolver, so a heuristic can never propose an action the rule then refuses.
  const effects = structureEffectsAt(draft.structures, organism.position, organism.lineageId);

  const self: ObservedSelf = {
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    position: organism.position,
    regionId: organism.regionId,
    energy: organism.energy,
    maxEnergy: p.maxEnergy,
    health: organism.health,
    maxHealth: p.maxHealth,
    ageTicks: organism.ageTicks,
    maxAgeTicks: p.maxAgeTicks,
    mature: organism.ageTicks >= p.maturityAgeTicks,
    reproductionReady: draft.world.tick >= organism.reproductionReadyTick,
    generation: organism.generation,
    inventory: organism.inventory.map((e) => {
      // An organism handles what it carries, so it knows how hard and how heavy each is. Without
      // this it can only rank material by quantity, and cannot build deliberately for a function.
      const material = draft.materials.get(e.materialId);
      return {
        materialId: e.materialId,
        quantity: e.quantity,
        hardness: material?.properties.hardness ?? 0,
        density: material?.properties.density ?? 0,
      };
    }),
    ...(organism.attachedStructureId === undefined
      ? {}
      : { attachedStructureId: organism.attachedStructureId }),
    planning: p.effectivePlanning,
    manipulation: p.manipulationScore,
    memorySlots: p.memorySlots,
    carryCapacity: effectiveCarryCapacity(config.inventoryCapacity, effects),
    inventorySlotLimit: MAX_INVENTORY_ENTRIES,
    speedCuPerTick: effectiveSpeedCuPerTick(p.speedCuPerTick, effects),
    moveCostPer100Cu: p.moveCostPer100Cu,
    perceptionRadiusCu: radius,
    signalRadiusCu: p.signalRadiusCu,
  };

  const light = ambientLightPerMille(draft.world.tick, draft.world.calendar);
  const environment: ObservedEnvironment = {
    biome: region?.biome ?? 'plain',
    lightPerMille: clampPerMille(scaleByPerMille(light, region?.lightModifier ?? 1000)),
    temperature: region?.baseTemperature ?? 500,
    waterCoverage: region?.waterCoverage ?? 0,
    biomass: region?.biomass ?? 0,
    pressure: draft.world.pressure.kind,
    pressureSeverity: draft.world.pressure.severity,
    // Derived from the same helper and the same config field the resolver gates on
    // (`evolution.ts` -> `countLivingOrganisms(draft) >= config.maxOrganisms`), so the
    // observable and the rule cannot drift into disagreeing.
    atPopulationCeiling: countLivingOrganisms(draft) >= config.maxOrganisms,
  };

  const organisms: ObservedOrganism[] = [];
  for (const id of sortedIds(draft.organisms)) {
    const other = draft.organisms.get(id);
    if (!other || !other.alive || other.id === organism.id) continue;
    if (!neighbourhood.has(other.regionId)) continue;
    const d = distance(organism.position, other.position);
    // Camouflage works both ways: a hidden organism must be close before it is seen.
    const otherPhenotype = derivePhenotype(other.genotype);
    if (d > Math.min(radius, otherPhenotype.conspicuityRadiusCu + radius / 2)) continue;
    organisms.push({
      organismId: other.id,
      lineageId: other.lineageId,
      kin: other.lineageId === organism.lineageId,
      position: other.position,
      distanceCu: d,
      sizeBand: sizeBand(otherPhenotype.mass),
      threatBand: threatBand(otherPhenotype.attackPower, p.defence),
      healthBand: healthBand(other.health, otherPhenotype.maxHealth),
      energyBand: energyBand(other.energy, otherPhenotype.maxEnergy),
    });
  }
  organisms.sort((a, b) => a.distanceCu - b.distanceCu || (a.organismId < b.organismId ? -1 : 1));

  const knownMaterials = new Set(agent?.knowledge.knownMaterialIds ?? []);
  const resources: ObservedResource[] = [];
  for (const id of sortedIds(draft.resources)) {
    const node = draft.resources.get(id);
    if (!node || node.quantity <= 0) continue;
    if (!neighbourhood.has(node.regionId)) continue;
    const d = distance(organism.position, node.position);
    // A deposit is a static feature of the terrain, not a moving neighbour, so it is legible from
    // further away — scaled by what is left of it. Without this, a typical organism perceives no
    // deposit at all on most turns and gathering degenerates into a blind random walk.
    if (d > resourceVisibilityRadiusCu(radius, node.quantity)) continue;
    const definition = draft.materials.get(node.materialId);
    resources.push({
      resourceNodeId: node.id,
      materialId: node.materialId,
      position: node.position,
      distanceCu: d,
      quantity: node.quantity,
      nutritionPerUnit: definition?.nutritionPerUnit ?? 0,
      hardness: definition?.properties.hardness ?? 0,
      density: definition?.properties.density ?? 0,
      known: knownMaterials.has(node.materialId),
    });
  }
  resources.sort(
    (a, b) => a.distanceCu - b.distanceCu || (a.resourceNodeId < b.resourceNodeId ? -1 : 1),
  );

  const knownStructures = new Set(agent?.knowledge.knownStructureIds ?? []);
  const structures: ObservedStructure[] = [];
  for (const id of sortedIds(draft.structures)) {
    const structure = draft.structures.get(id);
    if (!structure) continue;
    if (!neighbourhood.has(structure.regionId)) continue;
    const d = distance(organism.position, structure.position);
    // A construction is a static landmark far larger than an organism, so it is legible from
    // further away than a moving neighbour. Without this bonus, built objects are effectively
    // invisible in a world this size and knowledge could never cross a lineage boundary.
    if (d > structureVisibilityRadiusCu(radius, structure)) continue;
    const own = structure.createdByLineageId === organism.lineageId;
    const inspected = own || knownStructures.has(structure.id);
    structures.push({
      structureId: structure.id,
      position: structure.position,
      distanceCu: d,
      pattern: structure.pattern,
      integrity: structure.integrity,
      // What a structure *does* is hidden until it has been inspected or built by this lineage.
      functions: inspected ? structure.functions.map((f) => f.id) : [],
      builtByOwnLineage: own,
      inspected,
    });
  }
  structures.sort(
    (a, b) => a.distanceCu - b.distanceCu || (a.structureId < b.structureId ? -1 : 1),
  );

  const signals: ObservedSignal[] = [];
  for (const signal of draft.signals) {
    if (signal.organismId === organism.id) continue;
    const d = distance(organism.position, signal.position);
    if (d > signal.radiusCu) continue;
    signals.push({
      channel: signal.channel,
      fromLineageId: signal.lineageId,
      kin: signal.lineageId === organism.lineageId,
      distanceCu: d,
      intensity: signal.intensity,
      ...(signal.recipe === undefined
        ? {}
        : { recipeKey: signal.recipe.key, recipeLabel: signal.recipe.label }),
    });
  }
  signals.sort((a, b) => a.distanceCu - b.distanceCu);

  const memories: ObservedMemory[] = (draft.memories.get(organism.agentId) ?? [])
    .slice()
    .sort((a, b) => b.salience - a.salience || (a.id < b.id ? -1 : 1))
    .slice(0, Math.min(MAX_OBSERVED_MEMORIES, Math.max(0, p.memorySlots)))
    .map<ObservedMemory>((m) => ({
      kind: m.kind,
      note: m.note,
      salience: m.salience,
      ageTicks: Math.max(0, draft.world.tick - m.createdAtTick),
    }));

  const goals: ObservedGoal[] = (draft.goals.get(organism.agentId) ?? [])
    .filter((g) => g.status === 'pending' || g.status === 'adopted')
    .slice(0, MAX_OBSERVED_GOALS)
    .map<ObservedGoal>((g) => ({ goalId: g.id, text: g.text, submittedAtTick: g.submittedAtTick }));

  return {
    version: 1,
    worldId: draft.world.id,
    tick: draft.world.tick,
    self,
    environment,
    organisms: organisms.slice(0, MAX_OBSERVED_ORGANISMS),
    resources: resources.slice(0, MAX_OBSERVED_RESOURCES),
    structures: structures.slice(0, MAX_OBSERVED_STRUCTURES),
    signals: signals.slice(0, MAX_OBSERVED_SIGNALS),
    memories,
    goals,
    drives: agent?.drives ?? {
      survive: 500,
      forage: 500,
      reproduce: 500,
      explore: 500,
      cooperate: 500,
      build: 500,
    },
    temperament: agent?.temperament ?? 'balanced',
    aspiration: agent?.aspiration ?? '',
    knownRecipes: (agent?.knowledge.recipes ?? []).map((r) => ({ key: r.key, label: r.label })),
    availableActions: availableActions(organism, p),
  };
}

function sizeBand(mass: number): ObservedOrganism['sizeBand'] {
  if (mass < 90) return 'tiny';
  if (mass < 180) return 'small';
  if (mass < 320) return 'medium';
  return 'large';
}

function threatBand(attackPower: number, ownDefence: number): ObservedOrganism['threatBand'] {
  if (attackPower <= ownDefence) return 'harmless';
  if (attackPower <= ownDefence * 2) return 'wary';
  return 'dangerous';
}

function healthBand(health: number, maxHealth: number): ObservedOrganism['healthBand'] {
  const ratio = maxHealth <= 0 ? 0 : Math.trunc((health * 1000) / maxHealth);
  if (ratio < 350) return 'weak';
  if (ratio < 750) return 'fair';
  return 'strong';
}

/**
 * Coarse hunger.
 *
 * `lean` deliberately reaches to 750‰ so that anything below `fed` still has room to
 * accept a transfer — `applyShare` refuses when the recipient's reserve is already full,
 * and an observable that cannot distinguish that case makes cooperation unimplementable.
 */
function energyBand(energy: number, maxEnergy: number): ObservedOrganism['energyBand'] {
  const ratio = maxEnergy <= 0 ? 0 : Math.trunc((energy * 1000) / maxEnergy);
  if (ratio < 300) return 'starving';
  if (ratio < 750) return 'lean';
  return 'fed';
}

/** True when the observer may act on the structure at all. */
export function structureVisibleTo(
  organism: Organism,
  structure: Structure,
  phenotype?: Phenotype,
): boolean {
  const p = phenotype ?? derivePhenotype(organism.genotype);
  return distance(organism.position, structure.position) <= p.perceptionRadiusCu;
}
