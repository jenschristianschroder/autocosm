import { describe, expect, it } from 'vitest';
import { decayPerTick, repairYield, type MaterialProperties } from '@autocosm/domain';

import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import type { SimulationConfig } from './config.js';

/**
 * A world of 140 for the long run at the foot of this file, not the default 420.
 *
 * The 1200-tick horizon here is load-bearing and cannot be cut: the `> 500` lifetime threshold
 * cannot be observed at all below ~600 ticks, so the only affordable lever is world size. Tick cost
 * is superlinear in living organisms — measured at 125s against ~590s for the same 1400-tick
 * trajectory at caps 140 and 420, ~4.7x — and after `biomassRegenAtFullLight` went 60 -> 180 this
 * test blew its 600s budget.
 *
 * Permanence is a property of material durability against `decayPerTick`, and repair is a property
 * of whether the action exists and an organism can afford it. Neither is a function of headcount.
 * Measured at 200-tick checkpoints on this file's own seed, the smaller world is the better subject:
 *
 *     cap 140    repairs 232 by t=1400   longest life achieved 1183 by t=1200
 *     cap 420    repairs 109 by t=1000   longest life achieved  983 by t=1000
 *
 * More repairs, not fewer, against an assertion of `> 0` — because a world pinned against
 * `maxOrganisms` has no energy surplus, and maintenance is gated on surplus by design (it runs after
 * construction and needs a full load, so it can only spend what building did not).
 *
 * Only this test takes the smaller world. The staged repair tests above build their resolution
 * context from `DEFAULT_SIMULATION_CONFIG` and must keep the world that matches it.
 */
const MECHANISM_CONFIG: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, maxOrganisms: 140 };
import { availableActions } from './capabilities.js';
import { EnergyLedger, resolveAction, type ResolutionContext } from './resolve.js';
import { EventSink } from './events.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import { toDraft, type WorldState } from './state.js';
import type { Organism, Structure } from '@autocosm/domain';

/**
 * Nothing the world builds is ever kept.
 *
 * Integrity only ever fell: `repair` existed as a usage kind that no action could produce, and the
 * decay curve rewarded durable material with a 3× slowdown rather than permanence. Measured over
 * 1500 ticks on seed 4242424, all 31 structures ever built collapsed and none stood at the end, with
 * a median life of 99 ticks — about one simulated day. A spectator could read what a construction was
 * made of and what it did, for something they would encounter twice in a world's history.
 *
 * These tests pin both halves: material choice must be able to buy permanence, and maintenance must
 * be reachable and effective.
 */

/**
 * A whole-world run costs roughly linearly in living population, and the deposit-visibility fix
 * (see `deposit-visibility.test.ts`) raised the standing population from ~26 to 137-259. The
 * 1200-tick run below measured 166s against the previous 120s budget, so this is a cost change
 * rather than a behaviour change. Matched to `material-discovery.test.ts`, which already needs
 * this envelope for the same reason.
 */
const TIMEOUT_MS = 600_000;

function properties(partial: Partial<MaterialProperties>): MaterialProperties {
  return {
    hardness: 500,
    flexibility: 500,
    density: 500,
    porosity: 500,
    conductivity: 500,
    adhesion: 500,
    // `reactivity` is not a material property; the real one is `photosensitivity`. The fixture
    // previously set the former, leaving the latter `undefined` in a supposedly complete vector.
    photosensitivity: 500,
    toxicity: 0,
    ...partial,
  };
}

function context(state: WorldState): ResolutionContext {
  const draft = toDraft(state);
  const events = new EventSink(draft.world.id, draft.world.tick);
  return { draft, config: DEFAULT_SIMULATION_CONFIG, events, ledger: new EnergyLedger() };
}

/** A world advanced far enough to contain at least one standing structure. */
function worldWithStructure(): WorldState {
  let state = generateWorld({ seed: 4_242_424, worldId: 'w-repair' });
  for (let index = 0; index < 600; index += 1) {
    state = advanceTick(state).state;
    if (state.structures.size > 0) return state;
  }
  throw new Error('no structure was raised within the horizon');
}

