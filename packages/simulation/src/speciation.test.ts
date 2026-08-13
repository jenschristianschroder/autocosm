import { describe, expect, it } from 'vitest';
import {
  asLineageId,
  TRAIT_IDS,
  type Genotype,
  type Lineage,
  type LineageId,
  type TraitId,
} from '@autocosm/domain';
import {
  countActiveLineages,
  dominantDivergentTrait,
  evaluateSpeciation,
  genotypeDivergence,
  splinterName,
} from './speciation.js';
import { DEFAULT_SIMULATION_CONFIG, type SimulationConfig } from './config.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import type { WorldState } from './state.js';

/**
 * A lineage must be able to divide.
 *
 * Before this mechanism existed, `reproduce` copied the parent's `lineageId` onto every child and
 * a lineage was constructed in only two places — worldgen, and a spectator authoring an agent.
 * Measured over 3000 ticks on three seeds, not one lineage was ever created after worldgen and
 * every world decayed monotonically from 8 lineages towards 1. These tests pin the mechanism that
 * opposes that ratchet.
 */

/**
 * The three whole-world tests below each advance 800-1000 ticks. Cost tracks living population,
 * and the deposit-visibility fix raised that from ~26 to 137-259, taking the ceiling test from
 * comfortably inside 120s to 163s. Raised with headroom for a loaded CI runner; the assertions
 * themselves are unchanged.
 */
const WORLD_RUN_TIMEOUT_MS = 600_000;

function flat(value: number): Genotype {
  const genotype: Partial<Record<TraitId, number>> = {};
  for (const id of TRAIT_IDS) genotype[id] = value;
  return genotype as Genotype;
}

function shift(base: Genotype, changes: Partial<Record<TraitId, number>>): Genotype {
  return { ...base, ...changes };
}

function lineage(overrides: Partial<Lineage> = {}): Lineage {
  const genotype = flat(500);
  return {
    id: asLineageId('ln-test'),
    worldId: 'w-test' as Lineage['worldId'],
    agentId: 'ag-test' as Lineage['agentId'],
    name: 'Weavers',
    foundedAtTick: 0,
    originRegionId: 'rg-0-0' as Lineage['originRegionId'],
    generations: 1,
    births: 10,
    deaths: 0,
    livingCount: 10,
    meanGenotype: genotype,
    foundingGenotype: genotype,
    ...overrides,
  };
}

describe('genotypeDivergence', () => {
  it('is zero for identical genomes and symmetric otherwise', () => {
    const a = flat(500);
    const b = shift(a, { armor: 900, motility: 100 });
    expect(genotypeDivergence(a, a)).toBe(0);
    expect(genotypeDivergence(a, b)).toBe(genotypeDivergence(b, a));
  });

  it('averages across the genome rather than summing it', () => {
    // Two traits differ by 400 each. Averaged over 24 traits that is 800/24 = 33, so a threshold
    // keeps meaning the same thing if the genome ever gains or loses a trait.
    const a = flat(500);
    const b = shift(a, { armor: 900, motility: 900 });
    expect(genotypeDivergence(a, b)).toBe(Math.round(800 / TRAIT_IDS.length));
  });
});

describe('dominantDivergentTrait', () => {
  it('picks the trait that drifted furthest', () => {
    const reference = flat(500);
    const child = shift(reference, { armor: 700, planningDepth: 900 });
    expect(dominantDivergentTrait(child, reference)).toBe('planningDepth');
  });

  it('breaks ties by TRAIT_IDS order so replays agree', () => {
    const reference = flat(500);
    const child = shift(reference, { armor: 900, motility: 900 });
    const first = TRAIT_IDS.indexOf('motility') < TRAIT_IDS.indexOf('armor') ? 'motility' : 'armor';
    expect(dominantDivergentTrait(child, reference)).toBe(first);
  });
});

describe('splinterName', () => {
  it('keeps the parent stem so names stay bounded down a deep tree', () => {
    expect(splinterName('Weavers', 'armor')).toBe('Plated Weavers');
    // The parent already carries an epithet; the splinter replaces it rather than stacking.
    expect(splinterName('Plated Weavers', 'chemoreception')).toBe('Keen Weavers');
  });

  it('bounds the result even for an absurd parent name', () => {
    expect(splinterName('x'.repeat(200), 'armor').length).toBeLessThanOrEqual(64);
  });
});

describe('countActiveLineages', () => {
  it('counts the living, not the ever-created', () => {
    // The population ceiling's exact defect: a cumulative count here would permanently stop a
    // world diversifying once this many lineages had ever existed.
    const lineages = new Map<LineageId, Lineage>([
      [asLineageId('ln-a'), lineage({ id: asLineageId('ln-a'), livingCount: 3 })],
      [asLineageId('ln-b'), lineage({ id: asLineageId('ln-b'), livingCount: 0, extinctAtTick: 9 })],
      [asLineageId('ln-c'), lineage({ id: asLineageId('ln-c'), livingCount: 1 })],
    ]);
    expect(countActiveLineages(lineages)).toBe(2);
  });
});

