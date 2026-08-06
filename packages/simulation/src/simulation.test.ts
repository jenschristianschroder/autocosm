import { describe, expect, it } from 'vitest';
import {
  Prng,
  TRAIT_CATALOGUE,
  TRAIT_IDS,
  WORLD_SPAN_CU,
  asMaterialId,
  derivePhenotype,
  deriveStructureFunctions,
  normaliseGenotype,
  regionIdOf,
  type MaterialDefinition,
  type MaterialId,
} from '@autocosm/domain';
import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import { MAX_MUTATION_STEP, mutateGenotype, traitHasCost } from './evolution.js';
import { generateWorld } from './worldgen.js';
import { advanceTick, type TickResult } from './tick.js';
import { sortedIds, type WorldState } from './state.js';

/**
 * These tests are the correctness gate for the whole system. Everything downstream — the
 * API, the jobs, the browser — assumes the tick engine is deterministic, bounded and
 * conserves energy through an explicit ledger.
 */

const SEED = 20_260_101;

function run(seed: number, ticks: number): { state: WorldState; results: TickResult[] } {
  let state = generateWorld({ seed, worldId: 'w-test' });
  const results: TickResult[] = [];
  for (let i = 0; i < ticks; i += 1) {
    const result = advanceTick(state);
    results.push(result);
    state = result.state;
  }
  return { state, results };
}

/** A total, order-independent fingerprint of everything that must replay identically. */
function fingerprint(state: WorldState): string {
  const parts: string[] = [
    `tick:${state.world.tick}`,
    `pressure:${state.world.pressure ?? 'none'}`,
  ];
  for (const id of sortedIds(state.organisms)) {
    const o = state.organisms.get(id);
    if (!o) continue;
    parts.push(
      [
        o.id,
        o.alive ? 1 : 0,
        o.energy,
        o.health,
        o.ageTicks,
        o.position.x,
        o.position.z,
        o.regionId,
        o.inventory.map((e) => `${e.materialId}:${e.quantity}`).join(','),
        TRAIT_IDS.map((t) => o.genotype[t]).join('.'),
      ].join('|'),
    );
  }
  for (const id of sortedIds(state.structures)) {
    const s = state.structures.get(id);
    if (!s) continue;
    parts.push(
      [
        s.id,
        s.integrity,
        s.functions.map((f) => `${f.id}=${f.magnitude}`).join('+'),
        s.usage.length,
      ].join('|'),
    );
  }
  for (const id of sortedIds(state.resources)) {
    const r = state.resources.get(id);
    if (!r) continue;
    parts.push([r.id, r.quantity].join('|'));
  }
  for (const id of sortedIds(state.regions)) {
    const r = state.regions.get(id);
    if (!r) continue;
    parts.push([r.id, r.biomass, r.mineralRichness, r.baseTemperature].join('|'));
  }
  return parts.join('\n');
}

describe('determinism', () => {
  it('produces bit-identical worlds from the same seed', () => {
    const a = generateWorld({ seed: SEED, worldId: 'w-test' });
    const b = generateWorld({ seed: SEED, worldId: 'w-test' });
    expect(fingerprint(a)).toEqual(fingerprint(b));
  });

  it('produces different worlds from different seeds', () => {
    const a = generateWorld({ seed: SEED, worldId: 'w-test' });
    const b = generateWorld({ seed: SEED + 1, worldId: 'w-test' });
    expect(fingerprint(a)).not.toEqual(fingerprint(b));
  });

  it('replays 40 ticks identically', () => {
    const first = run(SEED, 40);
    const second = run(SEED, 40);
    expect(fingerprint(first.state)).toEqual(fingerprint(second.state));
  });

  it('emits identical event identifiers on replay', () => {
    const first = run(SEED, 12);
    const second = run(SEED, 12);
    const ids = (r: TickResult[]): string[] => r.flatMap((t) => t.events.map((e) => e.id));
    expect(ids(first.results)).toEqual(ids(second.results));
    expect(new Set(ids(first.results)).size).toEqual(ids(first.results).length);
  });

  it('is idempotent: re-running a tick from the same input state gives the same output', () => {
    let state = generateWorld({ seed: SEED, worldId: 'w-test' });
    for (let i = 0; i < 7; i += 1) state = advanceTick(state).state;
    const a = advanceTick(state);
    const b = advanceTick(state);
    expect(fingerprint(a.state)).toEqual(fingerprint(b.state));
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
  });

  it('never calls Math.random', () => {
    // This test has to touch Math.random to spy on it; that is the entire point of the test.
    /* eslint-disable no-restricted-properties */
    const original = Math.random;
    let called = 0;
    Math.random = () => {
      called += 1;
      return original();
    };
    try {
      run(SEED + 7, 15);
    } finally {
      Math.random = original;
    }
    /* eslint-enable no-restricted-properties */
    expect(called).toBe(0);
  });
});

