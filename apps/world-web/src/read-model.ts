import {
  DEFAULT_CALENDAR,
  REGION_GRID,
  REGION_SPAN_CU,
  STRUCTURE_FUNCTION_RULES,
  TRAIT_IDS,
  WORLD_SPAN_CU,
  ambientLightPerMille,
  complexityScore,
  dayPhasePerMille,
  decayPerTick,
  derivePhenotype,
  deriveMaterialName,
  explainedReactions,
  deriveVisual,
  effectiveTrait,
  functionMagnitude,
  regionCentre,
  regionCoordFromId,
  regionIdOf,
  regionNeighbourhood,
  structureFunctionEntry,
  type AgentDetailResponse,
  type EventHistoryResponse,
  type Genotype,
  type LineageDetailResponse,
  type MaterialId,
  type MaterialDefinition,
  type OrganismDetailResponse,
  type Region,
  type SnapshotResponse,
  type StructureDetailResponse,
  type WorldMetaResponse,
} from '@autocosm/domain';
import type { WorldState } from '@autocosm/simulation';

/**
 * Read-model projection.
 *
 * Everything the browser sees is composed here from an already-loaded world state. Responses carry
 * only opaque domain identifiers — never a partition key, a storage endpoint, or anything that
 * reveals the deployment topology — and every collection is bounded so a snapshot cannot grow
 * without limit as the world fills up.
 */

/** Hard ceiling per snapshot, independent of radius, so response size stays predictable. */
export const MAX_SNAPSHOT_ORGANISMS = 600;
export const MAX_SNAPSHOT_STRUCTURES = 300;
export const MAX_SNAPSHOT_RESOURCES = 400;
/**
 * Ceiling on the world material catalogue served by `/world`.
 *
 * **No longer coupled to the simulation's `maxMaterials`.** It used to have to stay above it,
 * because a material absent from this slice rendered as a raw id wherever a snapshot referenced it.
 * `ResourceDtoSchema.materialLabel` closes that last gap — every material reference in the API now
 * carries its own label — so truncating here costs field-guide browse depth and nothing else.
 *
 * Severing the coupling was not optional. Discovery does not converge: at
 * `biomassRegenAtFullLight: 180` three trajectories reached 986/1036/648 materials by tick
 * 1400-1600 and were still adding 111-187 per 200-tick window, against a deployed world running
 * six times longer. A catalogue that must contain every material is therefore a catalogue that
 * grows without bound in world age, on a polled route.
 *
 * At ~540 bytes per composite entry, 576 is ~310 kB worst case, which this route can carry because
 * it is sorted for byte-stability and therefore ETag-cached: a spectator fetches it once and then
 * receives 304s.
 */
export const MAX_CATALOGUE_MATERIALS = 576;
const MAX_LINEAGE_NODES = 400;
const MAX_AGENT_MEMORIES = 16;

export interface SnapshotOptions {
  readonly regionId?: string;
  readonly radius: number;
}

