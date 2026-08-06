import {
  Prng,
  clampPerMille,
  hashSeed,
  makePosition,
  scaleByPerMille,
  type AgentAction,
  type Observation,
} from '@autocosm/domain';

/**
 * The deterministic reflexive policy.
 *
 * Every organism uses this every tick. It is cheap, has no external dependency, and makes
 * the world fully playable with AI disabled — the model is an occasional advisor, never a
 * requirement. The policy is a pure function of `(observation, seed)`.
 *
 * Priorities are ordered by urgency, then modulated by the agent's drives so that lineages
 * with different temperaments behave visibly differently.
 */
/**
 * Material a builder accumulates before attempting a construction, in `mu`.
 *
 * Comfortably above {@link MIN_STRUCTURE_VOLUME} so a first attempt is not wasted.
 */
const BUILD_MATERIAL_THRESHOLD = 120;

/** Carrying capacity for raw material, in `mu`. Bounds inventory growth. */
const MAX_CARRIED_MATERIAL = 300;

/**
 * How worn a construction must be before a passer-by will spend material on it, in per mille.
 *
 * High enough that maintenance starts long before collapse is imminent, low enough that a
 * freshly-raised structure is not immediately patched for no gain.
 */
const REPAIR_INTEGRITY_THRESHOLD = 800;

/**
 * How far an organism will travel to maintain a structure, in `cu`.
 *
 * Deliberately wider than {@link INTERACTION_RANGE_CU}: the whole point is that a builder crosses
 * the clearing to tend its work rather than only mending what it happens to be standing on.
 */
const REPAIR_SEEK_RANGE_CU = 1400;

/** Mirrors `SimulationConfig.interactionRadiusCu`; the heuristic must not propose out-of-range acts. */
const INTERACTION_RANGE_CU = 420;

/**
 * Material committed to a single repair, in `mu`.
 *
 * Sized to {@link BUILD_MATERIAL_THRESHOLD} rather than a token patch: a structure's median volume
 * is close to what a builder carries, so a full load restores most of a worn one while a scrap
 * restores single per-mille and wastes the tick.
 */
const REPAIR_MATERIAL_UNITS = BUILD_MATERIAL_THRESHOLD;

