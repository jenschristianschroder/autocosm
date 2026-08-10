import { describe, expect, it } from 'vitest';
import { derivePhenotype } from '@autocosm/domain';
import { observe, resourceVisibilityRadiusCu } from './observe.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import type { WorldState } from './state.js';

/**
 * An organism can only gather from a deposit it can perceive.
 *
 * `buildResourceNodes` places 14-22 deposits in a 6000x6000 cu region and its comment claimed
 * "density is tuned so a typical perception radius usually contains at least one deposit. Sparser
 * than this and material-gathering — and therefore construction — never emerges." The second
 * sentence was right about the consequence and the first was wrong about the cause. Measured at
 * 1200 ticks before this change, only 12/45 and 19/44 organisms perceived *any* deposit, and
 * 0/45 and 0/44 perceived one hard enough to build shelter from — in a world where 39 of 64
 * regions hold one and deposits run to hardness 900.
 *
 * The cause was not geometry. Median perception measured 1176 cu, which covers enough of a region
 * to hold ~2 deposits. It was *depletion*: organisms crowd, strip the deposits within reach, and
 * are then blind to the untouched stock one region over. Granting a deposit landmark range scaled
 * by what is left of it lets an organism see past the ground it has already stripped.
 *
 * Measured after, on the same seeds and worldIds:
 *
 * |                            | before      | after       |
 * | -------------------------- | ----------- | ----------- |
 * | perceiving any deposit     | 27% / 43%   | 95% / 95%   |
 * | perceiving a hard deposit  | 0% / 0%     | 39% / 23%   |
 * | best hardness visible      | 300         | 900         |
 * | regions occupied           | 9 / 7       | 17 / 23     |
 * | living organisms           | 45 / 44     | 212 / 151   |
 *
 * That unblocked the whole construction chain: shelters derived for the first time (0 -> 5 on seed
 * 4242424) and organisms attached to one for 45 organism-ticks, against 0 in 219,324 before.
 */

describe('a deposit is a landmark, scaled by what is left of it', () => {
  const PERCEPTION = 1000;

  it('is legible further away than a moving neighbour', () => {
    expect(resourceVisibilityRadiusCu(PERCEPTION, 600)).toBeGreaterThan(PERCEPTION);
  });

  it('grants a richer deposit more range, up to a cap', () => {
    const lean = resourceVisibilityRadiusCu(PERCEPTION, 200);
    const rich = resourceVisibilityRadiusCu(PERCEPTION, 500);
    expect(rich).toBeGreaterThan(lean);
    // Capped, so a deposit can never outrange the region filter that bounds observation.
    expect(resourceVisibilityRadiusCu(PERCEPTION, 10_000)).toBe(
      resourceVisibilityRadiusCu(PERCEPTION, 5_000),
    );
  });

  it('fades back into the ground as it is worked out', () => {
    // An exhausted seam is not a landmark. Without this the bonus would advertise deposits that
    // `observe` already skips for having no stock, which is the opposite of legibility.
    expect(resourceVisibilityRadiusCu(PERCEPTION, 0)).toBe(PERCEPTION);
    expect(resourceVisibilityRadiusCu(PERCEPTION, -50)).toBe(PERCEPTION);
  });
});

describe('a typical organism can find material to build with', () => {
  /**
   * Asserts the outcome the observation model exists to produce, not the code path that produces
   * it. Verified to bite: with the bonus disabled and everything else unchanged, this scores 58%
   * and 19% and fails on both seeds, so the floor is not an assertion that cannot fail.
   */
  const HORIZON = 600;

  /**
   * Budgets a 600-tick world run under suite contention, not in isolation.
   *
   * Measured: 49s and 32s when this file runs alone, but the full suite runs files in parallel
   * alongside `material-discovery.test.ts`, whose two 2400-tick worlds occupy ~15 minutes of
   * CPU. Under that load the same two runs took ~120s and ~104s, and seed 91017 tipped over the
   * previous 120s budget — an assertion failure that was really a scheduling one.
   *
   * Attributed rather than assumed: re-measured with the population-ceiling observable stashed,
   * seed 91017 took 48.6s against 51.5s with it — a 6% delta that is noise, so the behaviour
   * change is not the cause. The budget was simply set from an isolated measurement and was
   * riding at ~2.5x under the load it actually runs in.
   */
  const TIMEOUT_MS = 300_000;

  function perceivingAnyDeposit(seed: number, worldId: string): number {
    let state: WorldState = generateWorld({ seed, worldId });
    for (let index = 0; index < HORIZON; index += 1) state = advanceTick(state).state;

    let alive = 0;
    let perceiving = 0;
    for (const organism of state.organisms.values()) {
      if (organism.diedAtTick !== undefined) continue;
      alive += 1;
      const observation = observe(state, organism, derivePhenotype(organism.genotype));
      if (observation.resources.length > 0) perceiving += 1;
    }
    expect(alive).toBeGreaterThan(0);
    return Math.round((perceiving / alive) * 100);
  }

  it(
    'on seed 91017',
    () => {
      expect(perceivingAnyDeposit(91_017, 'w-deposit-a')).toBeGreaterThan(70);
    },
    TIMEOUT_MS,
  );

  it(
    'on seed 4242424',
    () => {
      expect(perceivingAnyDeposit(4_242_424, 'w-deposit-b')).toBeGreaterThan(70);
    },
    TIMEOUT_MS,
  );
});