describe('evaluateSpeciation', () => {
  const base = {
    activeLineages: 4,
    maxActiveLineages: DEFAULT_SIMULATION_CONFIG.maxActiveLineages,
    divergenceThreshold: DEFAULT_SIMULATION_CONFIG.speciationDivergence,
    minParentPopulation: DEFAULT_SIMULATION_CONFIG.speciationMinParentPopulation,
  };

  it('splits when the child has drifted past the threshold', () => {
    const parent = lineage();
    const child = shift(parent.foundingGenotype, { armor: 1000, motility: 0, longevity: 1000 });
    const verdict = evaluateSpeciation({ childGenotype: child, parentLineage: parent, ...base });
    expect(verdict.splits).toBe(true);
  });

  it('measures drift from the founding genome, never the running mean', () => {
    // This is the whole mechanism. The mean tracks the living population and therefore chases it,
    // so a newborn sits a flat ~10 from it however long the world has run (median 9, max 27 over
    // ~3000 births). A threshold measured against the mean is unreachable at every point in the
    // trait space. Here the mean has followed the child exactly while the founding genome has not.
    const founding = flat(500);
    const drifted = shift(founding, { armor: 1000, motility: 0, longevity: 1000 });
    const parent = lineage({ foundingGenotype: founding, meanGenotype: drifted });
    const verdict = evaluateSpeciation({
      childGenotype: drifted,
      parentLineage: parent,
      ...base,
    });
    expect(genotypeDivergence(drifted, parent.meanGenotype)).toBe(0);
    expect(verdict.splits).toBe(true);
  });

  it('refuses when the child is still recognisably its parent kind', () => {
    const parent = lineage();
    const child = shift(parent.foundingGenotype, { armor: 540 });
    expect(
      evaluateSpeciation({ childGenotype: child, parentLineage: parent, ...base }).splits,
    ).toBe(false);
  });

  it('refuses to bud from a collapsing lineage', () => {
    // A dying lineage would otherwise shed splinters that inherit its predicament.
    const parent = lineage({ livingCount: base.minParentPopulation - 1 });
    const child = shift(parent.foundingGenotype, { armor: 1000, motility: 0, longevity: 1000 });
    expect(
      evaluateSpeciation({ childGenotype: child, parentLineage: parent, ...base }).splits,
    ).toBe(false);
  });

  it('refuses once the world already carries its ceiling of active lineages', () => {
    // Every lineage competes for the same fixed `maxDecisionsPerTick`, so an unbounded split rate
    // would starve them all of cognition rather than enrich the world.
    const parent = lineage();
    const child = shift(parent.foundingGenotype, { armor: 1000, motility: 0, longevity: 1000 });
    const verdict = evaluateSpeciation({
      childGenotype: child,
      parentLineage: parent,
      ...base,
      activeLineages: base.maxActiveLineages,
    });
    expect(verdict.splits).toBe(false);
  });

  it('reports the divergence and trait it split on', () => {
    const parent = lineage();
    // planningDepth moves furthest, so no tie-break is involved and this asserts selection.
    const child = shift(parent.foundingGenotype, { planningDepth: 1000, armor: 300 });
    const verdict = evaluateSpeciation({
      childGenotype: child,
      parentLineage: parent,
      ...base,
      divergenceThreshold: 1,
    });
    expect(verdict).toStrictEqual({
      splits: true,
      divergence: genotypeDivergence(child, parent.foundingGenotype),
      trait: 'planningDepth',
    });
  });
});

/**
 * Speciation has a warm-up, and these tests construct past it rather than waiting it out.
 *
 * Divergence from a fixed founding genome accumulates at roughly 40 per 2000–3000 ticks, so a
 * freshly generated world cannot split for most of its first two thousand ticks. Measured on
 * `w-speciation`: seed 7 produced its first splinter at tick 1705, seed 91017 at tick 1984 — both
 * past a horizon a unit test can afford, and both sensitive to the exact trajectory, which is the
 * fragility that re-baselined `recipe identity` and `structure permanence` before.
 *
 * So these run a real world long enough to have a real population and culture, then displace each
 * lineage's founding genome so the *next* birth is over threshold. That tests the mechanism rather
 * than the rate. The rate is a balance question, measured by probe: over 3000 ticks against a
 * control of 0 on every seed, treatment produced 5 / 22 / 30 splinters and raised mean active
 * lineages 3.89→3.98, 4.19→4.44 and 4.58→5.79 without moving population or construction.
 */
function displaceFoundingGenomes(state: WorldState): WorldState {
  const lineages = new Map(state.lineages);
  for (const [id, existing] of lineages) {
    lineages.set(id, { ...existing, foundingGenotype: flat(0) });
  }
  return { ...state, lineages };
}

