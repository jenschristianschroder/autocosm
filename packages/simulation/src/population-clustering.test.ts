import { describe, expect, it } from 'vitest';
import {
  asAgentId,
  asLineageId,
  asOrganismId,
  asRegionId,
  asWorldId,
  makePosition,
  regionCentre,
  regionCoordFromId,
  type Observation,
  type ObservedNeighbourRegion,
} from '@autocosm/domain';
import { decideHeuristically } from './heuristics.js';
import { observe } from './observe.js';
import { generateWorld } from './worldgen.js';
import type { WorldState } from './state.js';

/*
 * An organism could perceive that the ground underfoot was bare, and could not perceive that the
 * ground next door was not.
 *
 * Measured in production at tick 15,208: 319 organisms standing in `r2x6` on 193 mu of biomass,
 * 44 in `r4x7`, and all 23 other regions in a radius-2 window empty and pinned at the 6000 mu
 * cap. That is why the preceding release raised `biomassRegenAtFullLight` 60 -> 180 and moved
 * nothing at all — it raised supply in regions that were already at their ceiling. The world was
 * not short of food; it was short of food where anybody was standing.
 *
 * Two halves are needed and neither works alone: `ObservedEnvironment.richerNeighbours`, so the
 * gradient exists at all, and a heuristic branch that walks up it.
 *
 * These tests pin the mechanism and deliberately stop there. An end-to-end occupancy test was
 * written and then deleted, because measuring it honestly showed it could not tell the two arms
 * apart: across six paired seeds, on two different fixtures, a control with the migration branch
 * disabled dispersed just as widely (regions occupied at tick 300: control 2/1/4/3/4/5 against
 * treatment 2/3/5/3/4/5; organisms away from home 54/0/34/2/17/55 against 54/2/18/3/17/48). A
 * generated world already disperses through blind jitter plus reproduction at the frontier, and
 * that swamps the directed effect. What is *not* in doubt is that the branch now runs at all:
 * before the shadowing bug in `nearestFeeding` was fixed, three successive versions of this code
 * produced byte-identical trajectories.
 *
 * That null result was later shown to be **regime-bound rather than wrong**, and the deleted test
 * is still correctly deleted. Those fixtures cap the population, and at a cap the effect vanishes
 * by construction: at `maxOrganisms: 140` over 600 ticks both arms hold 119.1/118.7/118.9 living
 * organisms, identical to the decimal. Given headroom it separates cleanly — three seeds over 400
 * ticks at the default cap put mean regions occupied at 13.79/14.30/14.56 -> 15.12/15.54/15.60 and
 * mean living population at 206.0/222.7/197.7 -> 218.4/231.2/215.0, every seed the same way, paired
 * t(2) of 14.07 and 5.00 against a critical 4.30.
 *
 * That measurement is not asserted here and should not be: one arm of it is ~17 minutes across
 * three seeds, which is a probe, not a unit test. It is recorded in the branch comment in
 * `heuristics.ts` next to the code it describes.
 *
 * Production's clustering took ~15,000 ticks to form and no affordable fixture reproduces it, so
 * the benefit *there* is still unproven and must not be claimed. The correctness fix — a gate that
 * no policy could reach, and an observable that did not exist — stands on its own.
 */

const WORLD_ID = asWorldId('w-cluster');
const REGION_ID = asRegionId('r3x3');
const ORGANISM_ID = asOrganismId('or-migrant');
const AGENT_ID = asAgentId('ag-migrant');
const LINEAGE_ID = asLineageId('ln-migrant');

function neighbour(id: string, biomass: number, from: { x: number; z: number }) {
  const coord = regionCoordFromId(id);
  if (!coord) throw new Error(`bad region id ${id}`);
  const centre = regionCentre(coord);
  return {
    regionId: asRegionId(id),
    biomass,
    centre,
    distanceCu: Math.hypot(centre.x - from.x, centre.z - from.z),
  } satisfies ObservedNeighbourRegion;
}

function observationOf(options: {
  readonly energyRatio: number;
  readonly biomass: number;
  readonly richerNeighbours: readonly ObservedNeighbourRegion[];
  readonly position?: { x: number; z: number };
}): Observation {
  const maxEnergy = 1000;
  const position = options.position ?? { x: 20_000, z: 20_000 };
  return {
    version: 1,
    worldId: WORLD_ID,
    tick: 100,
    self: {
      organismId: ORGANISM_ID,
      agentId: AGENT_ID,
      lineageId: LINEAGE_ID,
      position: makePosition(position.x, position.z),
      regionId: REGION_ID,
      energy: Math.trunc((maxEnergy * options.energyRatio) / 1000),
      maxEnergy,
      health: 1000,
      maxHealth: 1000,
      ageTicks: 400,
      maxAgeTicks: 1200,
      mature: true,
      // Quiet the reproduce branch without depending on the population ceiling.
      reproductionReady: false,
      generation: 3,
      inventory: [],
      carryCapacity: 240,
      inventorySlotLimit: 8,
      planning: 300,
      manipulation: 100,
      memorySlots: 4,
      speedCuPerTick: 120,
      moveCostPer100Cu: 4,
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
      richerNeighbours: options.richerNeighbours,
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
      build: 500,
    },
    temperament: 'balanced',
    aspiration: 'test',
    knownRecipes: [],
    availableActions: ['move', 'consume', 'rest'],
  };
}

