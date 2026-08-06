import {
  AgentRecordSchema,
  GoalRecordSchema,
  LineageNodeRecordSchema,
  LineageRecordSchema,
  MaterialRecordSchema,
  MemoryRecordSchema,
  OrganismRecordSchema,
  RegionRecordSchema,
  ResourceNodeRecordSchema,
  SignalRecordSchema,
  StructureRecordSchema,
  TerrainField,
  WorldRecordSchema,
  type Agent,
  type AgentGoal,
  type AgentId,
  type GoalRecord,
  type Lineage,
  type LineageId,
  type LineageNode,
  type MaterialDefinition,
  type MaterialId,
  type Memory,
  type MemoryRecord,
  type Organism,
  type OrganismId,
  type Region,
  type RegionId,
  type ResourceNode,
  type ResourceNodeId,
  type Signal,
  type Structure,
  type StructureId,
  type World,
  type WorldRecordBundle,
} from '@autocosm/domain';
import type { WorldState } from './state.js';

/**
 * Projection between the in-memory `WorldState` and versioned storage records.
 *
 * This lives in the simulation package rather than in storage so that neither the domain nor the
 * simulation learns about Azure, and so the tick job and the web API share one definition of
 * "the world, persisted".
 *
 * The mapping is lossless in both directions: `fromRecords(toRecords(state))` must reproduce a
 * state that ticks identically, which a round-trip test asserts. Terrain is deliberately *not*
 * persisted — it is a pure function of the world seed.
 */

export type { WorldRecordBundle };

const RV = 1;

/** Spread an optional property only when defined, to satisfy `exactOptionalPropertyTypes`. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/**
 * Drop `undefined` entries from a sparse map.
 *
 * `LifetimeState` is a `Partial<Record<…>>`, but the stored schema is a dense record of numbers.
 * Copying through this helper keeps the two representations honest instead of asserting them equal.
 */
