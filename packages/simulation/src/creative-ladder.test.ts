import { describe, expect, it } from 'vitest';

import {
  asAgentId,
  asLineageId,
  asMaterialId,
  asOrganismId,
  asRegionId,
  asWorldId,
  derivePhenotype,
  makePosition,
  type MaterialId,
  type Observation,
  type Organism,
  type OrganismId,
} from '@autocosm/domain';

import { DEFAULT_SIMULATION_CONFIG, type SimulationConfig } from './config.js';
import { EventSink } from './events.js';
import { decideHeuristically } from './heuristics.js';
import { EnergyLedger, resolveAction, type ResolutionContext } from './resolve.js';
import { toDraft } from './state.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';

/**
 * The creative ladder: collect (120) -> combine (220) -> build (250).
 *
 * `CAPABILITY_REQUIREMENTS` declares three rungs, and the middle one did not exist. The
 * deterministic policy nested its combine branch *inside* `if (can.has('build') ...)`, so an
 * organism in the 220-249 band — able to combine and not to build — could never propose a
 * combination. The rung the trait has to stand on while climbing from collect to build was
 * therefore load-bearing in the domain and absent from the only policy that runs every tick.
 *
 * Measured before the fix, 2000 ticks, two seeds, per-250-tick windows: `materialCombined`
 * fell to **zero and stayed there** from tick 750 (seed 4242424) and tick 1250 (seed 91017),
 * while 14-23 living organisms sat above the combine gate the whole time. `materialDiscovered`
 * followed it to zero, because combining is the only way a new composite enters the world.
 * Production shows the identical end state: no material discovered for 8 800 of its 12 630
 * ticks, `manipulationScore` p50 = 111, and zero collect/combine/build events — with **zero
 * rejections**, because these actions were never proposed rather than being refused.
 *
 * The second defect measured alongside it: nothing an organism carries could ever be eaten.
 * `applyConsume` read regional biomass and resource nodes and never inventory, so an organism
 * could not eat a substance in its own hands that it could have eaten off the ground. The
 * resolver now implements it, and the tests below pin that.
 *
 * **The hypothesis that this would arrest the manipulation collapse was tested and rejected.**
 * The reasoning — that gathering below the combine gate is strictly negative, which is what pins
 * median genotype manipulation to exactly 120 with a phenotype of 116 after the armour tax — is
 * sound and still unaddressed. But a heuristic that eats carried stock is worse than the disease:
 * as an early branch it took the population from 152 to 20; demoted to a last resort it recovered
 * the population and cut combinations 539 -> 335 and discoveries 212 -> 143. So the capability
 * ships and the deterministic policy declines to use it, which `heuristics.ts` records at length.
 * A private, scaling return to manipulation is still owed; this was not it.
 *
 * These tests construct their subject rather than searching a generated world for one, because
 * whether any organism happens to sit in a 30-point trait band at a given tick is a property of
 * the trajectory and not of the mechanism.
 */

const WORLD_ID = asWorldId('w-ladder');
const AGENT_ID = asAgentId('ag-ladder');
const LINEAGE_ID = asLineageId('ln-ladder');
const ORGANISM_ID = asOrganismId('or-ladder');
const REGION_ID = asRegionId('rg-0-0');

const FIBRE = asMaterialId('fibre');
const CHITIN = asMaterialId('chitin');

interface Carried {
  readonly materialId: MaterialId;
  readonly quantity: number;
  readonly nutritionPerUnit: number;
}

/**
 * An observation with every branch above the one under test deliberately quiet: no threat, no
 * environmental pressure, no visible structure, full health. What the organism does here is
 * decided by its capabilities and its inventory alone.
 */
