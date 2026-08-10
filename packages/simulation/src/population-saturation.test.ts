import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import { observe } from './observe.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import type { SimulationConfig } from './config.js';
import type { WorldState } from './state.js';

/**
 * A small ceiling so the world saturates quickly. The defect is proportional to the ceiling,
 * not absolute: any world that fills exhibits it, and 60 organisms fill within ~95 ticks
 * instead of the ~2500 the production ceiling of 420 needs.
 */
const CONFIG: SimulationConfig = {
  ...DEFAULT_SIMULATION_CONFIG,
  maxOrganisms: 60,
  maxDeadOrganismsRetained: 24,
};

const TICKS = 320;
const TIMEOUT_MS = 180_000;

interface Run {
  readonly state: WorldState;
  /** Ticks on which the world was at its ceiling. */
  readonly saturatedTicks: number;
  readonly reproduceRejections: number;
  /** Collections that happened *while saturated* — the turns that used to be thrown away. */
  readonly collectedWhileSaturated: number;
  readonly builtWhileSaturated: number;
}

function run(seed: number): Run {
  let state = generateWorld({ seed, worldId: 'wd-saturation' });
  let saturatedTicks = 0;
  let reproduceRejections = 0;
  let collectedWhileSaturated = 0;
  let builtWhileSaturated = 0;

  for (let index = 0; index < TICKS; index += 1) {
    const result = advanceTick(state, { config: CONFIG });
    state = result.state;

    let living = 0;
    for (const organism of state.organisms.values()) if (organism.alive) living += 1;
    const saturated = living >= CONFIG.maxOrganisms;
    if (saturated) saturatedTicks += 1;

    for (const event of result.events) {
      if (event.kind === 'actionRejected' && event.payload.actionType === 'reproduce') {
        reproduceRejections += 1;
      } else if (saturated && event.kind === 'materialCollected') {
        collectedWhileSaturated += 1;
      } else if (saturated && event.kind === 'structureBuilt') {
        builtWhileSaturated += 1;
      }
    }
  }

  return {
    state,
    saturatedTicks,
    reproduceRejections,
    collectedWhileSaturated,
    builtWhileSaturated,
  };
}

/**
 * A full world must not cost its organisms their turn.
 *
 * `reproduce()` has three gates — maturity, the refractory period, and room in the world.
 * `ObservedSelf.mature` and `ObservedSelf.reproductionReady` mirrored the first two; nothing
 * mirrored the third. A healthy organism past its cooldown therefore proposed a birth the
 * simulation was certain to refuse, and because `decide()` returns on its first matching
 * branch that refusal cost the organism its *entire* turn: it never reached feed, gather,
 * build, combine, teach or explore.
 *
 * Measured over 1500 ticks with the fix stashed, on three seeds: 23,847 / 30,094 / 22,652
 * doomed reproduce proposals — 95-100% of every rejection in the world. Production showed the
 * same signature at scale: 421 living organisms against a ceiling of 420, zero structures, and
 * no gather, build or combine anywhere in a 200-event window.
 *
 * Attribution was established by running the identical probe with the change stashed. Freeing
 * those turns raised collections 1,875 -> 4,466, 1,107 -> 1,442 and 3,044 -> 3,554, standing
 * structures 21 -> 43 and 2 -> 4, and discovered materials 480 -> 512 and 334 -> 378, while
 * reproduce rejections went to zero on every seed.
 *
 * The assertions below pin the *mechanism* rather than any of those counts, which are
 * trajectory numbers and would be fixtures if asserted.
 */
describe('population saturation', () => {
  let measured: Run;

  // In `beforeAll`, not at describe scope. Work placed at describe scope runs during vitest's
  // *collection* phase, where no test timeout applies — the declared budget would guard the
  // assertions and leave the ~40s world run unguarded.
  beforeAll(() => {
    measured = run(4242424);
  }, TIMEOUT_MS);

  it('reaches its ceiling, so the assertions below are not vacuous', () => {
    expect(measured.saturatedTicks).toBeGreaterThan(TICKS / 2);
  });

  it('never proposes a reproduction the full world will refuse', () => {
    // The discriminating assertion. Verified against the defect: with the fix stashed this
    // reads 3,814 over the same 320 ticks.
    expect(measured.reproduceRejections).toBe(0);
  });

  /**
   * A regression guard, not evidence of the fix — stated plainly because an assertion that
   * cannot fail on the defect it names is the exact fragility this suite keeps finding.
   *
   * It passes on the defective build too: at this small ceiling some organisms are below the
   * energy or health threshold of the reproduce branch and fall through to gather anyway. What
   * the fix changed is the *volume*, which is a trajectory number and would be a fixture if
   * asserted. It is recorded here instead: over 1500 ticks on three seeds, collections rose
   * 1,875 -> 4,466, 1,107 -> 1,442 and 3,044 -> 3,554, with standing structures 21 -> 43,
   * 2 -> 4 and 21 -> 18.
   *
   * What this does catch is a future change that stops a full world doing any work at all.
   */
  it('still gathers and builds while the world is full', () => {
    expect(measured.collectedWhileSaturated).toBeGreaterThan(0);
    expect(measured.builtWhileSaturated).toBeGreaterThan(0);
  });

  it('reports the ceiling through the observation, not just to the resolver', () => {
    const living = [...measured.state.organisms.values()].filter((o) => o.alive);
    expect(living.length).toBeGreaterThan(0);

    const first = living[0];
    if (!first) throw new Error('no living organism');
    expect(observe(measured.state, first, undefined, CONFIG).environment.atPopulationCeiling).toBe(
      true,
    );

    // The same world observed against a ceiling it is nowhere near must report false, so the
    // flag tracks the rule rather than being pinned true by something else.
    const roomy: SimulationConfig = { ...CONFIG, maxOrganisms: CONFIG.maxOrganisms * 100 };
    expect(observe(measured.state, first, undefined, roomy).environment.atPopulationCeiling).toBe(
      false,
    );
  });
});