/**
 * A world of 140 for the three whole-world runs below, not the default 420.
 *
 * Tick cost is superlinear in living organisms — measured at 125s against ~590s for the same
 * 1400-tick trajectory at caps 140 and 420, ~4.7x — and after `biomassRegenAtFullLight` went
 * 60 -> 180 two of the three tests here blew the 600s budget while the third took 478s of it.
 *
 * Speciation is a property of genotype distance against a threshold, evaluated per birth. Whether a
 * splinter is far enough from its parent to found a lineage does not depend on how many organisms
 * the world holds; the headcount only changes how many births are sampled per tick. The third test
 * is the one that genuinely consumes births — it must drive the active-lineage count all the way to
 * its ceiling — and it is the reason this constant is stated once here rather than per test: if a
 * smaller world ever fails to saturate that ceiling, the fix is that test's window, not a silent
 * relaxation of `toBe` to `toBeLessThanOrEqual`.
 */
const MECHANISM_CONFIG: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, maxOrganisms: 140 };

function runUntilSplit(
  state: WorldState,
  maxTicks: number,
): { state: WorldState; founded: number } {
  let current = state;
  let founded = 0;
  for (let i = 0; i < maxTicks && founded === 0; i += 1) {
    const result = advanceTick(current, { config: MECHANISM_CONFIG });
    current = result.state;
    founded += result.events.filter((e) => e.kind === 'lineageFounded').length;
  }
  return { state: current, founded };
}

describe('a running world', () => {
  /**
   * The control this mechanism exists to overturn: measured over 3000 ticks on seeds
   * 4242424 / 91017 / 7 before it existed, not one lineage was ever created after worldgen and
   * every world decayed monotonically from 8 lineages towards 1.
   */
  it(
    'can create a lineage that worldgen did not',
    () => {
      let state = generateWorld({ seed: 7, worldId: 'w-speciation' });
      const founding = new Set(state.lineages.keys());
      for (let i = 0; i < 600; i += 1)
        state = advanceTick(state, { config: MECHANISM_CONFIG }).state;

      const outcome = runUntilSplit(displaceFoundingGenomes(state), 200);
      expect(outcome.founded).toBeGreaterThan(0);

      const created = [...outcome.state.lineages.keys()].filter((id) => !founding.has(id));
      expect(created.length).toBe(outcome.founded);
    },
    WORLD_RUN_TIMEOUT_MS,
  );

  it(
    'gives every splinter its own agent and a copy of its parent culture',
    () => {
      let state = generateWorld({ seed: 7, worldId: 'w-speciation' });
      const founding = new Set(state.lineages.keys());
      for (let i = 0; i < 600; i += 1)
        state = advanceTick(state, { config: MECHANISM_CONFIG }).state;

      const outcome = runUntilSplit(displaceFoundingGenomes(state), 200);
      const created = [...outcome.state.lineages.values()].filter((l) => !founding.has(l.id));
      expect(created.length).toBeGreaterThan(0);

      for (const splinter of created) {
        // Its own agent, not its parent's. A shared agent would leave the two lineages permanently
        // identical culturally, so there would be nothing to learn across the boundary.
        const agent = outcome.state.agents.get(splinter.agentId);
        expect(agent).toBeDefined();
        expect(agent?.lineageId).toBe(splinter.id);

        // Its drift clock starts at its own genome, so it cannot immediately split again on
        // distance it inherited. Every founding lineage here was displaced to flat zero, so a
        // splinter carrying that same displaced genome would mean it inherited its parent's clock.
        expect(splinter.foundingGenotype).toBeDefined();
        expect(genotypeDivergence(splinter.foundingGenotype, flat(0))).toBeGreaterThan(0);
      }

      // No two lineages share an agent.
      const agentIds = [...outcome.state.lineages.values()].map((l) => l.agentId);
      expect(new Set(agentIds).size).toBe(agentIds.length);
    },
    WORLD_RUN_TIMEOUT_MS,
  );

  it(
    'never exceeds the active-lineage ceiling under sustained splitting pressure',
    () => {
      let state = generateWorld({ seed: 91017, worldId: 'w-speciation' });
      for (let i = 0; i < 600; i += 1)
        state = advanceTick(state, { config: MECHANISM_CONFIG }).state;

      // Every birth from here is over threshold, so the ceiling is the only thing holding the
      // count down. Without it this run would found a lineage per birth.
      state = displaceFoundingGenomes(state);
      let peak = 0;
      let founded = 0;
      for (let i = 0; i < 400; i += 1) {
        const result = advanceTick(state, { config: MECHANISM_CONFIG });
        state = result.state;
        founded += result.events.filter((e) => e.kind === 'lineageFounded').length;
        peak = Math.max(peak, countActiveLineages(state.lineages));
      }
      expect(founded).toBeGreaterThan(0);
      // Not merely "at or under the ceiling" — that would pass even if the ceiling never bound and
      // the count sat at its founding value. Sustained pressure must actually reach it, so the
      // assertion proves the ceiling is what stopped the growth.
      expect(peak).toBe(DEFAULT_SIMULATION_CONFIG.maxActiveLineages);
    },
    WORLD_RUN_TIMEOUT_MS,
  );
});