function observationOf(options: {
  readonly availableActions: readonly string[];
  readonly carried: readonly Carried[];
  readonly energyRatio: number;
  readonly biomass: number;
  readonly manipulation: number;
}): Observation {
  const maxEnergy = 1000;
  return {
    version: 1,
    worldId: WORLD_ID,
    tick: 100,
    self: {
      organismId: ORGANISM_ID,
      agentId: AGENT_ID,
      lineageId: LINEAGE_ID,
      position: makePosition(0, 0),
      regionId: REGION_ID,
      energy: Math.trunc((maxEnergy * options.energyRatio) / 1000),
      maxEnergy,
      health: 1000,
      maxHealth: 1000,
      ageTicks: 400,
      maxAgeTicks: 1200,
      mature: true,
      // Quiet the reproduce branch without relying on the population ceiling.
      reproductionReady: false,
      generation: 3,
      inventory: options.carried.map((c) => ({
        materialId: c.materialId,
        quantity: c.quantity,
        hardness: 300,
        density: 300,
        nutritionPerUnit: c.nutritionPerUnit,
      })),
      carryCapacity: 240,
      inventorySlotLimit: 8,
      planning: 300,
      manipulation: options.manipulation,
      memorySlots: 4,
      speedCuPerTick: 120,
      moveCostPer100Cu: 3,
      perceptionRadiusCu: 900,
      signalRadiusCu: 900,
    },
    environment: {
      biome: 'plain',
      lightPerMille: 800,
      temperature: 500,
      waterCoverage: 200,
      biomass: options.biomass,
      pressure: 'none',
      pressureSeverity: 0,
      atPopulationCeiling: true,
    },
    organisms: [],
    resources: [],
    structures: [],
    signals: [],
    memories: [],
    goals: [],
    drives: {
      survive: 500,
      forage: 500,
      reproduce: 0,
      explore: 500,
      cooperate: 500,
      // Certainty, so the probabilistic gate inside the combine branch cannot mask the result.
      build: 1000,
    },
    temperament: 'balanced',
    aspiration: 'test',
    knownRecipes: [],
    availableActions: options.availableActions,
  };
}

/** Everything an organism at the combine rung can do: collect and combine, but not build. */
const COMBINE_BAND = ['move', 'consume', 'rest', 'collect', 'combine', 'inspect'] as const;
/** Everything an organism one rung lower can do. */
const COLLECT_BAND = ['move', 'consume', 'rest', 'collect', 'inspect'] as const;

/** The heuristic is seeded, so sample across seeds rather than trusting one roll. */
function decisionsAcross(observation: Observation, seeds: number): Set<string> {
  const kinds = new Set<string>();
  for (let seed = 0; seed < seeds; seed += 1) {
    kinds.add(decideHeuristically(observation, seed).type);
  }
  return kinds;
}

describe('the combine rung of the creative ladder', () => {
  it('an organism that can combine but cannot build still proposes a combination', () => {
    const observation = observationOf({
      availableActions: COMBINE_BAND,
      carried: [
        { materialId: FIBRE, quantity: 60, nutritionPerUnit: 0 },
        { materialId: CHITIN, quantity: 60, nutritionPerUnit: 0 },
      ],
      energyRatio: 900,
      biomass: 4000,
      manipulation: 230,
    });

    expect(decisionsAcross(observation, 24)).toContain('combine');
  });

  it('an organism below the combine gate never proposes a combination', () => {
    // Kills the mutant that simply deletes the capability check. Same inventory, same energy,
    // one rung lower: `combine` is absent from `availableActions`, so it must not be proposed.
    const observation = observationOf({
      availableActions: COLLECT_BAND,
      carried: [
        { materialId: FIBRE, quantity: 60, nutritionPerUnit: 0 },
        { materialId: CHITIN, quantity: 60, nutritionPerUnit: 0 },
      ],
      energyRatio: 900,
      biomass: 4000,
      manipulation: 200,
    });

    expect(decisionsAcross(observation, 24)).not.toContain('combine');
  });

  it('a single material is not a combination', () => {
    const observation = observationOf({
      availableActions: COMBINE_BAND,
      carried: [{ materialId: FIBRE, quantity: 200, nutritionPerUnit: 0 }],
      energyRatio: 900,
      biomass: 4000,
      manipulation: 230,
    });

    expect(decisionsAcross(observation, 24)).not.toContain('combine');
  });
});