export function composeSnapshot(state: WorldState, options: SnapshotOptions): SnapshotResponse {
  const centre = resolveCentreRegion(state, options.regionId);
  const visible = regionsWithin(centre, options.radius);
  const visibleSet = new Set<string>(visible);

  const organisms: SnapshotResponse['organisms'] = [];
  let organismsTruncated = false;
  for (const organism of state.organisms.values()) {
    if (!organism.alive || !visibleSet.has(organism.regionId)) continue;
    if (organisms.length >= MAX_SNAPSHOT_ORGANISMS) {
      organismsTruncated = true;
      break;
    }
    const phenotype = derivePhenotype(organism.genotype);
    organisms.push({
      id: organism.id,
      agentId: organism.agentId,
      lineageId: organism.lineageId,
      regionId: organism.regionId,
      x: organism.position.x,
      z: organism.position.z,
      elevation: state.terrain.elevationAtPosition(organism.position),
      energy: organism.energy,
      maxEnergy: phenotype.maxEnergy,
      health: organism.health,
      maxHealth: phenotype.maxHealth,
      ageTicks: organism.ageTicks,
      maxAgeTicks: phenotype.maxAgeTicks,
      generation: organism.generation,
      visual: deriveVisual(organism.genotype),
    });
  }

  const structures: SnapshotResponse['structures'] = [];
  let structuresTruncated = false;
  for (const structure of state.structures.values()) {
    if (!visibleSet.has(structure.regionId)) continue;
    if (structures.length >= MAX_SNAPSHOT_STRUCTURES) {
      structuresTruncated = true;
      break;
    }
    const builder = builderChip(state, structure.createdByAgentId, structure.createdByLineageId);
    structures.push({
      id: structure.id,
      regionId: structure.regionId,
      x: structure.position.x,
      z: structure.position.z,
      elevation: state.terrain.elevationAtPosition(structure.position),
      pattern: structure.pattern,
      label: structure.label,
      integrity: structure.integrity,
      volume: structure.volume,
      functions: structure.functions.map((f) => ({ id: f.id, magnitude: f.magnitude })),
      createdByAgentId: structure.createdByAgentId,
      createdByLineageId: structure.createdByLineageId,
      createdAtTick: structure.createdAtTick,
      ...builder,
    });
  }

  const resources: SnapshotResponse['resources'] = [];
  let resourcesTruncated = false;
  for (const resource of state.resources.values()) {
    if (!visibleSet.has(resource.regionId)) continue;
    if (resources.length >= MAX_SNAPSHOT_RESOURCES) {
      resourcesTruncated = true;
      break;
    }
    const chip = materialChip(state, resource.materialId);
    resources.push({
      id: resource.id,
      materialId: resource.materialId,
      materialLabel: chip.label,
      materialSubtitle: chip.subtitle,
      x: resource.position.x,
      z: resource.position.z,
      elevation: state.terrain.elevationAtPosition(resource.position),
      quantity: resource.quantity,
      capacity: resource.capacity,
    });
  }

  return {
    worldId: state.world.id,
    worldName: state.world.name,
    tick: state.world.tick,
    seed: state.world.seed,
    lightPerMille: ambientLightPerMille(state.world.tick, state.world.calendar),
    dayPhasePerMille: dayPhasePerMille(state.world.tick, state.world.calendar),
    pressure: {
      kind: state.world.pressure.kind,
      severity: state.world.pressure.severity,
      endsAtTick: state.world.pressure.endsAtTick,
    },
    centreRegionId: centre,
    radius: options.radius,
    regions: visible.flatMap((id) => {
      const region = state.regions.get(id as Region['id']);
      return region ? [regionDto(region)] : [];
    }),
    organisms,
    structures,
    resources,
    stats: { ...state.world.stats },
    truncated: organismsTruncated || structuresTruncated || resourcesTruncated,
  };
}

function resolveCentreRegion(state: WorldState, requested: string | undefined): string {
  if (requested !== undefined && regionCoordFromId(requested) !== null) return requested;
  // Default to wherever life actually is, so a cold observer never lands on empty ocean.
  let best: string | undefined;
  let bestCount = 0;
  const counts = new Map<string, number>();
  for (const organism of state.organisms.values()) {
    if (!organism.alive) continue;
    const next = (counts.get(organism.regionId) ?? 0) + 1;
    counts.set(organism.regionId, next);
    if (next > bestCount) {
      bestCount = next;
      best = organism.regionId;
    }
  }
  return best ?? regionIdOf(regionCentre({ col: REGION_GRID >> 1, row: REGION_GRID >> 1 }));
}

/** Regions within `radius` steps of the centre, wrapping at the world edge. */
function regionsWithin(centre: string, radius: number): readonly string[] {
  if (radius <= 0) return [centre];
  let frontier = new Set<string>([centre]);
  const seen = new Set<string>([centre]);
  for (let step = 0; step < radius; step += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const neighbour of regionNeighbourhood(id as Region['id'])) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        next.add(neighbour);
      }
    }
    frontier = next;
  }
  return [...seen].sort();
}