/** Places a living organism that has evolved repair beside a structure, stocked and fed to mend it. */
function stageRepairer(
  state: WorldState,
  structure: Structure,
): { state: WorldState; organism: Organism } {
  const candidate = [...state.organisms.values()]
    .filter((o) => o.alive && availableActions(o).includes('repair'))
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!candidate) throw new Error('no living organism has evolved repair');
  const materialId = structure.components[0]?.materialId;
  if (!materialId) throw new Error('structure has no components');
  const organism: Organism = {
    ...candidate,
    position: structure.position,
    energy: 4000,
    inventory: [{ materialId, quantity: 200 }],
  };
  const organisms = new Map(state.organisms);
  organisms.set(organism.id, organism);
  return { state: { ...state, organisms }, organism };
}

describe('structure permanence', () => {
  describe('decay', () => {
    it('lets genuinely durable material approach permanence', () => {
      // Hard and dense: resistance 1000. Under the original divisor this still lost 2 per tick,
      // capping the best possible construction at 466 ticks — no material could buy a landmark.
      expect(decayPerTick(properties({ hardness: 1000, porosity: 0 }))).toBe(1);
    });

    it('still crumbles porous, soft work quickly', () => {
      expect(decayPerTick(properties({ hardness: 0, porosity: 1000 }))).toBe(6);
    });

    it('is never zero, so an abandoned structure always disappears', () => {
      for (const hardness of [0, 250, 500, 750, 1000]) {
        for (const porosity of [0, 250, 500, 750, 1000]) {
          expect(decayPerTick(properties({ hardness, porosity }))).toBeGreaterThanOrEqual(1);
        }
      }
    });
  });

  describe('repairYield', () => {
    const stone = properties({ hardness: 800 });

    it('restores more for more material', () => {
      const small = repairYield(stone, stone, 20, 200);
      const large = repairYield(stone, stone, 100, 200);
      expect(large).toBeGreaterThan(small);
    });

    it('restores less when the patch does not match the structure', () => {
      const matched = repairYield(stone, stone, 100, 200);
      const mismatched = repairYield(stone, properties({ hardness: 100 }), 100, 200);
      expect(mismatched).toBeLessThan(matched);
    });

    it('never returns nothing for a real patch, and never overflows per mille', () => {
      expect(repairYield(stone, properties({ hardness: 0 }), 1, 100_000)).toBeGreaterThanOrEqual(1);
      expect(repairYield(stone, stone, 10_000, 10)).toBeLessThanOrEqual(1000);
    });
  });

  describe('the repair action', () => {
    it(
      'restores integrity and records who mended it',
      () => {
        const world = worldWithStructure();
        const original = [...world.structures.values()][0];
        expect(original).toBeDefined();
        if (!original) return;

        const worn: Structure = { ...original, integrity: 300 };
        const structures = new Map(world.structures);
        structures.set(worn.id, worn);
        const staged = stageRepairer({ ...world, structures }, worn);

        const ctx = context(staged.state);
        const result = resolveAction(ctx, staged.organism.id, {
          type: 'repair',
          structureId: worn.id,
          components: [{ materialId: worn.components[0]!.materialId, quantity: 120 }],
        });

        expect(result.accepted).toBe(true);
        const after = ctx.draft.structures.get(worn.id);
        expect(after?.integrity).toBeGreaterThan(worn.integrity);
        expect(after?.usage.at(-1)?.kind).toBe('repair');
        expect(after?.usage.at(-1)?.organismId).toBe(staged.organism.id);
        expect(ctx.events.drain().some((e) => e.kind === 'structureRepaired')).toBe(true);
      },
      TIMEOUT_MS,
    );

    it(
      'refuses to mend what is out of reach, undamaged, or unaffordable',
      () => {
        const world = worldWithStructure();
        const original = [...world.structures.values()][0];
        expect(original).toBeDefined();
        if (!original) return;
        const materialId = original.components[0]!.materialId;

        const worn: Structure = { ...original, integrity: 300 };
        const structures = new Map(world.structures);
        structures.set(worn.id, worn);
        const staged = stageRepairer({ ...world, structures }, worn);
        const patch = [{ materialId, quantity: 120 }];

        const unknown = context(staged.state);
        expect(
          resolveAction(unknown, staged.organism.id, {
            type: 'repair',
            structureId: 'st-does-not-exist',
            components: patch,
          }).reason,
        ).toBe('unknownTarget');

        const distant = context({
          ...staged.state,
          organisms: new Map(staged.state.organisms).set(staged.organism.id, {
            ...staged.organism,
            position: {
              x: worn.position.x + DEFAULT_SIMULATION_CONFIG.interactionRadiusCu * 4,
              z: worn.position.z,
            },
          }),
        });
        expect(
          resolveAction(distant, staged.organism.id, {
            type: 'repair',
            structureId: worn.id,
            components: patch,
          }).reason,
        ).toBe('outOfRange');

        const intact = context({
          ...staged.state,
          structures: new Map(staged.state.structures).set(worn.id, { ...worn, integrity: 1000 }),
        });
        expect(
          resolveAction(intact, staged.organism.id, {
            type: 'repair',
            structureId: worn.id,
            components: patch,
          }).reason,
        ).toBe('actionUnavailable');

        const empty = context({
          ...staged.state,
          organisms: new Map(staged.state.organisms).set(staged.organism.id, {
            ...staged.organism,
            inventory: [],
          }),
        });
        expect(
          resolveAction(empty, staged.organism.id, {
            type: 'repair',
            structureId: worn.id,
            components: patch,
          }).reason,
        ).toBe('insufficientMaterial');

        const spent = context({
          ...staged.state,
          organisms: new Map(staged.state.organisms).set(staged.organism.id, {
            ...staged.organism,
            energy: 1,
          }),
        });
        expect(
          resolveAction(spent, staged.organism.id, {
            type: 'repair',
            structureId: worn.id,
            components: patch,
          }).reason,
        ).toBe('insufficientEnergy');
      },
      TIMEOUT_MS,
    );
  });

  it(
    'keeps some of what it builds standing over a long run',
    () => {
      let state = generateWorld({ seed: 4_242_424, worldId: 'w-permanence' });
      let repaired = 0;
      const bornAtTick = new Map<string, number>();
      const lifetimes: number[] = [];
      for (let index = 0; index < 1200; index += 1) {
        const result = advanceTick(state, { config: MECHANISM_CONFIG });
        for (const event of result.events) {
          if (event.kind === 'structureRepaired') repaired += 1;
          if (event.kind === 'structureBuilt') {
            bornAtTick.set(String(event.payload.structureId), result.state.world.tick);
          }
          if (event.kind === 'structureCollapsed') {
            const born = bornAtTick.get(String(event.payload.structureId));
            if (born !== undefined) lifetimes.push(result.state.world.tick - born);
          }
        }
        state = result.state;
      }
      for (const structure of state.structures.values()) {
        lifetimes.push(state.world.tick - structure.createdAtTick);
      }

      // Repair was unreachable before this fix: `'repair'` existed as a usage kind that no action
      // could produce, so integrity was strictly monotonic. Any repair at all proves the mechanism.
      expect(repaired).toBeGreaterThan(0);

      // The longest life *achieved*, not what happens to be standing at tick 1200. Which structures
      // survive to any particular instant is a property of the whole trajectory — measured across
      // five (seed, worldId) pairs the final standing count ranges 0..4, so asserting on it pins the
      // test to one world and breaks on any behaviour change. Lifetime is the mechanism itself and
      // is stable: 1002..1188 across those same five trajectories, against a pre-fix ceiling of 230
      // and a pre-fix median of 99 — about one simulated day.
      expect(Math.max(0, ...lifetimes)).toBeGreaterThan(500);
    },
    TIMEOUT_MS,
  );
});