describe('carried material is food', () => {
  /**
   * The mechanism lives in the resolver, deliberately not in the deterministic policy.
   *
   * `decideHeuristically` used to reach for cargo when hungry, and it collapsed the world: against
   * an otherwise identical control at 1200 ticks, living organisms fell 152 -> 20, the catalogue
   * 189 -> 91 and discoveries 175 -> 77. Demoting it to a last resort recovered the population
   * (177 alive) but still cost creation — combinations 539 -> 335, discoveries 212 -> 143 on the
   * same trajectory — because a material eaten is chemistry the combine branch will never see.
   *
   * So the ladder keeps the *capability* and drops the *policy*: `consume` accepts
   * `targetKind: 'carried'`, an organism perceives `nutritionPerUnit` on its own cargo, and a
   * model-driven agent may use it in a situation this fixed ladder cannot recognise. These tests
   * therefore pin the resolver, which is what still exists, rather than a heuristic branch that
   * measurement removed.
   */
  const EDIBLE = { hardness: 200, nutritionPerUnit: 7 };

  /** A living organism, hungry, carrying `quantity` of a world material with the given nutrition. */
  function stageEater(nutritionPerUnit: number): {
    ctx: ResolutionContext;
    organismId: OrganismId;
    materialId: MaterialId;
    before: Organism;
  } {
    let state = generateWorld({ seed: 4_242_424, worldId: 'w-carried' });
    for (let index = 0; index < 40; index += 1) state = advanceTick(state).state;

    const materialId = [...state.materials.values()].find(
      (m) => m.nutritionPerUnit > 0 && m.properties.toxicity === 0,
    )?.id;
    if (!materialId) throw new Error('the world holds no edible, non-toxic material');
    const definition = state.materials.get(materialId);
    if (!definition) throw new Error('unreachable');

    const candidate = [...state.organisms.values()]
      .filter((o) => o.alive)
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!candidate) throw new Error('the world holds no living organism');

    // Nutrition is a property of the substance, so the fixture varies the material rather than
    // the cargo — an inedible mouthful is an inedible *material*, exactly as the resolver reads it.
    const materials = new Map(state.materials);
    materials.set(materialId, { ...definition, nutritionPerUnit });

    const organism: Organism = {
      ...candidate,
      energy: 100,
      inventory: [{ materialId, quantity: 40 }],
    };
    const organisms = new Map(state.organisms);
    organisms.set(organism.id, organism);

    const draft = toDraft({ ...state, materials, organisms });
    const events = new EventSink(draft.world.id, draft.world.tick);
    return {
      ctx: { draft, config: DEFAULT_SIMULATION_CONFIG, events, ledger: new EnergyLedger() },
      organismId: organism.id,
      materialId,
      before: organism,
    };
  }

  it('eating cargo converts it into energy and removes it from the inventory', () => {
    const { ctx, organismId, materialId, before } = stageEater(EDIBLE.nutritionPerUnit);

    const resolution = resolveAction(ctx, organismId, { type: 'consume', targetKind: 'carried' });
    expect(resolution.accepted).toBe(true);

    const after = ctx.draft.organisms.get(organismId);
    expect(after?.energy).toBeGreaterThan(before.energy);
    const carriedAfter = after?.inventory.find((e) => e.materialId === materialId)?.quantity ?? 0;
    expect(carriedAfter).toBeLessThan(40);
  });

  it('inedible cargo is not mistaken for food', () => {
    // Kills the mutant that eats whatever is carried, and pins that a refusal costs nothing:
    // an organism that cannot eat its cargo must keep it.
    const { ctx, organismId, materialId, before } = stageEater(0);

    const resolution = resolveAction(ctx, organismId, { type: 'consume', targetKind: 'carried' });
    expect(resolution.accepted).toBe(false);
    expect(resolution.reason).toBe('actionUnavailable');

    const after = ctx.draft.organisms.get(organismId);
    expect(after?.energy).toBe(before.energy);
    expect(after?.inventory.find((e) => e.materialId === materialId)?.quantity).toBe(40);
  });

  it('the deterministic policy leaves cargo alone even when starving with nothing in reach', () => {
    // The measured decision, pinned so it cannot be re-introduced by a plausible-looking edit.
    // Starving, no grazing, no node, edible cargo in hand: the organism rests rather than eating
    // stock the combine branch needs.
    const observation = observationOf({
      availableActions: COMBINE_BAND,
      carried: [{ materialId: FIBRE, quantity: 40, nutritionPerUnit: 7 }],
      energyRatio: 100,
      biomass: 0,
      manipulation: 230,
    });

    expect(decisionsAcross(observation, 8)).toEqual(new Set(['rest']));
  });
});