export function decideHeuristically(observation: Observation, seed: number): AgentAction {
  const rng = new Prng(hashSeed('heuristic', seed, observation.self.organismId, observation.tick));
  const can = new Set(observation.availableActions);
  const self = observation.self;
  const energyRatio = self.maxEnergy <= 0 ? 0 : Math.trunc((self.energy * 1000) / self.maxEnergy);
  const healthRatio = self.maxHealth <= 0 ? 0 : Math.trunc((self.health * 1000) / self.maxHealth);
  const drives = observation.drives;

  // 1. Flee an imminent threat. Survival overrides everything else.
  const threat = observation.organisms.find((o) => !o.kin && o.threatBand === 'dangerous');
  if (threat && healthRatio < 700 && can.has('move')) {
    const away = makePosition(
      self.position.x - (threat.position.x - self.position.x),
      self.position.z - (threat.position.z - self.position.z),
    );
    return { type: 'move', target: away };
  }

  // 2. Starving. Eat whatever is reachable, otherwise rest to lower the burn rate.
  if (energyRatio < 250) {
    const feed = nearestFeeding(observation);
    if (feed) return feed;
    if (observation.environment.biomass > 0) {
      return { type: 'consume', targetKind: 'biomass' };
    }
    if (can.has('attack')) {
      const prey = observation.organisms.find((o) => !o.kin && o.threatBand === 'harmless');
      if (prey && prey.distanceCu <= 420) {
        return { type: 'attack', targetOrganismId: prey.organismId };
      }
    }
    return { type: 'rest' };
  }

  // 3. Shelter from environmental pressure when a usable structure is in reach.
  if (observation.environment.pressureSeverity > 400 && can.has('attach')) {
    const shelter = observation.structures.find(
      (s) => s.inspected && s.functions.includes('shelter') && s.distanceCu <= 420,
    );
    if (shelter) return { type: 'attach', structureId: shelter.structureId };
  }

  // 4. Curiosity: an uninspected structure in sight is worth studying, and is how knowledge
  //    crosses a lineage boundary. A construction is a legible landmark, so this succeeds at
  //    whatever range it became visible.
  if (can.has('inspect')) {
    const unknown = observation.structures.find((s) => !s.inspected);
    if (unknown) {
      return { type: 'inspect', targetKind: 'structure', targetId: unknown.structureId };
    }
  }

  // 5. Reproduce when mature, energetic and motivated.
  if (can.has('reproduce') && self.mature && energyRatio > 700 && healthRatio > 600) {
    if (rng.chance(clampPerMille(drives.reproduce))) {
      return { type: 'reproduce', investment: clampPerMille(400 + drives.reproduce / 4) };
    }
  }

  // 6. Feed opportunistically. Anything below a comfortable reserve tops up first, so
  //    building and exploring only happen from a position of strength.
  if (energyRatio < 620) {
    const feed = nearestFeeding(observation);
    if (feed) return feed;
    if (observation.environment.biomass > 0) {
      return { type: 'consume', targetKind: 'biomass' };
    }
  }

  const carried = self.inventory.reduce((sum, e) => sum + e.quantity, 0);

  // 7. Build. Only lineages that evolved manipulation and memory reach this branch.
  if (can.has('build') && energyRatio > 450) {
    const nearbyStructure = observation.structures.some(
      (s) => s.builtByOwnLineage && s.distanceCu < 900,
    );
    if (carried >= BUILD_MATERIAL_THRESHOLD && !nearbyStructure) {
      const components = self.inventory
        .slice()
        .sort((a, b) => b.quantity - a.quantity || (a.materialId < b.materialId ? -1 : 1))
        .slice(0, 3)
        .map((e) => ({ materialId: e.materialId, quantity: Math.max(1, Math.trunc(e.quantity)) }));
      if (components.length > 0) {
        return { type: 'build', pattern: choosePattern(rng, drives.build), components };
      }
    }
    // Combining two distinct materials is how new composites enter the world.
    if (can.has('combine') && self.inventory.length >= 2 && carried >= 90) {
      const [a, b] = self.inventory;
      if (a && b && rng.chance(clampPerMille(drives.build))) {
        return {
          type: 'combine',
          components: [
            { materialId: a.materialId, quantity: Math.max(1, Math.trunc(a.quantity / 2)) },
            { materialId: b.materialId, quantity: Math.max(1, Math.trunc(b.quantity / 2)) },
          ],
        };
      }
    }
  }

  // 8. Maintain what already exists. Without this branch nothing built ever outlives a simulated
  //    day: integrity only falls, so every construction in the world's history collapsed.
  //
  //    Ordered *after* building, and gated on the same material threshold, on measured evidence:
  //    when maintenance came first and needed only a scrap, patching consumed the stock builders
  //    were accumulating and construction fell from 31 structures to 9 — the world traded building
  //    for mending and still kept nothing. Reaching here with a full load means the build branch
  //    declined, which it does when one of this lineage's structures already stands nearby. That is
  //    precisely the organism that used to hoard material beside its own crumbling work.
  //
  //    Open to any lineage: a construction is a shared landmark and tending a neighbour's is a
  //    cooperative act.
  if (can.has('repair') && carried >= BUILD_MATERIAL_THRESHOLD && energyRatio > 400) {
    const worn = observation.structures
      .filter(
        (s) => s.integrity < REPAIR_INTEGRITY_THRESHOLD && s.distanceCu <= REPAIR_SEEK_RANGE_CU,
      )
      .sort(
        (a, b) =>
          Number(b.builtByOwnLineage) - Number(a.builtByOwnLineage) ||
          a.integrity - b.integrity ||
          (a.structureId < b.structureId ? -1 : 1),
      )[0];
    if (worn) {
      if (worn.distanceCu <= INTERACTION_RANGE_CU) {
        const stock = self.inventory
          .slice()
          .sort((a, b) => b.quantity - a.quantity || (a.materialId < b.materialId ? -1 : 1))[0];
        if (stock) {
          return {
            type: 'repair',
            structureId: worn.structureId,
            components: [
              {
                materialId: stock.materialId,
                quantity: Math.max(1, Math.min(REPAIR_MATERIAL_UNITS, Math.trunc(stock.quantity))),
              },
            ],
          };
        }
      } else if (can.has('move')) {
        return { type: 'move', target: worn.position };
      }
    }
  }

  // 9. Gather materials. A lineage that can build actively seeks raw material rather than
  //    waiting to stumble over it — this is what makes construction emerge at all. Gated on
  //    a comfortable energy level so that gathering never competes with staying alive.
  if (can.has('collect') && carried < MAX_CARRIED_MATERIAL && energyRatio > 600) {
    const wantsMaterial = can.has('build') || rng.chance(clampPerMille(drives.build));
    if (wantsMaterial) {
      const node = observation.resources.find((r) => r.quantity > 0);
      if (node) {
        if (node.distanceCu <= 420) {
          return { type: 'collect', resourceNodeId: node.resourceNodeId, quantity: 60 };
        }
        if (can.has('move')) {
          return { type: 'move', target: node.position };
        }
      }
    }
  }

  // 10. Cooperate: feed a starving kin when comfortable.
  if (can.has('share') && energyRatio > 800) {
    const kin = observation.organisms.find(
      (o) => o.kin && o.healthBand === 'weak' && o.distanceCu <= 420,
    );
    if (kin && rng.chance(clampPerMille(drives.cooperate))) {
      return {
        type: 'share',
        targetOrganismId: kin.organismId,
        energy: Math.max(1, Math.trunc(self.energy / 8)),
      };
    }
  }

  // 11. Communicate. Cheap, and the only way culture spreads.
  if (can.has('signal') && rng.chance(scaleByPerMille(200, drives.cooperate))) {
    const teachable = observation.knownRecipes[0];
    if (teachable !== undefined && rng.chance(400)) {
      return { type: 'signal', channel: 'teach', intensity: 600, recipeKey: teachable.key };
    }
    const alarm = observation.organisms.some((o) => !o.kin && o.threatBand === 'dangerous');
    return { type: 'signal', channel: alarm ? 'alarm' : 'food', intensity: 500 };
  }

  // 12. Top up before wandering, weighted by the forage drive.
  if (energyRatio < 900 && rng.chance(clampPerMille(drives.forage))) {
    const feed = nearestFeeding(observation);
    if (feed) return feed;
    if (observation.environment.biomass > 0) {
      return { type: 'consume', targetKind: 'biomass' };
    }
  }

  // 13. Explore, weighted by drive. Sessile lineages simply rest.
  if (can.has('move') && self.speedCuPerTick > 40 && rng.chance(clampPerMille(drives.explore))) {
    const jitter = self.speedCuPerTick * 6;
    return {
      type: 'move',
      target: makePosition(
        self.position.x + rng.nextRange(-jitter, jitter),
        self.position.z + rng.nextRange(-jitter, jitter),
      ),
    };
  }

  return { type: 'rest' };
}