/** Every action kind this observation can produce, across many rolls of the dice. */
function decisionsAcross(observation: Observation, seeds: number): Set<string> {
  const kinds = new Set<string>();
  for (let seed = 0; seed < seeds; seed += 1) {
    kinds.add(decideHeuristically(observation, seed).type);
  }
  return kinds;
}

describe('following the food out of a stripped region', () => {
  it('a hungry organism on bare ground walks toward a richer neighbour', () => {
    const observation = observationOf({
      energyRatio: 300,
      biomass: 0,
      richerNeighbours: [neighbour('r3x2', 6000, { x: 20_000, z: 20_000 })],
    });
    // Deterministic across every roll: this branch takes no chance, because a starving organism
    // that fails a dice roll spends the turn resting on ground it has already eaten.
    expect(decisionsAcross(observation, 24)).toEqual(new Set(['move']));
  });

  it('it aims at the neighbour it can reach cheapest, not the one holding most', () => {
    const from = { x: 20_000, z: 20_000 };
    const near = neighbour('r3x2', 400, from);
    const far = neighbour('r1x1', 6000, from);
    expect(far.distanceCu).toBeGreaterThan(near.distanceCu);

    const action = decideHeuristically(
      observationOf({ energyRatio: 300, biomass: 0, richerNeighbours: [far, near] }),
      1,
    );
    if (action.type !== 'move') throw new Error(`expected a move, got ${action.type}`);
    // Every reported neighbour has already cleared the same ratio and floor, so the difference
    // between them is only what the crossing costs — and the hungry organism has the least to
    // spend on it.
    expect(action.target).toEqual({ x: near.centre.x, z: near.centre.z });
  });

  it('it eats what is underfoot rather than travelling to eat', () => {
    const observation = observationOf({
      energyRatio: 300,
      biomass: 4000,
      richerNeighbours: [neighbour('r3x2', 8000, { x: 20_000, z: 20_000 })],
    });
    // A neighbour twice as rich is still not worth a crossing while there is food where you
    // stand. Branch 6 must win, and it does because it returns first.
    expect(decisionsAcross(observation, 24)).toEqual(new Set(['consume']));
  });

  it('a well-fed organism on bare ground does not abandon its turn to travel', () => {
    const kinds = decisionsAcross(
      observationOf({
        energyRatio: 900,
        biomass: 0,
        richerNeighbours: [neighbour('r3x2', 6000, { x: 20_000, z: 20_000 })],
      }),
      24,
    );
    // Migration is a hunger response. Above the feeding line the organism has better things to
    // do with a turn, and this branch must not be able to preempt them.
    expect(kinds).not.toEqual(new Set(['move']));
  });

  it('an organism too spent to take a step proposes nothing it cannot pay for', () => {
    const observation = observationOf({
      energyRatio: 0,
      biomass: 0,
      richerNeighbours: [neighbour('r3x2', 6000, { x: 20_000, z: 20_000 })],
    });
    expect(decisionsAcross(observation, 8).has('move')).toBe(false);
  });
});

describe('the gradient an organism can perceive', () => {
  /** A world where one region is stripped bare and its neighbours are full. */
  function strippedWorld(): WorldState {
    const state = generateWorld({ seed: 4242424, worldId: WORLD_ID });
    const regions = new Map(state.regions);
    for (const [id, region] of regions) {
      regions.set(id, { ...region, biomass: id === REGION_ID ? 0 : 6000 });
    }
    return { ...state, regions };
  }

  function anOrganismIn(state: WorldState, regionId: string) {
    const coord = regionCoordFromId(regionId);
    if (!coord) throw new Error(`bad region id ${regionId}`);
    const centre = regionCentre(coord);
    for (const organism of state.organisms.values()) {
      if (!organism.alive) continue;
      return { ...organism, position: centre, regionId: asRegionId(regionId) };
    }
    throw new Error('the generated world has no living organism');
  }

  it('reports the eight full neighbours of a stripped region', () => {
    const state = strippedWorld();
    const seen = observe(state, anOrganismIn(state, REGION_ID)).environment;
    expect(seen.biomass).toBe(0);
    expect(seen.richerNeighbours).toHaveLength(8);
    expect(seen.richerNeighbours.map((n) => n.regionId)).not.toContain(REGION_ID);
    // Richest first, so truncation — if it is ever needed — keeps the best options.
    const biomasses = seen.richerNeighbours.map((n) => n.biomass);
    expect([...biomasses].sort((a, b) => b - a)).toEqual(biomasses);
  });

  it('reports nothing when every region holds the same', () => {
    const state = generateWorld({ seed: 4242424, worldId: WORLD_ID });
    const regions = new Map(state.regions);
    for (const [id, region] of regions) regions.set(id, { ...region, biomass: 6000 });
    const level = { ...state, regions };
    // A well-spread world pays nothing for this observable: no entries in the observation, no
    // tokens in the prompt.
    expect(observe(level, anOrganismIn(level, REGION_ID)).environment.richerNeighbours).toEqual([]);
  });

  it('reports nothing for a neighbour holding too little to be worth the crossing', () => {
    const state = generateWorld({ seed: 4242424, worldId: WORLD_ID });
    const regions = new Map(state.regions);
    // 1 mu is infinitely richer than 0 mu by ratio alone, and worth nothing on arrival. The
    // absolute floor is what stops a bare world advertising itself.
    for (const [id, region] of regions)
      regions.set(id, { ...region, biomass: id === REGION_ID ? 0 : 1 });
    const bare = { ...state, regions };
    expect(observe(bare, anOrganismIn(bare, REGION_ID)).environment.richerNeighbours).toEqual([]);
  });
});