describe('energy accounting', () => {
  it('balances organism energy against the explicit inflow/outflow ledger', () => {
    let state = generateWorld({ seed: SEED, worldId: 'w-test' });
    for (let i = 0; i < 30; i += 1) {
      const before = totalEnergy(state);
      const result = advanceTick(state);
      const after = totalEnergy(result.state);
      // Σafter === Σbefore + inflow − outflow. Any energy created or destroyed without
      // being recorded in the ledger is a bug.
      expect(after).toBe(before + result.metrics.energyInflow - result.metrics.energyOutflow);
      state = result.state;
    }
  });

  it('records both inflow and outflow over a run', () => {
    const { results } = run(SEED, 25);
    const inflow = results.reduce((s, r) => s + r.metrics.energyInflow, 0);
    const outflow = results.reduce((s, r) => s + r.metrics.energyOutflow, 0);
    expect(inflow).toBeGreaterThan(0);
    expect(outflow).toBeGreaterThan(0);
  });
});

function totalEnergy(state: WorldState): number {
  let sum = 0;
  for (const organism of state.organisms.values()) {
    if (organism.alive) sum += organism.energy;
  }
  return sum;
}

describe('mutation bounds', () => {
  /**
   * Mutate every trait every generation.
   *
   * The third argument is a per-mille chance, not a config. It was previously
   * `DEFAULT_SIMULATION_CONFIG`, and `Prng.chance` truncates its argument — `Math.trunc(object)` is
   * `NaN`, and every comparison against `NaN` is false, so `chance` returned false for all 200
   * generations. The bounds guard therefore only ever checked that unmutated traits equal
   * themselves. Certainty here is deliberate: a bounds test wants maximum drift, not average drift.
   */
  const ALWAYS = 1000;

  it('keeps every trait inside [0, 1000] and within one mutation step', () => {
    const base = generateWorld({ seed: SEED, worldId: 'w-test' });
    const parent = firstOrganism(base);

    let genotype = parent.genotype;
    let mutations = 0;
    for (let generation = 0; generation < 200; generation += 1) {
      const rng = new Prng(generation * 7919 + 13);
      const next = mutateGenotype(genotype, rng, ALWAYS);
      for (const trait of TRAIT_IDS) {
        const value = next[trait];
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1000);
        expect(Number.isInteger(value)).toBe(true);
        expect(Math.abs(value - genotype[trait])).toBeLessThanOrEqual(MAX_MUTATION_STEP);
        if (value !== genotype[trait]) mutations += 1;
      }
      genotype = next;
    }
    // The control. Bounds hold trivially when nothing ever moves.
    expect(mutations).toBeGreaterThan(0);
  });

  it('is deterministic for a given PRNG seed', () => {
    const base = generateWorld({ seed: SEED, worldId: 'w-test' });
    const parent = firstOrganism(base);
    const a = mutateGenotype(parent.genotype, new Prng(99), ALWAYS);
    const b = mutateGenotype(parent.genotype, new Prng(99), ALWAYS);
    expect(a).toEqual(b);
    // Two identical no-ops are also equal, so prove the mutation actually did something.
    expect(a).not.toEqual(parent.genotype);
  });
});

function firstOrganism(state: WorldState) {
  const id = sortedIds(state.organisms)[0];
  if (id === undefined) throw new Error('seeded world has no organisms');
  const organism = state.organisms.get(id);
  if (!organism) throw new Error('seeded world has no organisms');
  return organism;
}

describe('trait tradeoffs', () => {
  it('gives every heritable trait a real cost', () => {
    expect(TRAIT_IDS.length).toBeGreaterThanOrEqual(15);
    for (const trait of TRAIT_IDS) {
      expect(traitHasCost(trait), `${trait} must have a cost`).toBe(true);
    }
  });

  it('covers every trait category, including the six the brief calls for', () => {
    const categories = new Set(TRAIT_IDS.map((id) => TRAIT_CATALOGUE[id].category));
    for (const required of [
      'cognition',
      'defence',
      'metabolism',
      'movement',
      'sensing',
      'social',
    ]) {
      expect(categories.has(required as never), `missing category ${required}`).toBe(true);
    }
  });

  it('makes maxed-out genomes more expensive than balanced ones', () => {
    const maxed = normaliseGenotype(Object.fromEntries(TRAIT_IDS.map((t) => [t, 1000])));
    const mid = normaliseGenotype(Object.fromEntries(TRAIT_IDS.map((t) => [t, 500])));
    expect(derivePhenotype(maxed).upkeepPerTick).toBeGreaterThan(
      derivePhenotype(mid).upkeepPerTick,
    );
  });

  it('does not let planning depth alone produce planning capacity', () => {
    const flat = Object.fromEntries(TRAIT_IDS.map((t) => [t, 120]));
    const baseline = normaliseGenotype(flat);
    const dumbButDeep = normaliseGenotype({ ...flat, planningDepth: 1000 });
    const supported = normaliseGenotype({
      ...flat,
      planningDepth: 1000,
      memoryCapacity: 900,
      perceptionRange: 800,
      chemoreception: 800,
      signalStrength: 700,
      energyReserve: 800,
      metabolicRate: 700,
    });
    expect(derivePhenotype(supported).effectivePlanning).toBeGreaterThan(
      derivePhenotype(dumbButDeep).effectivePlanning,
    );
    // The unsupported genome still pays for the trait it cannot use.
    expect(derivePhenotype(dumbButDeep).upkeepPerTick).toBeGreaterThan(
      derivePhenotype(baseline).upkeepPerTick,
    );
  });
});

