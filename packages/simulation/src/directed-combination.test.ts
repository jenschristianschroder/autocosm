import { describe, expect, it } from 'vitest';
import {
  AgentActionSchema,
  asAgentId,
  asLineageId,
  asMaterialId,
  asOrganismId,
  asRegionId,
  asWorldId,
  makePosition,
  type MaterialComponent,
  type MaterialId,
  type Observation,
  type ObservedRecipe,
} from '@autocosm/domain';
import { decideHeuristically, novelPair } from './heuristics.js';

/**
 * Directed combination — the policy reading knowledge it had only ever written.
 *
 * Until this existed, `recipes` appeared nowhere in `heuristics.ts`. Recipes were learned by
 * combining, taught by signal, recovered by inspecting a foreign construction, retained by a
 * dependency-aware eviction policy and rendered into the model prompt — and no deterministic
 * policy had ever read one back to decide anything. The combine branch took `inventory[0]` and
 * `inventory[1]` unconditionally.
 *
 * Two consequences, both measured over 600 ticks on three seeds at moments where the organism
 * could combine and knew at least one recipe:
 *
 * - the blind pair was chemistry the organism already knew in **35.6-39.6 %** of those moments, a
 *   combination that cannot discover anything, while a novel pair sat in the same inventory
 *   **96.1-98.5 %** of the time.
 *
 * What that buys is **depth, not breadth**, and judged on catalogue size alone the rule reads as
 * inert — see `novelPair`'s own comment for the paired tables. The world reaches the same number of
 * substances either way and reaches far deeper ones.
 *
 * **A second rule was written, measured and removed.** `missingIntermediate` aimed a combination at
 * a *known* procedure blocked on a composite ingredient the organism knew how to make — the only
 * deliberate route to an intermediate, since a composite is never lying on the ground. It fired on
 * 1.2-3.8 % of recipe-holding organism-ticks, and paired against the same control at 500 ticks it
 * moved neither breadth nor depth (deepest material mean delta +0.5, materials at depth >= 3 mean
 * delta +1.2, both coin flips) while *costing* 11.2 materials of breadth at tick 400 (t(5) = −4.77,
 * 6/6 seeds). Measured cost, unmeasured benefit, so it does not ship. Recorded here so the idea is
 * not re-derived from scratch: the mechanism is sound and the fire rate is the problem.
 *
 * Every fixture here is **constructed**. Whether a generated world happens to put a particular
 * organism in a particular knowledge state at a particular tick is a property of the trajectory,
 * not of the mechanism, and this suite has been bitten by that before.
 */

const WORLD_ID = asWorldId('w-directed');
const BASE_A = asMaterialId('chitin');
const BASE_B = asMaterialId('algaeMat');
const BASE_C = asMaterialId('mineralSalt');
const COMPOSITE = asMaterialId('mx-composite');

const recipe = (
  key: string,
  components: readonly MaterialComponent[],
  produces?: MaterialId,
): ObservedRecipe => ({
  key,
  label: key,
  components,
  ...(produces === undefined ? {} : { producesMaterialId: produces }),
});

const part = (materialId: MaterialId, quantity: number): MaterialComponent => ({
  materialId,
  quantity,
});

function observationOf(options: {
  readonly carried: readonly { readonly materialId: MaterialId; readonly quantity: number }[];
  readonly knownRecipes: readonly ObservedRecipe[];
}): Observation {
  return {
    version: 1,
    worldId: WORLD_ID,
    tick: 100,
    self: {
      organismId: asOrganismId('or-1'),
      agentId: asAgentId('ag-1'),
      lineageId: asLineageId('ln-1'),
      position: makePosition(0, 0),
      regionId: asRegionId('r0x0'),
      // Comfortably above the combine branch's floor of 350, and above branch 6's `< 620` so
      // opportunistic feeding cannot absorb the turn before the ladder reaches combine.
      energy: 900,
      maxEnergy: 1000,
      health: 1000,
      maxHealth: 1000,
      ageTicks: 400,
      maxAgeTicks: 1200,
      mature: true,
      reproductionReady: false,
      generation: 3,
      inventory: options.carried.map((c) => ({
        materialId: c.materialId,
        quantity: c.quantity,
        hardness: 300,
        density: 300,
        nutritionPerUnit: 0,
      })),
      carryCapacity: 240,
      inventorySlotLimit: 8,
      planning: 300,
      // Above the combine rung (220) and below the build rung (250), so the build branch above
      // cannot claim the turn and the assertion is about combine alone.
      manipulation: 230,
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
      biomass: 4000,
      pressure: 'none',
      pressureSeverity: 0,
      atPopulationCeiling: true,
      richerNeighbours: [],
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
      // Certainty, so the probabilistic gate inside the branch cannot mask the result.
      build: 1000,
    },
    temperament: 'balanced',
    aspiration: 'test',
    knownRecipes: options.knownRecipes,
    availableActions: ['move', 'consume', 'rest', 'collect', 'combine', 'inspect'],
  };
}

