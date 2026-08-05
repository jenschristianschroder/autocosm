import type {
  Agent,
  AgentGoal,
  AgentId,
  Lineage,
  LineageId,
  LineageNode,
  MaterialDefinition,
  MaterialId,
  Memory,
  Organism,
  OrganismId,
  Region,
  RegionId,
  ResourceNode,
  ResourceNodeId,
  Signal,
  Structure,
  StructureId,
  TerrainField,
  World,
} from '@autocosm/domain';

/**
 * The complete authoritative world, in memory.
 *
 * The MVP loads the whole world for each tick. At the configured population and region
 * caps this is a few hundred kilobytes and keeps determinism trivially verifiable: the
 * engine is a pure function of this value plus the accepted proposals.
 *
 * `docs/roadmap.md` records the follow-up work to shard ticks per region once the world
 * outgrows a single execution budget.
 */
export interface WorldState {
  readonly world: World;
  readonly terrain: TerrainField;
  readonly regions: ReadonlyMap<RegionId, Region>;
  readonly agents: ReadonlyMap<AgentId, Agent>;
  readonly lineages: ReadonlyMap<LineageId, Lineage>;
  readonly lineageNodes: ReadonlyMap<OrganismId, LineageNode>;
  readonly organisms: ReadonlyMap<OrganismId, Organism>;
  readonly materials: ReadonlyMap<MaterialId, MaterialDefinition>;
  readonly resources: ReadonlyMap<ResourceNodeId, ResourceNode>;
  readonly structures: ReadonlyMap<StructureId, Structure>;
  readonly memories: ReadonlyMap<AgentId, readonly Memory[]>;
  readonly goals: ReadonlyMap<AgentId, readonly AgentGoal[]>;
  readonly signals: readonly Signal[];
}

/** Mutable working copy used inside a single tick, then frozen back into a `WorldState`. */
export interface WorldDraft {
  world: World;
  terrain: TerrainField;
  regions: Map<RegionId, Region>;
  agents: Map<AgentId, Agent>;
  lineages: Map<LineageId, Lineage>;
  lineageNodes: Map<OrganismId, LineageNode>;
  organisms: Map<OrganismId, Organism>;
  materials: Map<MaterialId, MaterialDefinition>;
  resources: Map<ResourceNodeId, ResourceNode>;
  structures: Map<StructureId, Structure>;
  memories: Map<AgentId, Memory[]>;
  goals: Map<AgentId, AgentGoal[]>;
  signals: Signal[];
}

export function toDraft(state: WorldState): WorldDraft {
  return {
    world: state.world,
    terrain: state.terrain,
    regions: new Map(state.regions),
    agents: new Map(state.agents),
    lineages: new Map(state.lineages),
    lineageNodes: new Map(state.lineageNodes),
    organisms: new Map(state.organisms),
    materials: new Map(state.materials),
    resources: new Map(state.resources),
    structures: new Map(state.structures),
    memories: new Map([...state.memories].map(([k, v]) => [k, [...v]])),
    goals: new Map([...state.goals].map(([k, v]) => [k, [...v]])),
    signals: [...state.signals],
  };
}

export function freezeDraft(draft: WorldDraft): WorldState {
  return {
    world: draft.world,
    terrain: draft.terrain,
    regions: draft.regions,
    agents: draft.agents,
    lineages: draft.lineages,
    lineageNodes: draft.lineageNodes,
    organisms: draft.organisms,
    materials: draft.materials,
    resources: draft.resources,
    structures: draft.structures,
    memories: draft.memories,
    goals: draft.goals,
    signals: draft.signals,
  };
}

/**
 * Stable iteration order.
 *
 * Every loop over entities uses a sorted key list. Map insertion order would leak the
 * storage layer's ordering into simulation outcomes and break replay.
 */
export function sortedIds<K extends string, V>(map: ReadonlyMap<K, V>): K[] {
  return [...map.keys()].sort();
}

export function livingOrganismIds(draft: WorldDraft): OrganismId[] {
  const ids: OrganismId[] = [];
  for (const id of sortedIds(draft.organisms)) {
    if (draft.organisms.get(id)?.alive) ids.push(id);
  }
  return ids;
}

export function organismsInRegion(draft: WorldDraft, regionId: RegionId): Organism[] {
  const out: Organism[] = [];
  for (const id of sortedIds(draft.organisms)) {
    const organism = draft.organisms.get(id);
    if (organism?.alive && organism.regionId === regionId) out.push(organism);
  }
  return out;
}

export function agentMemories(draft: WorldDraft, agentId: AgentId): Memory[] {
  return draft.memories.get(agentId) ?? [];
}

export function agentGoals(draft: WorldDraft, agentId: AgentId): AgentGoal[] {
  return draft.goals.get(agentId) ?? [];
}