describe('a world does not lose the ability to combine', () => {
  /**
   * The outcome, not the mechanism — and scoped honestly to what these two fixes establish.
   *
   * The defect was that capable organisms *never proposed*: 14-23 lived above the combine gate
   * for the whole tail of a 2000-tick run while `materialCombined` sat at zero. So the property
   * to pin is the implication itself — **wherever the capability exists, combining happens** —
   * which fails loudly on the pre-fix code and cannot be satisfied by luck.
   *
   * Deliberately *not* an assertion that combining continues to the end of the run. Measured on
   * this exact trajectory at the default `maxOrganisms`, `combine` leaves `availableActions`
   * entirely at tick ~1250: manipulation decays below its own 220 gate because nothing above the
   * collect gate has a private return. That is the fitness valley this plan already records as
   * needing a measured balance change of its own, and it is out of scope here. Asserting against it
   * would be asserting that a fix in the policy layer repairs a gradient in the selection layer,
   * which it does not.
   *
   * Deliberately *not* an assertion that discovery continues either: `material-discovery.test.ts`
   * requires the opposite, because the reachable combination space genuinely closes.
   *
   * What this guards, verified by mutation rather than asserted:
   *
   * - Disabling the combine branch entirely fails it, naming five barren windows and how many
   *   organisms were capable in each (31, 61, 5, 2, 2 at ticks 200-1000).
   * - Re-nesting the branch under `can.has('build')` — the literal pre-fix defect — **passes**.
   *   Organisms above the 250 build gate keep combining and mask the 220-249 band at world scale.
   *
   * So this test guards the branch being reachable at all in a running world; the narrow band is
   * guarded by `combines when manipulation sits between the combine and build gates` above, which
   * was verified failing against the pre-fix ordering. Recorded because a world-level test that
   * cannot see the defect it was written for is worse than none if its scope is left implied.
   *
   * **Coverage is now the full ticks 200-1400, and it widened because the world got smaller.** This
   * run takes `maxOrganisms: 140` rather than the default 420 — a cost change, since tick cost is
   * superlinear in headcount (measured 125s against ~590s for this same 1400-tick trajectory,
   * ~4.7x) and this test blew its 900s budget after `biomassRegenAtFullLight` went 60 -> 180.
   *
   * The coverage note here used to read "ticks 200-1000: the last two windows carry zero capable
   * organisms, so they are premise-free rather than passing." At cap 140 that is no longer true.
   * Organisms above the 220 gate, per 200-tick window:
   *
   *     tick      200  400  600  800  1000  1200  1400
   *     cap 140    65   63   57   40    42    38    31
   *     cap 420   138  100   99  151   115     -     -
   *
   * Every window carries a premise, so the implication is actually tested across the whole horizon
   * instead of two-sevenths of it being decorative. Offered as an observation and not a claim: a
   * world below carrying capacity has surplus energy, and manipulation's decay is a selection
   * response to a trait that costs upkeep and mass without a private return, so less competition
   * plausibly slows the decay. This file does not measure that mechanism and does not assert it.
   *
   * What is given up, and it is real: at cap 140 this test can no longer observe the *priced-out*
   * condition production actually exhibits, where a world pinned at its ceiling has no surplus and
   * the ladder is unreachable from below. That was already out of scope here per the note above,
   * and it is guarded at capacity by `population-saturation.test.ts`, which asserts the world
   * genuinely reaches its ceiling and still gathers and builds there.
   */
  it('combines material in every window where an organism can combine', () => {
    const HORIZON = 1400;
    const WINDOW = 200;
    // Phenotype gate for `combine` from `CAPABILITY_REQUIREMENTS`.
    const COMBINE_GATE = 220;
    const CONFIG: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, maxOrganisms: 140 };

    let state = generateWorld({ seed: 4_242_424, worldId: 'w-ladder-run' });
    let windowCombines = 0;
    const capableWindows: { readonly tick: number; readonly capable: number }[] = [];
    const barrenWindows: { readonly tick: number; readonly capable: number }[] = [];

    for (let index = 0; index < HORIZON; index += 1) {
      const result = advanceTick(state, { config: CONFIG });
      state = result.state;
      for (const event of result.events) {
        if (event.kind === 'materialCombined') windowCombines += 1;
      }
      if ((index + 1) % WINDOW !== 0) continue;

      const capable = [...state.organisms.values()].filter(
        (o) => o.alive && derivePhenotype(o.genotype).manipulationScore >= COMBINE_GATE,
      ).length;
      const record = { tick: index + 1, capable };
      if (capable > 0) capableWindows.push(record);
      if (capable > 0 && windowCombines === 0) barrenWindows.push(record);
      windowCombines = 0;
    }

    // The premise: this trajectory really does carry capable organisms, so the implication below
    // is not vacuously satisfied by a world that simply never qualifies.
    expect(capableWindows.length).toBeGreaterThan(0);
    expect(barrenWindows).toEqual([]);
  }, 900_000);
});
