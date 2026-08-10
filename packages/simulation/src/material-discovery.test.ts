import { beforeAll, describe, expect, it } from 'vitest';

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
 *
 * That framing has now paid for itself. The "stops strictly below the bound" assertion carries a
 * comment saying that reaching `maxMaterials` is *the signal that the headroom has been outgrown,
 * not that the test is wrong* — and the signal fired. After the deposit-visibility fix, seed
 * 4242424 sat at exactly 320, the ceiling, with discovery cut mid-flow at tick 1441. Re-measured
 * unclipped it wants 347 and converges at tick 1924. Living population and region occupancy both
 * rose sharply, so more material pairs meet and the natural fixed point moved 253 -> 347.
 * `maxMaterials` went 320 -> 512 and `HORIZON` 1200 -> 2400, both re-grounded on that measurement
 * rather than nudged until green.
 */

/**
 * The horizon has to outlast the world's own chemistry, or "goes quiet" is untestable.
 *
 * Measured with the ceiling lifted to 100 000, three trajectories over 3000 ticks: the last
 * discovery lands at tick 702 / 832 / **1924**, and nothing is discovered afterwards. 1200 was
 * enough when the last discovery landed at 644/750/737; the deposit-visibility fix raised living
 * population 26 -> 137-259 and region occupancy 9 -> 17-23, so far more material pairs come into
 * contact and exhaustion now takes roughly 2.6x as long. 2400 leaves a silent tail of at least
 * 400 ticks on the slowest measured trajectory.
 *
 * This is the dominant cost in the simulation suite and that is deliberate: convergence is a
 * whole-world property and there is no cheap proxy for it. A shorter horizon does not make the
 * test faster, it makes it wrong — at 1200 ticks seed 4242424 is still discovering at close to
 * peak rate, so a decay assertion there would read noise.
 */
const HORIZON = 2400;
/** The silent tail the slowest trajectory must still leave inside `HORIZON`. */
const QUIET_TAIL_TICKS = 400;
const TIMEOUT_MS = 1_800_000;

/** The two bounds this has already outgrown. Every measured trajectory settles above both. */
const OLD_CEILING = 96;

interface Run {
  readonly state: WorldState;
  readonly lastDiscoveryTick: number;
  readonly combined: number;
  readonly discovered: number;
  readonly combineRejections: number;
}

/**
 * Counted, not collected.
 *
 * A 2400-tick world emits well over a hundred thousand events and this file runs two of them. The
 * assertions below need five scalars, so retaining every event was an unbounded allocation buying
 * nothing — and "bounded" is a rule this simulation applies to itself everywhere else.
 */
function run(seed: number, worldId: string): Run {
  let state = generateWorld({ seed, worldId });
  let lastDiscoveryTick = 0;
  let combined = 0;
  let discovered = 0;
  let combineRejections = 0;

  for (let index = 0; index < HORIZON; index += 1) {
    const result = advanceTick(state);
    state = result.state;
    for (const event of result.events) {
      if (event.kind === 'materialDiscovered') {
        discovered += 1;
        lastDiscoveryTick = state.world.tick;
      } else if (event.kind === 'materialCombined') {
        combined += 1;
      } else if (event.kind === 'actionRejected' && event.payload.actionType === 'combine') {
        combineRejections += 1;
      }
    }
  }
  return { state, lastDiscoveryTick, combined, discovered, combineRejections };
}

describe('material discovery is bounded by chemistry, not by a counter', () => {
  /**
   * Built in `beforeAll`, not at describe scope.
   *
   * At describe scope this work runs during collection, where no test timeout applies — the
   * generous `TIMEOUT_MS` on each assertion below would have been guarding roughly 70ms of counting
   * while the 15 minutes that actually costs something ran unguarded. A world that stopped
   * advancing would have hung collection rather than failing a test.
   */
  const worlds: Run[] = [];

  beforeAll(() => {
    worlds.push(run(4_242_424, 'w-mat'), run(7, 'w-mat'));
  }, TIMEOUT_MS);

  it('built both worlds', () => {
    // Every assertion below iterates `worlds`, so an empty array would make all four pass
    // vacuously. This file has already found four bounds that never bound and three mechanisms
    // that never fired; an assertion that cannot fail is the same defect class one level up.
    expect(worlds).toHaveLength(2);
  });

  it('discovers past the old ceiling', () => {
    for (const world of worlds) {
      expect(world.state.materials.size).toBeGreaterThan(OLD_CEILING);
    }
  });

  it('stops strictly below the bound, so the bound is not what stopped it', () => {
    // The load-bearing assertion. A world truncated by its ceiling sits *exactly* at it; a world
    // that exhausted its reachable combinations sits below it with room to spare. If a future
    // trajectory ever reaches `maxMaterials`, this fails — which is the signal that the headroom
    // has been outgrown, not that the test is wrong.
    for (const world of worlds) {
      expect(world.state.materials.size).toBeLessThan(DEFAULT_SIMULATION_CONFIG.maxMaterials);
    }
  });

  it('goes quiet on its own, leaving a silent tail inside the run', () => {
    // Corroborates the assertion above from the other direction: discovery tails off and stays
    // off while the world keeps running, rather than being cut mid-flow. Asserting a *silent
    // tail* rather than `lastDiscoveryTick < HORIZON` is the difference between "the run happened
    // to end after the last discovery" and "the world demonstrably stopped and stayed stopped".
    //
    // The tail is why the full horizon is run rather than stopping as soon as a world falls quiet.
    // Early stopping would be much cheaper and would hide the one outcome worth catching: a world
    // that goes quiet, then resumes.
    for (const world of worlds) {
      expect(world.lastDiscoveryTick).toBeGreaterThan(0);
      expect(world.lastDiscoveryTick).toBeLessThanOrEqual(HORIZON - QUIET_TAIL_TICKS);
    }
  });

  it('repeats a combination it already knows instead of refusing it', () => {
    // Material ids are content-addressed, so repeating a combination resolves to an id the world
    // already holds and cannot grow the catalogue. The cap was tested *before* that was known, so
    // even a repeat was refused once the catalogue filled.
    for (const world of worlds) {
      expect(world.combined).toBeGreaterThan(world.discovered);
    }
  });

  it('almost never refuses a combination at all', () => {
    // Measured over 1200 ticks: whole-world rejection counts of 0/0/4 across three trajectories,
    // against 214/118/548 with the ceiling at 96.
    for (const world of worlds) {
      expect(world.combineRejections).toBeLessThan(10);
    }
  });
});
