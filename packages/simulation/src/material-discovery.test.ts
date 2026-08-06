import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@autocosm/domain';

import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import type { WorldState } from './state.js';

/**
 * A world stops inventing chemistry at tick 182 and never invents another material again.
 *
 * `maxMaterials` was 96, and nothing removes a material — discovery is one-way — so the bound was
 * cumulative rather than concurrent. Once a world had discovered that many, every subsequent
 * `combine` was refused for the rest of its life: roughly 85% of a 1200-tick run. This is the exact
 * shape of the population ceiling fixed in `06cfa35`, where `reproduce()` counted dead organisms
 * against `maxOrganisms`.
 *
 * Eviction is not the answer, and measurement is why. Run with the ceiling lifted to 100_000,
 * discovery converges by tick ~900 and then stays flat — 133/161/188/189/201/253 materials across
 * six trajectories, unchanged for another 600 ticks. The reachable combination space closes on its
 * own, so the bound only ever needed headroom above that. Evicting instead would have cost the
 * historical record its legibility: events carry `materialId`, and a pruned material renders as a
 * raw id everywhere it is referenced.
 *
 * The mechanism these tests pin is not a number. It is that **the ceiling is not what stops a
 * world** — discovery must end strictly below the bound, having exhausted what it could reach.
 */

const HORIZON = 1200;
const TIMEOUT_MS = 600_000;

/** The bound before the fix. Every measured trajectory settles well above it. */
const OLD_CEILING = 96;

interface Run {
  readonly state: WorldState;
  readonly events: readonly WorldEvent[];
  readonly lastDiscoveryTick: number;
}

function run(seed: number, worldId: string): Run {
  let state = generateWorld({ seed, worldId });
  const events: WorldEvent[] = [];
  let lastDiscoveryTick = 0;
  for (let index = 0; index < HORIZON; index += 1) {
    const result = advanceTick(state);
    state = result.state;
    for (const event of result.events) {
      if (event.kind === 'materialDiscovered') lastDiscoveryTick = state.world.tick;
    }
    events.push(...result.events);
  }
  return { state, events, lastDiscoveryTick };
}

describe('material discovery is bounded by chemistry, not by a counter', () => {
  const worlds = [run(4_242_424, 'w-mat'), run(7, 'w-mat')];

  it(
    'discovers past the old ceiling',
    () => {
      for (const world of worlds) {
        expect(world.state.materials.size).toBeGreaterThan(OLD_CEILING);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'stops strictly below the bound, so the bound is not what stopped it',
    () => {
      // The load-bearing assertion. A world truncated by its ceiling sits *exactly* at it; a world
      // that exhausted its reachable combinations sits below it with room to spare. If a future
      // trajectory ever reaches `maxMaterials`, this fails — which is the signal that the headroom
      // has been outgrown, not that the test is wrong.
      for (const world of worlds) {
        expect(world.state.materials.size).toBeLessThan(DEFAULT_SIMULATION_CONFIG.maxMaterials);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'goes quiet on its own well before the horizon',
    () => {
      // Corroborates the assertion above from the other direction: discovery tails off and stays
      // off while the world keeps running, rather than being cut mid-flow.
      for (const world of worlds) {
        expect(world.lastDiscoveryTick).toBeGreaterThan(0);
        expect(world.lastDiscoveryTick).toBeLessThan(HORIZON);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'repeats a combination it already knows instead of refusing it',
    () => {
      // Material ids are content-addressed, so repeating a combination resolves to an id the world
      // already holds and cannot grow the catalogue. The cap was tested *before* that was known, so
      // even a repeat was refused once the catalogue filled.
      for (const world of worlds) {
        const combined = world.events.filter((e) => e.kind === 'materialCombined').length;
        const discovered = world.events.filter((e) => e.kind === 'materialDiscovered').length;
        expect(combined).toBeGreaterThan(discovered);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'almost never refuses a combination at all',
    () => {
      // Measured over 1200 ticks: whole-world rejection counts of 0/0/4 across three trajectories,
      // against 214/118/548 with the ceiling at 96.
      for (const world of worlds) {
        const refused = world.events.filter(
          (e) => e.kind === 'actionRejected' && e.payload.actionType === 'combine',
        ).length;
        expect(refused).toBeLessThan(10);
      }
    },
    TIMEOUT_MS,
  );
});