const BIOMASS_ENERGY_PER_UNIT = 5;

/**
 * Choose the most nourishing food within reach. Grazing regional biomass and cropping a
 * resource node draw on the same appetite, so the comparison is purely one of yield per
 * unit: a node only wins when it is richer than biomass or biomass has been grazed out.
 * Getting this wrong starves the slow, heavy lineages that must feed well to build.
 */
function nearestFeeding(observation: Observation): AgentAction | null {
  let best: (typeof observation.resources)[number] | undefined;
  for (const r of observation.resources) {
    if (r.nutritionPerUnit <= 0 || r.quantity <= 0) continue;
    if (!best) {
      best = r;
      continue;
    }
    if (r.nutritionPerUnit > best.nutritionPerUnit) best = r;
    else if (r.nutritionPerUnit === best.nutritionPerUnit && r.distanceCu < best.distanceCu)
      best = r;
  }

  const biomassIsBetter =
    observation.environment.biomass > 200 &&
    (!best || best.nutritionPerUnit <= BIOMASS_ENERGY_PER_UNIT || best.distanceCu > 420);
  if (biomassIsBetter) return { type: 'consume', targetKind: 'biomass' };

  if (!best) return null;
  if (best.distanceCu <= 420) {
    return { type: 'consume', targetKind: 'resourceNode', targetId: best.resourceNodeId };
  }
  if (observation.availableActions.includes('move')) {
    return { type: 'move', target: best.position };
  }
  return null;
}

function choosePattern(
  rng: Prng,
  buildDrive: number,
): Extract<AgentAction, { type: 'build' }>['pattern'] {
  // A stronger build drive favours deliberate patterns; a weaker one piles material up.
  const options =
    buildDrive > 600
      ? (['shell', 'lattice', 'vessel', 'mesh'] as const)
      : (['lattice', 'anchor', 'mesh'] as const);
  return options[rng.nextInt(options.length)] ?? 'lattice';
}