function regionDto(region: Region): SnapshotResponse['regions'][number] {
  const coord = regionCoordFromId(region.id) ?? { col: 0, row: 0 };
  return {
    id: region.id,
    col: coord.col,
    row: coord.row,
    biome: region.biome,
    meanElevationCu: region.meanElevationCu,
    waterCoverage: region.waterCoverage,
    baseTemperature: region.baseTemperature,
    mineralRichness: region.mineralRichness,
    biomass: region.biomass,
  };
}

export function composeWorldMeta(
  state: WorldState,
  flags: { heuristicOnly: boolean; aiDegraded: boolean },
): WorldMetaResponse {
  const agents = [...state.agents.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, 200)
    .map((agent) => {
      const lineage = state.lineages.get(agent.lineageId);
      return {
        id: agent.id,
        lineageId: agent.lineageId,
        name: agent.name,
        status: agent.status,
        livingOrganisms: lineage?.livingCount ?? 0,
        generations: lineage?.generations ?? 0,
        hue: deriveVisual(lineage?.meanGenotype ?? seedlessGenotype(state)).hue,
      };
    });

  return {
    worldId: state.world.id,
    name: state.world.name,
    tick: state.world.tick,
    seed: state.world.seed,
    regionGrid: REGION_GRID,
    regionSpanCu: REGION_SPAN_CU,
    worldSpanCu: WORLD_SPAN_CU,
    calendar: {
      ticksPerDay: state.world.calendar.ticksPerDay,
      ticksPerPressureCycle: state.world.calendar.ticksPerPressureCycle,
      simulatedMinutesPerTick: state.world.calendar.simulatedMinutesPerTick,
    },
    stats: { ...state.world.stats },
    regions: [...state.regions.values()].map(regionDto),
    agents,
    materials: materialCatalogue(state),
    heuristicOnly: flags.heuristicOnly,
    aiDegraded: flags.aiDegraded,
  };
}

/**
 * Every material in the world, in a stable order, up to the catalogue ceiling.
 *
 * Sorted for byte-stability so the ETag on this route stays meaningful and the browser's cache
 * useful. Two keys, in order:
 *
 * 1. **Base materials before composites.** A plain alphabetical sort is adversarially wrong here.
 *    Crafted ids are `mx…` while base ids are words, so the first six materials an alphabetical
 *    slice drops are `water`, `silt`, `sand`, `stone`, `resin` and `toxinSac` — the substances
 *    every resource node in the world is made of, and the ones a field guide is most asked about.
 *    `origin` never changes for a given material, so this key is as stable as the id itself.
 * 2. **Then by id**, which is what makes the response byte-identical for a given world state.
 */