function denseNumbers(source: Readonly<Partial<Record<string, number>>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function recipeToRecord(recipe: {
  readonly key: string;
  readonly label: string;
  readonly components: readonly { readonly materialId: string; readonly quantity: number }[];
  readonly learnedAtTick: number;
  readonly learnedFromLineageId?: string;
}): {
  key: string;
  label: string;
  components: { materialId: string; quantity: number }[];
  learnedAtTick: number;
  learnedFromLineageId?: string;
} {
  return {
    key: recipe.key,
    label: recipe.label,
    components: recipe.components.map((c) => ({ materialId: c.materialId, quantity: c.quantity })),
    learnedAtTick: recipe.learnedAtTick,
    ...opt('learnedFromLineageId', recipe.learnedFromLineageId),
  };
}

export function toRecords(state: WorldState): WorldRecordBundle {
  const worldId = state.world.id;

  const memories: MemoryRecord[] = [];
  for (const [agentId, list] of state.memories) {
    for (const memory of list) {
      memories.push({
        rv: RV,
        id: memory.id,
        worldId,
        agentId,
        kind: memory.kind,
        createdAtTick: memory.createdAtTick,
        salience: memory.salience,
        ...opt('position', memory.position === undefined ? undefined : { ...memory.position }),
        ...opt('subjectId', memory.subjectId),
        note: memory.note,
      });
    }
  }

  const goals: GoalRecord[] = [];
  for (const [agentId, list] of state.goals) {
    for (const goal of list) {
      goals.push({
        rv: RV,
        id: goal.id,
        worldId,
        agentId,
        text: goal.text,
        submittedByCreatorId: goal.submittedByCreatorId,
        submittedAtTick: goal.submittedAtTick,
        status: goal.status,
        ...opt('resolvedAtTick', goal.resolvedAtTick),
        ...opt('resolutionNote', goal.resolutionNote),
      });
    }
  }

  return {
    world: {
      rv: RV,
      ...state.world,
      calendar: { ...state.world.calendar },
      pressure: { ...state.world.pressure },
      stats: { ...state.world.stats },
    },
    regions: [...state.regions.values()].map((region) => ({ rv: RV, ...region })),
    agents: [...state.agents.values()].map((agent) => ({
      rv: RV,
      ...agent,
      drives: { ...agent.drives },
      knowledge: {
        knownMaterialIds: [...agent.knowledge.knownMaterialIds],
        recipes: agent.knowledge.recipes.map(recipeToRecord),
        knownStructureIds: [...agent.knowledge.knownStructureIds],
      },
    })),
    lineages: [...state.lineages.values()].map((lineage) => ({
      rv: RV,
      ...lineage,
      meanGenotype: { ...lineage.meanGenotype },
    })),
    lineageNodes: [...state.lineageNodes.values()].map((node) => ({ rv: RV, ...node })),
    organisms: [...state.organisms.values()].map((organism) => ({
      rv: RV,
      ...organism,
      position: { ...organism.position },
      genotype: { ...organism.genotype },
      lifetime: {
        emphasis: denseNumbers(organism.lifetime.emphasis),
        successes: denseNumbers(organism.lifetime.successes),
        failures: denseNumbers(organism.lifetime.failures),
      },
      inventory: organism.inventory.map((e) => ({
        materialId: e.materialId,
        quantity: e.quantity,
      })),
    })),
    materials: [...state.materials.values()].map((material) => ({
      rv: RV,
      worldId,
      id: material.id,
      label: material.label,
      origin: material.origin,
      properties: { ...material.properties },
      nutritionPerUnit: material.nutritionPerUnit,
      ...opt(
        'derivedFrom',
        material.derivedFrom?.map((c) => ({ materialId: c.materialId, quantity: c.quantity })),
      ),
      ...opt('discoveredAtTick', material.discoveredAtTick),
    })),
    resources: [...state.resources.values()].map((resource) => ({
      rv: RV,
      worldId,
      ...resource,
      position: { ...resource.position },
    })),
    structures: [...state.structures.values()].map((structure) => ({
      rv: RV,
      worldId,
      ...structure,
      position: { ...structure.position },
      properties: { ...structure.properties },
      components: structure.components.map((c) => ({
        materialId: c.materialId,
        quantity: c.quantity,
      })),
      functions: structure.functions.map((f) => ({ id: f.id, magnitude: f.magnitude })),
      usage: structure.usage.map((u) => ({
        tick: u.tick,
        organismId: u.organismId,
        lineageId: u.lineageId,
        kind: u.kind,
      })),
    })),
    memories,
    goals,
    signals: state.signals.map(({ recipe, ...signal }) => ({
      rv: RV,
      worldId,
      ...signal,
      position: { ...signal.position },
      ...opt('recipe', recipe === undefined ? undefined : recipeToRecord(recipe)),
    })),
  };
}

/**
 * Re-attach nominal identifier brands after runtime validation.
 *
 * Storage records use plain `string` ids because Zod cannot express a nominal brand. Every value
 * passed here has just been parsed by its record schema, so the shape is proven at runtime; only
 * the compile-time brand is being restored. This is the one place in the codebase where that
 * assertion is made, and it is always immediately preceded by a parse.
 */
function branded<T>(validated: unknown): T {
  return validated as T;
}

function strip<T extends { rv: number }>(record: T): Omit<T, 'rv'> {
  const { rv: _rv, ...rest } = record;
  return rest;
}

function stripWorld<T extends { rv: number; worldId: string }>(
  record: T,
): Omit<T, 'rv' | 'worldId'> {
  const { rv: _rv, worldId: _worldId, ...rest } = record;
  return rest;
}

export function fromRecords(bundle: WorldRecordBundle): WorldState {
  const world = branded<World>(strip(WorldRecordSchema.parse(bundle.world)));

  const memories = new Map<AgentId, Memory[]>();
  for (const raw of bundle.memories) {
    const parsed = MemoryRecordSchema.parse(raw);
    const agentId = branded<AgentId>(parsed.agentId);
    const list = memories.get(agentId) ?? [];
    list.push(branded<Memory>(stripWorld(parsed)));
    memories.set(agentId, list);
  }

  const goals = new Map<AgentId, AgentGoal[]>();
  for (const raw of bundle.goals) {
    const parsed = GoalRecordSchema.parse(raw);
    const agentId = branded<AgentId>(parsed.agentId);
    const list = goals.get(agentId) ?? [];
    list.push(branded<AgentGoal>(stripWorld(parsed)));
    goals.set(agentId, list);
  }

  const regions = new Map<RegionId, Region>();
  for (const raw of bundle.regions) {
    const parsed = RegionRecordSchema.parse(raw);
    regions.set(branded<RegionId>(parsed.id), branded<Region>(strip(parsed)));
  }

  const agents = new Map<AgentId, Agent>();
  for (const raw of bundle.agents) {
    const parsed = AgentRecordSchema.parse(raw);
    agents.set(branded<AgentId>(parsed.id), branded<Agent>(strip(parsed)));
  }

  const lineages = new Map<LineageId, Lineage>();
  for (const raw of bundle.lineages) {
    const parsed = LineageRecordSchema.parse(raw);
    lineages.set(branded<LineageId>(parsed.id), branded<Lineage>(strip(parsed)));
  }

  const lineageNodes = new Map<OrganismId, LineageNode>();
  for (const raw of bundle.lineageNodes) {
    const parsed = LineageNodeRecordSchema.parse(raw);
    lineageNodes.set(branded<OrganismId>(parsed.organismId), branded<LineageNode>(strip(parsed)));
  }

  const organisms = new Map<OrganismId, Organism>();
  for (const raw of bundle.organisms) {
    const parsed = OrganismRecordSchema.parse(raw);
    organisms.set(branded<OrganismId>(parsed.id), branded<Organism>(strip(parsed)));
  }

  const materials = new Map<MaterialId, MaterialDefinition>();
  for (const raw of bundle.materials) {
    const parsed = MaterialRecordSchema.parse(raw);
    materials.set(branded<MaterialId>(parsed.id), branded<MaterialDefinition>(stripWorld(parsed)));
  }

  const resources = new Map<ResourceNodeId, ResourceNode>();
  for (const raw of bundle.resources) {
    const parsed = ResourceNodeRecordSchema.parse(raw);
    resources.set(branded<ResourceNodeId>(parsed.id), branded<ResourceNode>(stripWorld(parsed)));
  }

  const structures = new Map<StructureId, Structure>();
  for (const raw of bundle.structures) {
    const parsed = StructureRecordSchema.parse(raw);
    structures.set(branded<StructureId>(parsed.id), branded<Structure>(stripWorld(parsed)));
  }

  const signals = bundle.signals.map((raw) =>
    branded<Signal>(stripWorld(SignalRecordSchema.parse(raw))),
  );

  return {
    world,
    terrain: new TerrainField(world.seed),
    regions,
    agents,
    lineages,
    lineageNodes,
    organisms,
    materials,
    resources,
    structures,
    memories,
    goals,
    signals,
  };
}