describe('construction derivation', () => {
  const material = (
    id: string,
    props: Partial<MaterialDefinition['properties']>,
  ): MaterialDefinition => ({
    id: asMaterialId(id),
    label: id,
    origin: 'mineral',
    nutritionPerUnit: 0,
    properties: {
      hardness: 200,
      flexibility: 200,
      adhesion: 200,
      conductivity: 200,
      toxicity: 0,
      photosensitivity: 0,
      porosity: 200,
      density: 400,
      ...props,
    },
  });

  const ids = (fns: readonly { id: string }[]): string[] => fns.map((f) => f.id);

  it('derives shelter from hard, dense components', () => {
    const stone = material('stone', { hardness: 900, density: 850, porosity: 60 });
    const catalogue = new Map<MaterialId, MaterialDefinition>([[stone.id, stone]]);
    const functions = deriveStructureFunctions(
      [{ materialId: stone.id, quantity: 300 }],
      'shell',
      catalogue,
    );
    expect(ids(functions)).toContain('shelter');
  });

  it('refuses to derive a function the materials cannot support', () => {
    const foam = material('foam', { hardness: 20, density: 40, adhesion: 10, porosity: 950 });
    const catalogue = new Map<MaterialId, MaterialDefinition>([[foam.id, foam]]);
    const functions = deriveStructureFunctions(
      [{ materialId: foam.id, quantity: 300 }],
      'shell',
      catalogue,
    );
    expect(ids(functions)).not.toContain('shelter');
    expect(ids(functions)).not.toContain('barrier');
    expect(ids(functions)).not.toContain('reservoir');
  });

  it('yields nothing below the minimum structure volume', () => {
    const stone = material('stone', { hardness: 900, density: 850, porosity: 60 });
    const catalogue = new Map<MaterialId, MaterialDefinition>([[stone.id, stone]]);
    expect(
      deriveStructureFunctions([{ materialId: stone.id, quantity: 10 }], 'shell', catalogue),
    ).toEqual([]);
  });

  it('ignores unknown materials rather than trusting a claimed component', () => {
    const catalogue = new Map<MaterialId, MaterialDefinition>();
    const functions = deriveStructureFunctions(
      [{ materialId: asMaterialId('imaginary'), quantity: 999 }],
      'lattice',
      catalogue,
    );
    expect(functions).toEqual([]);
  });

  it('produces the same functions for the same components regardless of order', () => {
    const a = material('a', { hardness: 800, density: 700 });
    const b = material('b', { adhesion: 800, flexibility: 700 });
    const catalogue = new Map<MaterialId, MaterialDefinition>([
      [a.id, a],
      [b.id, b],
    ]);
    const forward = deriveStructureFunctions(
      [
        { materialId: a.id, quantity: 200 },
        { materialId: b.id, quantity: 100 },
      ],
      'lattice',
      catalogue,
    );
    const reverse = deriveStructureFunctions(
      [
        { materialId: b.id, quantity: 100 },
        { materialId: a.id, quantity: 200 },
      ],
      'lattice',
      catalogue,
    );
    expect(forward).toEqual(reverse);
  });
});

describe('world bounds', () => {
  it('keeps every organism inside the world and inside its stated region', () => {
    const { state } = run(SEED, 30);
    for (const organism of state.organisms.values()) {
      expect(organism.position.x).toBeGreaterThanOrEqual(0);
      expect(organism.position.x).toBeLessThan(WORLD_SPAN_CU);
      expect(organism.position.z).toBeGreaterThanOrEqual(0);
      expect(organism.position.z).toBeLessThan(WORLD_SPAN_CU);
      expect(Number.isInteger(organism.position.x)).toBe(true);
      expect(Number.isInteger(organism.position.z)).toBe(true);
      expect(organism.regionId).toBe(regionIdOf(organism.position));
      expect(organism.energy).toBeGreaterThanOrEqual(0);
      expect(organism.health).toBeGreaterThanOrEqual(0);
      expect(organism.health).toBeLessThanOrEqual(1000);
    }
  });

  it('bounds the events emitted in a single tick', () => {
    const { results } = run(SEED, 20);
    for (const result of results) {
      expect(result.events.length).toBeLessThanOrEqual(4000);
    }
  });

  it('bounds pending decisions per tick to the configured budget', () => {
    const { results } = run(SEED, 30);
    for (const result of results) {
      expect(result.decisions.length).toBeLessThanOrEqual(
        DEFAULT_SIMULATION_CONFIG.maxDecisionsPerTick,
      );
    }
  });
});