function materialCatalogue(state: WorldState): WorldMetaResponse['materials'] {
  return [...state.materials.values()]
    .sort((a, b) => {
      const aBase = a.origin === 'composite' ? 1 : 0;
      const bBase = b.origin === 'composite' ? 1 : 0;
      if (aBase !== bBase) return aBase - bBase;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, MAX_CATALOGUE_MATERIALS)
    .map((material) => ({
      id: material.id,
      label: material.label,
      subtitle: deriveMaterialName(material).subtitle,
      origin: material.origin,
      properties: { ...material.properties },
      nutritionPerUnit: material.nutritionPerUnit,
      ...(material.derivedFrom === undefined
        ? {}
        : {
            derivedFrom: material.derivedFrom.slice(0, 8).map((component) => ({
              materialId: component.materialId,
              label: state.materials.get(component.materialId)?.label ?? component.materialId,
              quantity: component.quantity,
            })),
          }),
      ...(material.discoveredAtTick === undefined
        ? {}
        : { discoveredAtTick: material.discoveredAtTick }),
      ...reactionsFragment(material, state.materials),
    }));
}

/**
 * Reaction attribution, omitted entirely when there is none to make.
 *
 * Kept as a fragment rather than an empty array so the response stays byte-identical for a world
 * of base materials, which is what makes the ETag on this route worth having.
 */
function reactionsFragment(
  material: MaterialDefinition,
  catalogue: ReadonlyMap<MaterialId, MaterialDefinition>,
): { readonly reactions?: string[] } {
  const reactions = explainedReactions(material, catalogue);
  return reactions.length === 0 ? {} : { reactions: [...reactions] };
}

/** Fallback genome for an agent whose lineage record is missing; keeps the response total. */
function seedlessGenotype(state: WorldState): Genotype {
  const any = [...state.lineages.values()][0];
  if (any) return any.meanGenotype;
  const first = [...state.organisms.values()][0];
  if (first) return first.genotype;
  throw new Error('world has no genotype to derive a colour from');
}

function traitDtos(genotype: Genotype): AgentDetailResponse['meanTraits'] {
  return TRAIT_IDS.map((id) => ({
    id,
    value: genotype[id],
    effective: effectiveTrait(genotype, id),
  }));
}

/**
 * Resolve a material id to something a spectator can read.
 *
 * The subtitle is derived here rather than stored: it is a pure function of the property vector, so
 * caching it would only create a second thing that can drift.
 */
function materialChip(
  state: WorldState,
  id: MaterialId,
): { id: string; label: string; subtitle: string } {
  const material = state.materials.get(id);
  if (!material) return { id, label: id, subtitle: '' };
  return { id, label: material.label, subtitle: deriveMaterialName(material).subtitle };
}

/**
 * Resolve a builder to a name and a colour.
 *
 * Returned as a spreadable partial so a structure whose agent record has been reaped simply omits
 * the fields rather than carrying a placeholder that reads like a real name.
 */
function builderChip(
  state: WorldState,
  agentId: string,
  lineageId: string,
): { createdByAgentName?: string; createdByLineageHue?: number } {
  const agent = state.agents.get(agentId as never);
  const lineage = state.lineages.get(lineageId as never);
  return {
    ...(agent === undefined ? {} : { createdByAgentName: agent.name }),
    ...(lineage === undefined
      ? {}
      : { createdByLineageHue: deriveVisual(lineage.meanGenotype).hue }),
  };
}

export function composeAgentDetail(
  state: WorldState,
  agentId: string,
): AgentDetailResponse | undefined {
  const agent = state.agents.get(agentId as never);
  if (!agent) return undefined;
  const lineage = state.lineages.get(agent.lineageId);
  const goals = state.goals.get(agent.id) ?? [];
  const memories = [...(state.memories.get(agent.id) ?? [])]
    .sort((a, b) => b.createdAtTick - a.createdAtTick)
    .slice(0, MAX_AGENT_MEMORIES);

  return {
    id: agent.id,
    lineageId: agent.lineageId,
    name: agent.name,
    aspiration: agent.aspiration,
    status: agent.status,
    temperament: agent.temperament,
    createdAtTick: agent.createdAtTick,
    ...(agent.extinctAtTick === undefined ? {} : { extinctAtTick: agent.extinctAtTick }),
    drives: { ...agent.drives },
    decisionCount: agent.decisionCount,
    lastDecisionTick: agent.lastDecisionTick,
    livingOrganisms: lineage?.livingCount ?? 0,
    generations: lineage?.generations ?? 0,
    births: lineage?.births ?? 0,
    deaths: lineage?.deaths ?? 0,
    meanTraits: lineage ? traitDtos(lineage.meanGenotype) : [],
    knownMaterials: [...agent.knowledge.knownMaterialIds]
      .slice(0, 64)
      .map((id) => materialChip(state, id)),
    knownRecipes: agent.knowledge.recipes.slice(0, 24).map((recipe) => {
      // Read from the recipe rather than recomputed: material identity is physical, so the product
      // of an ingredient list cannot be known without performing the blend. Recipes learned before
      // that was true carry no product, and the honest rendering there is the stored label.
      const produces = recipe.producesMaterialId;
      return {
        key: recipe.key,
        // Joined from the produced material rather than trusting the stored label, which may
        // predate the naming rules or have been copied from another lineage.
        label: (produces ? state.materials.get(produces)?.label : undefined) ?? recipe.label,
        ...(produces === undefined ? {} : { producesMaterialId: produces }),
        components: recipe.components.slice(0, 8).map((component) => ({
          materialId: component.materialId,
          label: state.materials.get(component.materialId)?.label ?? component.materialId,
          quantity: component.quantity,
        })),
        learnedAtTick: recipe.learnedAtTick,
      };
    }),
    goals: goals.slice(-20).map((goal) => ({
      id: goal.id,
      text: goal.text,
      status: goal.status,
      submittedAtTick: goal.submittedAtTick,
      ...(goal.resolutionNote === undefined ? {} : { resolutionNote: goal.resolutionNote }),
    })),
    recentMemories: memories.map((m) => ({
      kind: m.kind,
      note: m.note,
      salience: m.salience,
      createdAtTick: m.createdAtTick,
    })),
  };
}

export function composeOrganismDetail(
  state: WorldState,
  organismId: string,
): OrganismDetailResponse | undefined {
  const organism = state.organisms.get(organismId as never);
  if (!organism) return undefined;
  const phenotype = derivePhenotype(organism.genotype);
  const node = state.lineageNodes.get(organism.id);

  return {
    id: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    regionId: organism.regionId,
    x: organism.position.x,
    z: organism.position.z,
    elevation: state.terrain.elevationAtPosition(organism.position),
    energy: organism.energy,
    maxEnergy: phenotype.maxEnergy,
    health: organism.health,
    maxHealth: phenotype.maxHealth,
    ageTicks: organism.ageTicks,
    maxAgeTicks: phenotype.maxAgeTicks,
    generation: organism.generation,
    visual: deriveVisual(organism.genotype),
    traits: traitDtos(organism.genotype),
    phenotype: numericPhenotype(phenotype),
    inventory: organism.inventory.slice(0, 16).map((e) => ({
      materialId: e.materialId,
      materialLabel: state.materials.get(e.materialId)?.label ?? e.materialId,
      quantity: e.quantity,
    })),
    ...(organism.parentOrganismId === undefined
      ? {}
      : { parentOrganismId: organism.parentOrganismId }),
    alive: organism.alive,
    ...(node?.causeOfDeath === undefined ? {} : { causeOfDeath: node.causeOfDeath }),
    ...(organism.attachedStructureId === undefined
      ? {}
      : { attachedStructureId: organism.attachedStructureId }),
  };
}

/**
 * Everything a spectator needs to understand a single construction.
 *
 * The snapshot deliberately carries only the builder's name and colour; composition, usage history
 * and function explanations live here because they are unbounded per structure and would multiply
 * across the hundreds of structures a snapshot can hold.
 */
export function composeStructureDetail(
  state: WorldState,
  structureId: string,
): StructureDetailResponse | undefined {
  const structure = state.structures.get(structureId as never);
  if (!structure) return undefined;

  const perTick = decayPerTick(structure.properties);
  const rules = new Map(STRUCTURE_FUNCTION_RULES.map((rule) => [rule.id, rule]));

  return {
    id: structure.id,
    regionId: structure.regionId,
    x: structure.position.x,
    z: structure.position.z,
    elevation: state.terrain.elevationAtPosition(structure.position),
    pattern: structure.pattern,
    label: structure.label,
    integrity: structure.integrity,
    volume: structure.volume,
    functions: structure.functions.map((f) => ({ id: f.id, magnitude: f.magnitude })),
    createdByAgentId: structure.createdByAgentId,
    createdByLineageId: structure.createdByLineageId,
    createdAtTick: structure.createdAtTick,
    ...builderChip(state, structure.createdByAgentId, structure.createdByLineageId),
    createdByOrganismId: structure.createdByOrganismId,
    lastChangedAtTick: structure.lastChangedAtTick,
    properties: { ...structure.properties },
    components: structure.components.slice(0, 16).map((component) => {
      const chip = materialChip(state, component.materialId);
      return {
        materialId: component.materialId,
        label: chip.label,
        subtitle: chip.subtitle,
        quantity: component.quantity,
      };
    }),
    derivedFunctions: structure.functions.slice(0, 16).map((fn) => {
      const rule = rules.get(fn.id);
      return {
        id: fn.id,
        label: structureFunctionEntry(fn.id)?.label ?? fn.id,
        magnitude: fn.magnitude,
        // What it delivers today. A half-ruined shelter shelters half as well, and saying so is
        // the clearest way to show that integrity is not cosmetic.
        effectiveMagnitude: functionMagnitude(structure, fn.id),
        summary: rule?.summary ?? '',
        requirement: rule?.requirement ?? '',
      };
    }),
    usage: structure.usage.slice(-16).map((entry) => ({
      tick: entry.tick,
      organismId: entry.organismId,
      lineageId: entry.lineageId,
      kind: entry.kind,
    })),
    decayPerTick: perTick,
    collapsesAtTick: state.world.tick + Math.ceil(structure.integrity / Math.max(1, perTick)),
  };
}

function numericPhenotype(phenotype: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(phenotype)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.trunc(value);
  }
  return out;
}