/** Order-independent identity of a proposal, so an assertion cannot depend on component order. */
const setOf = (components: readonly MaterialComponent[]): string =>
  components
    .map((c) => String(c.materialId))
    .sort()
    .join('|');

/**
 * The heuristic is seeded. Sampling across seeds proves the property holds for the branch rather
 * than for one lucky roll, and the non-vacuity guard fails loudly if the branch is never reached —
 * an assertion over an empty set is this project's most-repeated defect.
 */
function combinationsAcross(observation: Observation, seeds = 24): MaterialComponent[][] {
  const found: MaterialComponent[][] = [];
  for (let seed = 0; seed < seeds; seed += 1) {
    const action = decideHeuristically(observation, seed);
    if (action.type === 'combine') {
      found.push(
        action.components.map((c) => part(asMaterialId(String(c.materialId)), c.quantity)),
      );
    }
  }
  expect(
    found.length,
    'the combine branch was never reached — fixture is out of regime',
  ).toBeGreaterThan(0);
  return found;
}

describe('directed combination', () => {
  it('does not re-derive chemistry the organism already knows when an untried pair is in hand', () => {
    const observation = observationOf({
      carried: [
        { materialId: BASE_A, quantity: 60 },
        { materialId: BASE_B, quantity: 60 },
        { materialId: BASE_C, quantity: 60 },
      ],
      knownRecipes: [recipe('rx-known', [part(BASE_A, 20), part(BASE_B, 30)], COMPOSITE)],
    });

    // The blind pick is inventory[0] + inventory[1] — exactly the recipe already known.
    for (const components of combinationsAcross(observation)) {
      expect(setOf(components)).not.toBe(setOf([part(BASE_A, 1), part(BASE_B, 1)]));
    }
  });

  it('still acts when every pair it holds is already known, rather than refusing to combine', () => {
    const observation = observationOf({
      carried: [
        { materialId: BASE_A, quantity: 60 },
        { materialId: BASE_B, quantity: 60 },
      ],
      knownRecipes: [recipe('rx-known', [part(BASE_A, 20), part(BASE_B, 30)], COMPOSITE)],
    });

    expect(novelPair(observation)).toBeUndefined();
    for (const components of combinationsAcross(observation)) {
      expect(setOf(components)).toBe(setOf([part(BASE_A, 1), part(BASE_B, 1)]));
    }
  });

  it('spends half of each holding, the quantity rule the blind pick has always used', () => {
    const observation = observationOf({
      carried: [
        { materialId: BASE_A, quantity: 61 },
        { materialId: BASE_B, quantity: 60 },
        { materialId: BASE_C, quantity: 41 },
      ],
      knownRecipes: [recipe('rx-known', [part(BASE_A, 20), part(BASE_B, 30)], COMPOSITE)],
    });

    const chosen = novelPair(observation);
    expect(chosen).toBeDefined();
    // A + C: the first untried pair in inventory order.
    expect(chosen).toEqual([part(BASE_A, 30), part(BASE_C, 20)]);
    for (const components of combinationsAcross(observation)) {
      expect(components).toEqual([part(BASE_A, 30), part(BASE_C, 20)]);
    }
  });

  it('leaves an organism that knows nothing exactly as it was', () => {
    const observation = observationOf({
      carried: [
        { materialId: BASE_A, quantity: 60 },
        { materialId: BASE_B, quantity: 60 },
        { materialId: BASE_C, quantity: 60 },
      ],
      knownRecipes: [],
    });

    expect(novelPair(observation)).toBeUndefined();
    for (const components of combinationsAcross(observation)) {
      expect(setOf(components)).toBe(setOf([part(BASE_A, 1), part(BASE_B, 1)]));
    }
  });

  it('is deterministic and proposes an action the domain will accept', () => {
    const observation = observationOf({
      carried: [
        { materialId: BASE_A, quantity: 60 },
        { materialId: BASE_B, quantity: 60 },
        { materialId: BASE_C, quantity: 60 },
      ],
      knownRecipes: [recipe('rx-known', [part(BASE_A, 20), part(BASE_B, 30)], COMPOSITE)],
    });

    expect(novelPair(observation)).toEqual(novelPair(observation));

    for (const components of combinationsAcross(observation)) {
      const parsed = AgentActionSchema.safeParse({ type: 'combine', components });
      expect(parsed.success, JSON.stringify(components)).toBe(true);
    }
  });
});
