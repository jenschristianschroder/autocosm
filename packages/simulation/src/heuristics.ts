import {
  Prng,
  WORTH_FEEDING_MU,
  clampPerMille,
  hashSeed,
  makePosition,
  scaleByPerMille,
  type AgentAction,
  type MaterialId,
  type Observation,
  type ObservedInventoryEntry,
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

/** How many distinct materials a single construction may draw on. */
const MAX_BUILD_COMPONENTS = 3;

/**
 * Patterns whose useful functions are gated on hardness rather than bulk.
 *
 * `shell` and `lattice` are the two the `shelter` rule accepts, and shelter is the only
 * structure function that feeds back into survival (it discounts upkeep). A builder choosing
 * one of these should reach for its hardest stock, not its largest.
 */
const HARD_PATTERNS: ReadonlySet<string> = new Set(['shell', 'lattice']);

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

  /**
   * Can this organism afford the step a move would actually take?
   *
   * Mirrors `applyMove`: a step is clamped to `speedCuPerTick`, so a nearby target costs
   * proportionally less. Without this the organism proposes a walk it cannot pay for and
   * forfeits the turn — it does not fall through to resting, which is what it needs.
   */
  const canReach = (distanceCu: number): boolean => {
    if (!can.has('move')) return false;
    const travelled = Math.min(distanceCu, self.speedCuPerTick);
    return self.energy >= Math.max(1, Math.trunc((travelled * self.moveCostPer100Cu) / 100));
  };

  // 1. Flee an imminent threat. Survival overrides everything else.
  const threat = observation.organisms.find((o) => !o.kin && o.threatBand === 'dangerous');
  if (threat && healthRatio < 700 && canReach(threat.distanceCu * 2)) {
    const away = makePosition(
      self.position.x - (threat.position.x - self.position.x),
      self.position.z - (threat.position.z - self.position.z),
    );
    return { type: 'move', target: away };
  }

  // 2. Starving. Eat whatever is reachable, otherwise rest to lower the burn rate. Travel to a
  //    node is allowed here where branch 6 forbids it: migration is a journey of tens of ticks and
  //    an organism this far down will not survive one, so the nearest bounded food wins. Nodes
  //    deplete, so this cannot capture a turn indefinitely the way the regional graze could.
  if (energyRatio < 250) {
    const feed = nearestFeeding(observation, canReach, true);
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
    // Provisions are deliberately *not* eaten here, and the omission is measured rather than an
    // oversight. Letting a starving organism eat its own cargo looks free — it costs no step and
    // cannot be beaten to by a competitor — and it collapses the world. Against an otherwise
    // identical control at 1200 ticks: living organisms 152 -> 20, catalogue 189 -> 91,
    // discoveries 175 -> 77. A carried scrap is a one-off worth a fraction of a feeding site, and
    // crafted material is nutrition-poor by design, so an organism that eats one is still starving
    // next tick, eats another, and never travels to the renewable food at all. The first-match
    // ladder turns a cheap option into an absorbing state: taking it denies every branch below.
    //
    // Demoting it to a genuine last resort recovered the population (177 alive) but still spent
    // stock the combine branch needs: combinations 539 -> 335 and discoveries 212 -> 143 against
    // the same trajectory without it. Consuming a material destroys chemistry that has already
    // been gathered, so the trade is population against creation, and creation is the point.
    //
    // The *capability* still exists — `consume` accepts `targetKind: 'carried'`, the resolver
    // implements it, and an organism can see `nutritionPerUnit` on its own cargo — so a model-
    // driven agent may reach for it in a situation this fixed ladder cannot recognise. The
    // deterministic policy simply declines to.
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

  // 5. Reproduce when mature, energetic, motivated — and when the world has room.
  //
  //    Every precondition the resolver checks is checked here first, because this branch
  //    *returns*: proposing a birth the simulation will refuse costs the organism its entire
  //    turn — it never reaches feed, gather, build, combine, teach or explore.
  //
  //    The refractory check was added when cooldown was over half of every rejection in the
  //    world. The ceiling check is the same lesson learned a second time: once a world fills,
  //    `population` became 99% of all rejections (19,485 / 27,953 / 21,385 over 1500 ticks
  //    across three seeds), and production sat at 421 of 420 organisms with zero structures
  //    and no gather, build or combine anywhere in a 200-event window.
  if (
    can.has('reproduce') &&
    self.mature &&
    self.reproductionReady &&
    !observation.environment.atPopulationCeiling &&
    energyRatio > 700 &&
    healthRatio > 600
  ) {
    if (rng.chance(clampPerMille(drives.reproduce))) {
      return { type: 'reproduce', investment: clampPerMille(400 + drives.reproduce / 4) };
    }
  }

  // 6. Feed where you stand. Anything below a comfortable reserve tops up first, so building and
  //    exploring only happen from a position of strength. This branch offers *meals*, never
  //    journeys: biomass underfoot worth a turn, or a node already within interaction range.
  //
  //    The regional graze needs the ground to be worth a turn, not merely non-empty. `biomass > 0`
  //    was the test here, and it is what made the migration branch below unreachable: regrowth
  //    lays down a few mu every tick, so a stripped region always has *something* and every hungry
  //    organism standing on it spent its turn on that something. Worse, `applyConsume` takes
  //    `min(biomass, appetite)` from a pool the whole region shares — measured in production, 319
  //    organisms on 193 mu means roughly five of them eat and the other 314 are rejected with
  //    `unknownTarget`, having spent the turn anyway.
  if (energyRatio < 620) {
    const feed = nearestFeeding(observation, canReach, false);
    if (feed) return feed;
    if (observation.environment.biomass >= WORTH_FEEDING_MU) {
      return { type: 'consume', targetKind: 'biomass' };
    }
  }

  // 6b. Follow the food. Reached only by an organism branch 6 could not feed: hungry, nothing
  //     within reach, and nothing underfoot worth stopping for.
  //
  //     Measured in production at tick 15,208: 319 organisms on 193 mu in one region, 44 in
  //     another, and 23 of the 25 regions in view empty and pinned at the 6000 mu cap. That is
  //     why raising biomass regeneration 60 -> 180 changed nothing — it raised supply in regions
  //     already at their ceiling. Standing next to the food is the binding constraint, not the
  //     amount of it.
  //
  //     `richerNeighbours` already applies the ratio and the floor, so reaching here at all
  //     means the trip is worth taking. The nearest qualifying region wins rather than the
  //     richest: every one of them clears the same bar, so the cheapest crossing is the right
  //     one, and a starving organism has the least energy to spend on travel.
  //
  //     The target is the region's centre, not its near edge. Aiming at the edge would pile
  //     every migrant onto the boundary and rebuild the cluster one region over; aiming at the
  //     centre means each organism stops wherever it first finds food, which is a different
  //     place for each of them. `stepToward` walks one step per tick, and this branch keeps
  //     proposing the same destination until the ground underfoot is worth eating — at which
  //     point branch 6 takes over and the migration ends by itself.
  //
  //     What this is measured to do, and what it is not. The branch is reachable and its behaviour
  //     is pinned by constructed tests. Its world-level effect is regime-dependent, and the two
  //     regimes were measured separately because the first measurement taken was the misleading
  //     one.
  //
  //     Below the population ceiling, with room to grow, it works: three seeds over 400 ticks at
  //     the default cap, paired against a control, put mean living population at 206.0/222.7/197.7
  //     -> 218.4/231.2/215.0 and mean regions occupied at 13.79/14.30/14.56 -> 15.12/15.54/15.60.
  //     Every seed moves the same way on both metrics; paired t(2) is 5.00 on population and 14.07
  //     on occupancy against a critical 4.30. Spreading the world out is exactly what this branch
  //     is for, and it costs roughly 36% more tick time in that regime because tick cost is
  //     superlinear in living organisms.
  //
  //     At the ceiling it does nothing, and cannot: at `maxOrganisms: 140` over 600 ticks the two
  //     arms hold 119.1/118.7/118.9 living organisms each, identical to the decimal, at -0.1% time.
  //     A world pinned at its cap has no headroom for a healthier population to occupy.
  //
  //     An earlier measurement over 300 ticks on population-capped fixtures found nothing and was
  //     reported as a null result. It was regime-bound rather than wrong: at that horizon branch
  //     13's blind jitter and reproduction at the frontier have already saturated dispersal, and
  //     the directed effect has nothing left to add.
  //
  //     None of this demonstrates a fix for production, whose clustering took ~15,000 ticks to
  //     form and which no affordable fixture reproduces. That remains open and unproven.
  if (energyRatio < 620 && observation.environment.richerNeighbours.length > 0) {
    let nearest = observation.environment.richerNeighbours[0];
    for (const candidate of observation.environment.richerNeighbours) {
      if (nearest === undefined || candidate.distanceCu < nearest.distanceCu) nearest = candidate;
    }
    if (nearest !== undefined && canReach(nearest.distanceCu)) {
      return { type: 'move', target: makePosition(nearest.centre.x, nearest.centre.z) };
    }
  }

  // 6c. Walk to a node. Nothing underfoot, and nowhere better next door — so the bounded quantity
  //     in a distant node is the best food this organism can see. Ordered below migration because
  //     a node sits in the region being left; ordered above the crumb because a journey to real
  //     food beats a mouthful of nothing.
  if (energyRatio < 620) {
    const travel = nearestFeeding(observation, canReach, true);
    if (travel) return travel;
  }

  // 6d. Graze the crumb after all. Nothing in reach, nothing better next door, nowhere worth
  //     walking, and the ground holds less than a meal — so a mouthful of what is left beats
  //     resting on it. This keeps a uniformly stripped world behaving exactly as it did before 6b
  //     existed; only an organism with somewhere better to go now walks past the crumb.
  if (energyRatio < 620 && observation.environment.biomass > 0) {
    return { type: 'consume', targetKind: 'biomass' };
  }

  const carried = self.inventory.reduce((sum, e) => sum + e.quantity, 0);

  // 7. Build. Only lineages that evolved manipulation and memory reach this branch.
  if (can.has('build') && energyRatio > 450) {
    const nearbyStructure = observation.structures.some(
      (s) => s.builtByOwnLineage && s.distanceCu < 900,
    );
    if (carried >= BUILD_MATERIAL_THRESHOLD && !nearbyStructure) {
      // Choose the shape first, then the stock to suit it.
      //
      // A structure's derived *function* comes from the blended properties of its components,
      // and `blendProperties` weights by quantity — so one large soft component drags a hard one
      // back to the middle. Selecting purely by quantity, as this branch used to, means an
      // organism builds with whatever it happens to hold most of. Measured over two seeds:
      // structure hardness p50 = 220 against the shelter rule's 420, and *not one* of 24
      // structures ever derived a shelter function. The upkeep discount shelter exists to grant
      // had therefore never executed in 219,324 organism-ticks, so building was pure private
      // cost and selection deleted the manipulation trait that enables it.
      const pattern = choosePattern(rng, drives.build);
      const byQuantity = self.inventory
        .slice()
        .sort((a, b) => b.quantity - a.quantity || (a.materialId < b.materialId ? -1 : 1));
      const preferred = HARD_PATTERNS.has(pattern)
        ? self.inventory
            .slice()
            .sort(
              (a, b) =>
                b.hardness - a.hardness ||
                b.quantity - a.quantity ||
                (a.materialId < b.materialId ? -1 : 1),
            )
        : byQuantity;
      const take = (
        entries: readonly ObservedInventoryEntry[],
      ): { readonly materialId: MaterialId; readonly quantity: number }[] =>
        entries.slice(0, MAX_BUILD_COMPONENTS).map((e) => ({
          materialId: e.materialId,
          quantity: Math.max(1, Math.trunc(e.quantity)),
        }));
      const volumeOf = (cs: readonly { readonly quantity: number }[]): number =>
        cs.reduce((sum, c) => sum + c.quantity, 0);
      // Never trade away a buildable volume for hardness: the hardest stock may be a few scraps.
      const wanted = take(preferred);
      const components = volumeOf(wanted) >= BUILD_MATERIAL_THRESHOLD ? wanted : take(byQuantity);
      if (components.length > 0) {
        return { type: 'build', pattern, components };
      }
    }
  }

  // 7b. Combine. Two distinct materials become a composite, which is how anything new ever enters
  //     the world's chemistry.
  //
  //     Deliberately its own branch. `CAPABILITY_REQUIREMENTS` declares three rungs — collect 120,
  //     combine 220, build 250 — and this test used to sit *inside* the build branch above, so an
  //     organism in the 220-249 band could combine and would never propose it. The middle rung of
  //     the creative ladder, the one the manipulation trait has to stand on while climbing, did not
  //     exist in the only policy that runs every tick. Measured over 2000 ticks on two seeds:
  //     `materialCombined` fell to zero and stayed there from tick 750 and 1250 respectively, while
  //     14-23 living organisms sat above the combine gate throughout, and `materialDiscovered`
  //     followed it to zero. Production shows the same end state, with *zero* rejections — these
  //     actions were never proposed rather than being refused.
  if (
    can.has('combine') &&
    self.inventory.length >= 2 &&
    carried >= 90 &&
    // Its own energy floor, below the build branch's: combining is the cheaper act.
    energyRatio > 350
  ) {
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
      } else if (canReach(worn.distanceCu)) {
        return { type: 'move', target: worn.position };
      }
    }
  }

  // 9. Gather materials. A lineage that can build actively seeks raw material rather than
  //    waiting to stumble over it — this is what makes construction emerge at all. Gated on
  //    a comfortable energy level so that gathering never competes with staying alive.
  //
  //    Both inventory limits are respected here, not just the volume one. A heuristic bound
  //    looser than the simulation's own capacity guarantees a rejection, and because `decide()`
  //    returns on the first match, that rejection costs the organism its entire turn.
  if (can.has('collect') && carried < self.carryCapacity && energyRatio > 600) {
    const wantsMaterial = can.has('build') || rng.chance(clampPerMille(drives.build));
    if (wantsMaterial) {
      // A full slot table can still accept more of something already held, so the choice of
      // node — not merely whether to gather — is what the limit constrains.
      const held = new Set(self.inventory.map((e) => e.materialId));
      const hasFreeSlot = self.inventory.length < self.inventorySlotLimit;
      const candidates = observation.resources.filter(
        (r) => r.quantity > 0 && (hasFreeSlot || held.has(r.materialId)),
      );
      // A builder reaches for the hardest deposit in sight, not merely the nearest.
      //
      // Every candidate is already inside perception radius, so preferring hardness costs a
      // short walk rather than a journey. It is the difference between building at all and not:
      // node stock at hardness >= 420 is 17-18% of everything available and the richest deposits
      // run to 900, but taking the first node with stock meant no organism ever carried anything
      // above 264 — far under the 420 the shelter rule needs, with blending averaging it down
      // further. Nearest-first is retained for gatherers that cannot build, where bulk is the
      // point and a detour is waste.
      const node = can.has('build')
        ? candidates
            .slice()
            .sort(
              (a, b) =>
                b.hardness - a.hardness ||
                a.distanceCu - b.distanceCu ||
                (a.resourceNodeId < b.resourceNodeId ? -1 : 1),
            )[0]
        : candidates[0];
      if (node) {
        if (node.distanceCu <= INTERACTION_RANGE_CU) {
          return { type: 'collect', resourceNodeId: node.resourceNodeId, quantity: 60 };
        }
        if (canReach(node.distanceCu)) {
          return { type: 'move', target: node.position };
        }
      }
    }
  }

  // 10. Cooperate: feed a hungry kin when comfortable.
  //
  //     Judged by hunger, not by injury. `share` moves energy, and a full recipient is
  //     refused outright, so targeting the wounded spent the turn on a certain rejection.
  if (can.has('share') && energyRatio > 800) {
    const kin = observation.organisms.find(
      (o) => o.kin && o.energyBand !== 'fed' && o.distanceCu <= 420,
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
    // Teaching only transmits to a listener standing inside the signal's reach, so it is
    // proposed when one is actually there rather than on a dice roll. Reach is the entire
    // point of the act, which is why it goes out at full intensity: radius scales with
    // intensity, so calling at 600 covers 0.6x the body's range and silently misses most of
    // the neighbours it can already see. Measured over 1200 ticks, that difference alone
    // discarded 92% of the moments when a non-kin listener was within earshot.
    const teachable = observation.knownRecipes[0];
    const pupil = observation.organisms.find((o) => !o.kin && o.distanceCu <= self.signalRadiusCu);
    if (teachable !== undefined && pupil !== undefined) {
      return { type: 'signal', channel: 'teach', intensity: 1000, recipeKey: teachable.key };
    }
    const alarm = observation.organisms.some((o) => !o.kin && o.threatBand === 'dangerous');
    return { type: 'signal', channel: alarm ? 'alarm' : 'food', intensity: 500 };
  }

  // 12. Top up before wandering, weighted by the forage drive. Reached only above branch 6's
  //     hunger line, so this organism is not a migration candidate and may travel to a node.
  if (energyRatio < 900 && rng.chance(clampPerMille(drives.forage))) {
    const feed = nearestFeeding(observation, canReach, true);
    if (feed) return feed;
    if (observation.environment.biomass > 0) {
      return { type: 'consume', targetKind: 'biomass' };
    }
  }

  // 13. Explore, weighted by drive. Sessile lineages simply rest.
  if (
    self.speedCuPerTick > 40 &&
    canReach(self.speedCuPerTick) &&
    rng.chance(clampPerMille(drives.explore))
  ) {
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
function nearestFeeding(
  observation: Observation,
  canReach: (distanceCu: number) => boolean,
  allowTravel: boolean,
): AgentAction | null {
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

  //    The biomass floor is `WORTH_FEEDING_MU`, the same number the observable uses, and not the
  //    `> 200` it used to be. This test reads as "is the ground better than that node" and acted as
  //    "is there anything at all underfoot", which is why it captured the turn of every organism in
  //    a stripped region and made the migration branch below unreachable.
  const biomassIsBetter =
    observation.environment.biomass >= WORTH_FEEDING_MU &&
    (!best || best.nutritionPerUnit <= BIOMASS_ENERGY_PER_UNIT || best.distanceCu > 420);
  if (biomassIsBetter) return { type: 'consume', targetKind: 'biomass' };

  if (!best) return null;
  if (best.distanceCu <= 420) {
    return { type: 'consume', targetKind: 'resourceNode', targetId: best.resourceNodeId };
  }
  //    Walking to a node is a *journey*, not a meal, so the caller decides whether to take it. A
  //    hungry organism standing in a stripped region has a better journey available — the region
  //    next door holds renewable biomass at its cap, where a node holds a bounded quantity and, by
  //    construction, sits in the region it is trying to leave. Measured: with this returned
  //    unconditionally, migrants walked ~2000 cu out and were pulled back to a node for the next
  //    240 ticks, drifting a net 10 cu per tick against a speed of 40-120.
  if (allowTravel && canReach(best.distanceCu)) {
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
