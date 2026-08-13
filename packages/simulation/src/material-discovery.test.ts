import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SIMULATION_CONFIG, type SimulationConfig } from './config.js';
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
 *
 * **Re-measured after `biomassRegenAtFullLight` went 60 -> 180, and the punctuated-not-convergent
 * finding is now much stronger than the 4000-tick probe could show.** Three trajectories run to
 * 2400 ticks with the cap lifted to 100_000, catalogue logged every 200 ticks:
 *
 *     tick    4242424/w-mat      7/w-mat        7/wd-probe
 *     800     303 (+105)         280 (+70)      425 (+171)
 *     1200    664 (+175)         523 (+111)     849 (+204)
 *     1600    986 (+151)         766 (+118)     1153 (+117)
 *     2000    1251 (+152)        885 (+119)     1217 (+64)
 *     2200    1386 (+135)        -              -
 *
 * Growth decelerates and never stops — still +135 per 200 ticks at tick 2200. With supply no longer
 * the binding constraint, a world invents roughly 4-5x the chemistry it used to over the same span,
 * and the "reachable combination space closes on its own" claim in this header is now falsified
 * twice over rather than once. `maxMaterials` was raised 576 -> 8192 on this measurement, and the
 * comment on that constant records that it is a bound which will bind eventually, not a ceiling
 * above an asymptote — there is no asymptote to sit above.
 */

/**
 * The horizon no longer has to outlast the world's chemistry, because the measurement above shows
 * nothing affordable does. Its job now is narrower: run long enough that a catalogue explosion or a
 * saturating bound would show up, and no longer.
 *
 * **Cut 2400 -> 900 when `biomassRegenAtFullLight` went 60 -> 180, and this is a cost change, not a
 * weakening.** Tick cost scales with living organisms, and the supply fix takes a world from ~148
 * to a pinned 420 — roughly 2.8x per tick. Left at 2400 this gate would have gone from ~15 minutes
 * of CI to ~42, against a 40-minute `verify` cap: the gate would have failed the build by timing
 * out rather than by finding anything. 2400/2.8 ~ 860, so 900 restores its previous cost almost
 * exactly.
 *
 * It explores *more* chemistry than the old horizon did, measured on these same three trajectories
 * at regen 180 with the cap lifted to 100_000:
 *
 *     tick 800    303 / 280 / 425 materials
 *     tick 1000   489 / 412 / 645
 *
 * against 189 / 403 / 276 at tick 2400 under regen 60. Every trajectory at 900 ticks now reaches at
 * or above where it used to finish, so the shorter horizon is a strictly larger sample of the
 * material space. Discovery is ~5x faster per tick, which is the whole point of the supply fix.
 *
 * **The 2.8x in that estimate was wrong, and this file is where it showed.** Cost was measured, not
 * derived, after the horizon cut: identical probes at `maxOrganisms` 140 and 420 over the same
 * trajectory cost 125s and ~590s, so the real multiplier is **~4.7x**, not 2.8x. Cost is superlinear
 * in population — 3x the organisms costs ~4.7x the time — because per-tick work includes pairwise
 * neighbour scans. At 900 ticks and three trajectories this file's `beforeAll` blew a 30-minute hook
 * timeout and took 33.5 minutes, which by itself set the wall-clock of the entire 33.7-minute suite.
 * The horizon was not the remaining lever; the world size was. See `MECHANISM_CONFIG` below.
 */
const HORIZON = 900;
/**
 * A world of 140, not the default 420 — and this is a cost change that leaves the assertions
 * strictly better supplied, which is not what a shortcut looks like.
 *
 * Tick cost scales superlinearly with living organisms (measured: 125s at 140 against ~590s at 420
 * for 1400 ticks, ~4.7x). What this file guards is not a population-scale property. It guards that
 * **the catalogue bound is not what limits the chemistry** — a claim about the relationship between
 * discovery and `maxMaterials`, which does not become true or false because a world holds three
 * times as many organisms.
 *
 * The measurement says the smaller world is the *stronger* subject here, which is worth stating
 * plainly because the expectation runs the other way. Probed at 200-tick checkpoints on seed
 * 4242424, materials known:
 *
 *     tick        200   400   600   800   1000  1200  1400
 *     cap 140      42   248   400   442    512   561   612
 *     cap 420      36   115   237   330    469     -     -
 *
 * A smaller world discovers **more** chemistry, not less, and does it sooner. That is not a
 * curiosity — it is this repository's `x-creative-ladder-priced-out` finding reproduced in a
 * fixture: a world pinned against `maxOrganisms` has no energy surplus, and every rung of the
 * creative ladder is gated on surplus. So running this gate at the default cap would test discovery
 * in the regime where discovery is *suppressed*, at 4.7x the price.
 *
 * What is deliberately given up: this file no longer observes the at-capacity regime. That regime is
 * covered on purpose and cheaply elsewhere — `population-saturation.test.ts` runs at
 * `maxOrganisms: 60` and asserts the world genuinely reaches its ceiling before asserting anything
 * about behaviour there, and `population.test.ts` pins its own scarcity. Neither depends on the
 * default cap, so nothing that guarded carrying capacity has been traded away here.
 */
const MECHANISM_CONFIG: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, maxOrganisms: 140 };
/**
 * How close to `maxMaterials` a trajectory may finish.
 *
 * "Strictly below the bound" is satisfied at 8191 of 8192, which would be a world one discovery
 * from silence. 90% is the point at which ordinary chaotic variance could carry a trajectory over,
 * which makes it an alarm rather than a rubber stamp.
 *
 * **Honest note on how much this now guards.** It was a sharp alarm when the bound was 576 and
 * trajectories landed at 33-70% of it. `maxMaterials` has since risen to 8192 — because measurement
 * showed discovery never converges, so no bound can sit above an asymptote — while the horizon fell
 * to 900. Trajectories now land near 4-8% of the bound, so this assertion will not fire on ordinary
 * drift; it fires only on a catalogue explosion. The direct alarm for the bound beginning to bind
 * is now the combine-rejection assertion at the foot of this file, which is triggered by the first
 * refusal rather than by a fraction. Both are kept: this one bounds the catalogue, that one detects
 * saturation, and they fail for different reasons.
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
    const result = advanceTick(state, { config: MECHANISM_CONFIG });
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
