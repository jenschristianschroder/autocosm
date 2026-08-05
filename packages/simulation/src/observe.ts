import {
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
import { sortedIds, type WorldState } from './state.js';

/**
 * Extra sight range granted to a construction, in cu, capped by its own bulk. Structures are
 * static landmarks; organisms are not. A built object is legible — and therefore learnable —
 * from further away than a moving neighbour, which is what lets knowledge cross lineages.
 */
const STRUCTURE_LANDMARK_BONUS_CU = 1800;

/**
 * How far away a given construction is legible. Observation and action resolution must agree on
 * this, or an agent could see a structure it is then refused permission to inspect.
 */
export function structureVisibilityRadiusCu(
  perceptionRadiusCu: number,
  structureVolume: number,
): number {
  return perceptionRadiusCu + Math.min(STRUCTURE_LANDMARK_BONUS_CU, structureVolume * 8);
}

/**
 * Compose the bounded local observation an agent is permitted to see.
 *
 * Nothing global leaks in. Only entities inside the organism's perception radius appear,
 * neighbours are described in coarse bands rather than exact traits, and every list is
 * truncated to a documented cap so prompts stay small and predictable.
 */
export function observe(draft: WorldState, organism: Organism, phenotype?: Phenotype): Observation {
  const p = phenotype ?? derivePhenotype(organism.genotype);
  const agent = draft.agents.get(organism.agentId);
  const region = draft.regions.get(organism.regionId);
  const radius = p.perceptionRadiusCu;
  const neighbourhood = new Set(regionNeighbourhood(organism.regionId));

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
    generation: organism.generation,
    inventory: organism.inventory.map((e) => ({ materialId: e.materialId, quantity: e.quantity })),
    ...(organism.attachedStructureId === undefined
      ? {}
      : { attachedStructureId: organism.attachedStructureId }),
    planning: p.effectivePlanning,
    manipulation: p.manipulationScore,
    memorySlots: p.memorySlots,
    speedCuPerTick: p.speedCuPerTick,
    perceptionRadiusCu: radius,
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
    if (d > radius) continue;
    const definition = draft.materials.get(node.materialId);
    resources.push({
      resourceNodeId: node.id,
      materialId: node.materialId,
      position: node.position,
      distanceCu: d,
      quantity: node.quantity,
      nutritionPerUnit: definition?.nutritionPerUnit ?? 0,
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
    if (d > structureVisibilityRadiusCu(radius, structure.volume)) continue;
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
      ...(signal.recipe === undefined ? {} : { recipeLabel: signal.recipe.label }),
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
    knownRecipes: (agent?.knowledge.recipes ?? []).map((r) => r.label),
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

/** True when the observer may act on the structure at all. */
export function structureVisibleTo(
  organism: Organism,
  structure: Structure,
  phenotype?: Phenotype,
): boolean {
  const p = phenotype ?? derivePhenotype(organism.genotype);
  return distance(organism.position, structure.position) <= p.perceptionRadiusCu;
}
