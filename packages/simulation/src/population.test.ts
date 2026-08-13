import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import type { SimulationConfig } from './config.js';
import type { WorldState } from './state.js';

/**
 * A deliberately small, deliberately hungry world. Both overrides construct the subject rather
 * than hoping a default trajectory supplies one.
 *
 * `maxOrganisms` — the defect is proportional to the ceiling, not absolute: a world sterilises
 * itself once `maxOrganisms` organisms have ever been born. Shrinking the ceiling brings that
 * moment forward from tick ~457 to within a short run, so the regression is provable in seconds
 * rather than minutes.
 *
 * `biomassRegenAtFullLight` — pinned to the value this fixture was calibrated against, because
 * two of the assertions below need *corpses* and the world default no longer produces them.
 * Raising the default 60 -> 180 (the supply fix that let production build anything at all) feeds
 * a 100-organism world so well that nothing starves: measured on this exact fixture, `totalDeaths`
 * over 300 ticks fell to **1**, against the 24 retained corpses pruning is supposed to bound. The
 * pruner was never at fault — the premise was. Pruning is a function of how many corpses exist,
 * not of what killed them, so restoring the scarcity keeps the mechanism under test and keeps the
 * run at 300 ticks instead of the thousands that reaching 24 deaths would now cost.
 *
 * Deliberately pinned here rather than inherited: a fixture that needs a specific pressure should
 * say so, not silently re-tune whenever a world-balance constant moves.
 */
const CONFIG: SimulationConfig = {
  ...DEFAULT_SIMULATION_CONFIG,
  maxOrganisms: 100,
  maxDeadOrganismsRetained: 24,
  biomassRegenAtFullLight: 60,
};

const TICKS = 300;
/** Two full runs, so this one is kept shorter; determinism diverges early if it diverges at all. */
const REPLAY_TICKS = 150;
const TIMEOUT_MS = 60_000;

function run(seed: number, ticks: number): WorldState {
  let state = generateWorld({ seed, worldId: 'wd-population' });
  for (let index = 0; index < ticks; index += 1) {
    state = advanceTick(state, { config: CONFIG }).state;
  }
  return state;
}

function livingCount(state: WorldState): number {
  return [...state.organisms.values()].filter((organism) => organism.alive).length;
}

/**
 * The population ceiling counts the living.
 *
 * `maxOrganisms` was once compared against `organisms.size`, which also holds corpses. That
 * turned a population ceiling into a lifetime birth quota: a world stopped reproducing for good
 * once that many organisms had ever existed, then decayed to extinction. The deployed world ran
 * sterile for thousands of ticks before anyone noticed, because nothing reports it.
 */
describe('population ceiling', () => {
  /**
   * Three of the assertions below read different properties of the *same* deterministic world, and
   * each used to build it from scratch: three identical 300-tick runs at ~13s apiece in isolation,
   * and ~55s apiece under full-suite contention, where this file has timed out twice. The world is
   * only read, never mutated, so building it once is not a shortcut — the duplication was the
   * defect. Measured solo, and the second figure while another core was saturated: 60.2s before,
   * 42.9s after.
   */
  let shared: WorldState;

  beforeAll(() => {
    shared = run(4242424, TICKS);
  }, TIMEOUT_MS);

  it(
    'keeps reproducing after the cumulative birth count passes the ceiling',
    () => {
      expect(shared.world.stats.totalBirths).toBeGreaterThan(CONFIG.maxOrganisms);
      expect(livingCount(shared)).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'is still a ceiling: the living population never exceeds it',
    () => {
      let state = generateWorld({ seed: 91017, worldId: 'wd-population' });
      for (let index = 0; index < TICKS; index += 1) {
        state = advanceTick(state, { config: CONFIG }).state;
        expect(livingCount(state)).toBeLessThanOrEqual(CONFIG.maxOrganisms);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'bounds retained corpses so the world record cannot grow without limit',
    () => {
      const dead = [...shared.organisms.values()].filter((organism) => !organism.alive);

      expect(dead.length).toBeLessThanOrEqual(CONFIG.maxDeadOrganismsRetained);
      // Many more have died than are retained, so pruning demonstrably ran.
      expect(shared.world.stats.totalDeaths).toBeGreaterThan(CONFIG.maxDeadOrganismsRetained);
    },
    TIMEOUT_MS,
  );

  it(
    'keeps ancestry for organisms whose records were pruned',
    () => {
      expect(shared.lineageNodes.size).toBeGreaterThan(shared.organisms.size);
      for (const node of shared.lineageNodes.values()) {
        if (node.diedAtTick === undefined) continue;
        expect(node.causeOfDeath).toBeDefined();
      }
    },
    TIMEOUT_MS,
  );

  it(
    'prunes identically for the same history',
    () => {
      const left = run(91017, REPLAY_TICKS);
      const right = run(91017, REPLAY_TICKS);

      expect([...left.organisms.keys()].sort()).toEqual([...right.organisms.keys()].sort());
    },
    TIMEOUT_MS,
  );
});
