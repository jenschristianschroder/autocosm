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
 * The mechanism these tests pin is not a number. It is that **the ceiling is not what limits a
 * world** — the catalogue must stay clear of the bound, and combination must not be refused,
 * whatever the chemistry happens to be doing at the moment the run ends.
 *
 * That framing has now paid for itself. The "stops strictly below the bound" assertion carries a
 * comment saying that reaching `maxMaterials` is *the signal that the headroom has been outgrown,
 * not that the test is wrong* — and the signal fired. After the deposit-visibility fix, seed
 * 4242424 sat at exactly 320, the ceiling, with discovery cut mid-flow at tick 1441. Re-measured
 * unclipped it wants 347 and converges at tick 1924. Living population and region occupancy both
 * rose sharply, so more material pairs meet and the natural fixed point moved 253 -> 347.
 * `maxMaterials` went 320 -> 576 and `HORIZON` 1200 -> 2400, both re-grounded on that measurement
 * rather than nudged until green.
 *
 * A quiet-tail assertion used to sit below — the last discovery had to leave 400 silent ticks
 * inside the horizon — and it has been **removed, because a 4000-tick measurement falsified its
 * premise rather than its constant**. It is kept in the record here because the failure mode is
 * instructive and because the instinct on a red fixture is to nudge the constant past the
 * observation.
 *
 * Three trajectories, 4000 ticks, discovery counted in 200-tick bins:
 *
 *     seed 4242424 / w-mat    last discovery 3951   312 discovered   326 materials
 *       0:28 200:48 400:35 600:50 800:47 1000:4 1200:9 1400:5 1800:7 2000:13 2200:3
 *       2800:7 3000:5 3200:17 3400:17 3600:12 3800:5
 *     seed 7 / w-mat          last discovery 1447   312 discovered   326 materials
 *       0:53 200:81 400:62 600:59 800:28 1000:15 1200:13 1400:1
 *     seed 7 / wd-probe       last discovery 3848   441 discovered   455 materials
 *       0:39 200:46 400:25 600:47 800:72 1000:1 1200:6 1400:4 1600:12 1800:26 2000:12
 *       2200:2 2600:5 2800:2 3000:4 3200:66 3400:30 3600:38 3800:4
 *
 * **Discovery here is punctuated, not convergent.** Two of the three are still inventing chemistry
 * at tick 3848 and 3951 of a 4000-tick run, and `wd-probe` posts its single largest window of the
 * entire run — 66 discoveries at tick 3200 — after roughly 800 ticks of near-silence, exceeding
 * every window in its opening thousand ticks. No affordable horizon leaves a silent tail, a longer
 * tail cannot separate dormant from converged when the dormancy is followed by the peak, and a
 * decay-rate statistic reads that dormancy as convergence and is then falsified by the burst.
 *
 * So the earlier claim in this header — "the reachable combination space closes on its own" — was
 * an artefact of horizons too short to see the second act. It held over 900-1800 ticks and does not
 * hold over 4000. The corrected claim is narrower and is what the assertions below now pin: the
 * catalogue stays well clear of the bound over runs far longer than this gate, and combination is
 * essentially never refused, so **the bound is not what limits the chemistry** — which was always
 * the property worth defending. `resolve.ts:651` refuses a novel `combine` with `actionUnavailable`
 * once the catalogue saturates, so the rejection counter below is the direct alarm for the bound
 * beginning to bind, and it is cheaper and less equivocal than any tail.
 *
 * Note what none of this establishes. Catalogue size moves in inconsistent directions between trees
 * and between trajectories (189/403/276 at 2400 ticks; 326/326/455 at 4000), which is the signature
 * of chaotic divergence rather than of a systematic effect. What is established operationally is
 * that this gate passes at the material-identity and structure-effects pair and fails at the
 * identity change alone, so the two are not independently revertible even though they shipped as
 * separate commits.
 */

/**
 * The horizon no longer has to outlast the world's chemistry, because the measurement above shows
 * nothing affordable does. Its job now is narrower: run long enough that a catalogue explosion or a
 * saturating bound would show up, and no longer.
 *
 * 2400 ticks buys catalogues of 189/403/276 against a bound of 576 — 33%, 70% and 48% of it — with
 * whole-world combine rejections in single digits. It is kept at 2400 rather than trimmed because
 * this is the length at which those figures were measured and because the widest observed spread
 * between trajectories (189 to 403) is itself the reason for the margin assertion below. It is not
 * raised, because the 4000-tick probe is now the evidence for long-run headroom and re-running it
 * every build would cost roughly 77 minutes for a number this file already records.
 *
 * This is the dominant cost in the simulation suite and that is deliberate: whether a bound binds is
 * a whole-world property with no cheap proxy.
 */
const HORIZON = 2400;
/**
 * How close to `maxMaterials` a trajectory may finish.
 *
 * "Strictly below the bound" is satisfied at 575 of 576, which would be a world one discovery from
 * silence. Measured trajectories land at 33-70% of the bound at this horizon, and the spread between
 * them is wide enough (189 to 403) that ordinary chaotic variance is the thing most likely to carry
 * a future trajectory over. 90% is therefore the point at which variance alone could cross, which
 * makes it an alarm rather than a rubber stamp.
 */
const MAX_CATALOGUE_FRACTION = 0.9;
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
    // Three trajectories, and the third exists because two were not enough. This file's alarm —
    // "discovery stops strictly below the bound" — failed to fire on a world that genuinely was
    // truncated: seed 7 under worldId `wd-probe` reached exactly 512 of a 512 bound, while the
    // same seed unclipped reaches 514. Both prior trajectories share the worldId `w-mat`, and
    // worldId moves a trajectory as much as a seed does (it is mixed into the same PRNG), so two
    // seeds against one worldId is one axis of coverage, not two. `wd-probe` is carried here
    // permanently as the trajectory that once slipped past.
    worlds.push(run(4_242_424, 'w-mat'), run(7, 'w-mat'), run(7, 'wd-probe'));
  }, TIMEOUT_MS);

  it('built every world', () => {
    // Every assertion below iterates `worlds`, so an empty array would make all four pass
    // vacuously. This file has already found four bounds that never bound and three mechanisms
    // that never fired; an assertion that cannot fail is the same defect class one level up.
    expect(worlds).toHaveLength(3);
  });

  it('discovers past the old ceiling', () => {
    for (const world of worlds) {
      expect(world.state.materials.size).toBeGreaterThan(OLD_CEILING);
    }
  });

  it('leaves the bound with room to spare, so the bound is not what limits it', () => {
    // The load-bearing assertion, and it replaces a quiet-tail assertion that a 4000-tick
    // measurement falsified — see the header. Where the tail asked "did the world stop?", this asks
    // the question the tail was only ever a proxy for: "is the world anywhere near the wall?".
    //
    // A run truncated by its ceiling finishes *at* the bound; one limited by its own chemistry
    // finishes far below it. The margin matters because "strictly below" is satisfied at 575 of
    // 576, which would be a world one discovery from silence and would read as green. If a future
    // trajectory crosses this line, that is the signal that the headroom has been outgrown, not
    // that the test is wrong.
    const ceiling = DEFAULT_SIMULATION_CONFIG.maxMaterials * MAX_CATALOGUE_FRACTION;
    for (const world of worlds) {
      expect(world.lastDiscoveryTick).toBeGreaterThan(0);
      expect(world.state.materials.size).toBeLessThanOrEqual(ceiling);
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
