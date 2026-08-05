import type { WorldRecordBundle } from '@autocosm/domain';
import type { Page, PageRequest, WorldRepository } from './ports.js';

/**
 * Whole-world load and save.
 *
 * Both the tick job and the web API need "the world, as records". Putting the fan-out here keeps
 * paging and deletion rules in one place instead of letting each app invent its own limits.
 *
 * Every drain is bounded by `MAX_PER_STORE`, so a runaway simulation degrades into a truncated
 * read rather than an unbounded one. The tick engine enforces population caps far below this.
 */

export const MAX_PER_STORE = 20_000;

async function drain<T>(
  fetchPage: (page: PageRequest) => Promise<Page<T>>,
  pageSize: number,
  limit = MAX_PER_STORE,
): Promise<T[]> {
  const out: T[] = [];
  let continuation: string | undefined;
  do {
    const page: Page<T> = await fetchPage(
      continuation === undefined ? { limit: pageSize } : { limit: pageSize, continuation },
    );
    for (const item of page.items) {
      if (out.length >= limit) return out;
      out.push(item);
    }
    continuation = page.continuation;
  } while (continuation !== undefined);
  return out;
}

/**
 * Read every record for a world.
 *
 * Returns `undefined` when the world row is absent, which callers translate into "not seeded"
 * rather than an error so a cold environment can answer readiness truthfully.
 */
export async function loadWorldBundle(
  repo: WorldRepository,
  worldId: string,
): Promise<WorldRecordBundle | undefined> {
  const world = await repo.worlds.get(worldId);
  if (!world) return undefined;

  const [regions, agents, lineages, organisms, materials, resources, structures, signals] =
    await Promise.all([
      repo.regions.listByWorld(worldId),
      drain((p) => repo.agents.listByWorld(worldId, p), 500),
      drain((p) => repo.lineages.listByWorld(worldId, p), 500),
      drain((p) => repo.organisms.listByWorld(worldId, p), 1_000),
      repo.materials.listByWorld(worldId),
      drain((p) => repo.resources.listByWorld(worldId, p), 1_000),
      drain((p) => repo.structures.listByWorld(worldId, p), 1_000),
      repo.signals.listByWorld(worldId),
    ]);

  // Memories and genealogy are partitioned by their owner, so they are fetched per owner. Both
  // collections are small per owner by construction (memory is capped by evolved capacity).
  const [lineageNodeGroups, memoryGroups, goalGroups] = await Promise.all([
    Promise.all(lineages.map((l) => drain((p) => repo.lineages.listNodes(worldId, l.id, p), 500))),
    Promise.all(agents.map((a) => drain((p) => repo.memories.listByAgent(worldId, a.id, p), 200))),
    Promise.all(agents.map((a) => drain((p) => repo.goals.listByAgent(worldId, a.id, p), 100))),
  ]);

  return {
    world: world.value,
    regions,
    agents,
    lineages,
    lineageNodes: lineageNodeGroups.flat(),
    organisms,
    materials,
    resources,
    structures,
    memories: memoryGroups.flat(),
    goals: goalGroups.flat(),
    signals,
  };
}

export interface SaveWorldOptions {
  /**
   * The bundle as it was before the tick. Anything present then and absent now is deleted, which
   * is how dead organisms, collapsed structures and faded memories leave storage. Omit it and
   * nothing is deleted, which is correct for a first write.
   */
  readonly previous?: WorldRecordBundle | undefined;
  /** ETag guarding the world row. Supply the tag that was read to detect a concurrent writer. */
  readonly worldEtag?: string | undefined;
}

/**
 * Write a whole world.
 *
 * Ordering is deliberate. Dependent collections are written first and the world row — which
 * carries the authoritative tick — last, so a crash mid-save leaves a world whose recorded tick
 * is *behind* its data. The next run then recomputes that tick, which is idempotent, rather than
 * skipping it, which would not be.
 */
export async function saveWorldBundle(
  repo: WorldRepository,
  bundle: WorldRecordBundle,
  options: SaveWorldOptions = {},
): Promise<string> {
  const worldId = bundle.world.id;
  const previous = options.previous;

  await Promise.all([
    repo.regions.putMany(bundle.regions),
    repo.agents.putMany(bundle.agents),
    repo.lineages.putMany(bundle.lineages),
    repo.lineages.putNodes(worldId, bundle.lineageNodes),
    repo.organisms.putMany(bundle.organisms),
    repo.materials.putMany(bundle.materials),
    repo.resources.putMany(bundle.resources),
    repo.structures.putMany(bundle.structures),
    repo.memories.putMany(bundle.memories),
    repo.goals.putMany(bundle.goals),
    // Signals are short-lived and world-scoped, so a wholesale replace is both simplest and
    // cheapest; there is never a large backlog to rewrite.
    repo.signals.replaceAll(worldId, bundle.signals),
  ]);

  if (previous) {
    const goneOrganisms = missing(previous.organisms, bundle.organisms, (o) => o.id).map((o) => ({
      regionId: o.regionId,
      organismId: o.id,
    }));
    const goneStructures = missing(previous.structures, bundle.structures, (s) => s.id).map(
      (s) => ({
        regionId: s.regionId,
        structureId: s.id,
      }),
    );
    const goneMemories = missing(previous.memories, bundle.memories, (m) => m.id).map((m) => ({
      agentId: m.agentId,
      memoryId: m.id,
    }));

    await Promise.all([
      goneOrganisms.length > 0 ? repo.organisms.deleteMany(worldId, goneOrganisms) : undefined,
      goneStructures.length > 0 ? repo.structures.deleteMany(worldId, goneStructures) : undefined,
      goneMemories.length > 0 ? repo.memories.deleteMany(worldId, goneMemories) : undefined,
    ]);
  }

  return await repo.worlds.put(bundle.world, options.worldEtag);
}

function missing<T>(before: readonly T[], after: readonly T[], idOf: (item: T) => string): T[] {
  const kept = new Set(after.map(idOf));
  return before.filter((item) => !kept.has(idOf(item)));
}