export function composeLineageDetail(
  state: WorldState,
  lineageId: string,
  offset: number,
): LineageDetailResponse | undefined {
  const lineage = state.lineages.get(lineageId as never);
  if (!lineage) return undefined;

  const all = [...state.lineageNodes.values()]
    .filter((node) => node.lineageId === lineage.id)
    .sort((a, b) => a.bornAtTick - b.bornAtTick || (a.organismId < b.organismId ? -1 : 1));
  const page = all.slice(offset, offset + MAX_LINEAGE_NODES);
  const nextOffset = offset + page.length;

  return {
    id: lineage.id,
    agentId: lineage.agentId,
    name: lineage.name,
    foundedAtTick: lineage.foundedAtTick,
    ...(lineage.extinctAtTick === undefined ? {} : { extinctAtTick: lineage.extinctAtTick }),
    generations: lineage.generations,
    births: lineage.births,
    deaths: lineage.deaths,
    livingCount: lineage.livingCount,
    meanTraits: traitDtos(lineage.meanGenotype),
    nodes: page.map((node) => ({
      organismId: node.organismId,
      ...(node.parentOrganismId === undefined ? {} : { parentOrganismId: node.parentOrganismId }),
      bornAtTick: node.bornAtTick,
      ...(node.diedAtTick === undefined ? {} : { diedAtTick: node.diedAtTick }),
      generation: node.generation,
      complexity: node.complexity,
      ...(node.causeOfDeath === undefined ? {} : { causeOfDeath: node.causeOfDeath }),
    })),
    ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}),
  };
}

export function composeEventHistory(
  events: readonly {
    readonly id: string;
    readonly tick: number;
    readonly regionId: string;
    readonly kind: string;
    readonly summary: string;
    readonly agentId?: string | undefined;
    readonly lineageId?: string | undefined;
    readonly organismId?: string | undefined;
  }[],
  nextCursor: string | undefined,
): EventHistoryResponse {
  return {
    events: events.slice(0, 200).map((event) => ({
      id: event.id,
      tick: event.tick,
      regionId: event.regionId,
      kind: event.kind,
      summary: event.summary,
      ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
      ...(event.lineageId === undefined ? {} : { lineageId: event.lineageId }),
      ...(event.organismId === undefined ? {} : { organismId: event.organismId }),
    })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** Complexity used by the lineage tree presentation; kept next to the other projections. */
export function lineageComplexity(genotype: Genotype): number {
  return complexityScore(genotype);
}

export const DEFAULT_WORLD_CALENDAR = DEFAULT_CALENDAR;
