import { describe, expect, it } from 'vitest';
import type { OrganismId, WorldEvent } from '@autocosm/domain';

import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';

/**
 * Gathering was the only one of the world's thirteen actions that resolved silently.
 *
 * `applyCollect` returned `ACCEPTED`, moved units from a resource node into an organism's
 * inventory, spent energy and taught the agent a material — and emitted nothing. Every other
 * action emits: move, consume, attack, share, signal, expressTrait, combine, build, attach,
 * inspect, repurpose, repair. Collection alone left no trace.
 *
 * The consequence was not cosmetic. The event log is the only record of what the world does, so a
 * spectator watching the timeline never saw an organism forage, and — worse — no measurement taken
 * over the log could see it either. A probe counting `materialCollected` reported zero across 3000
 * ticks while the same world combined 97 materials and raised 11 structures out of inventory that
 * was, on the evidence available, never gathered. The log read as a world that walks and eats and
 * does nothing else. Measured directly against organism inventory instead, carried material rose on
 * **850 of those 3000 ticks** — 28% of the world's life, entirely invisible.
 *
 * This is the same defect class as the population ceiling, `decayPerTick`, the event timeline and
 * the missing observables: a mechanism that works, is described correctly by its own comment, and
 * has never once been visible from outside. It is the fifth instance, and the first where the thing
 * hidden was an *action* rather than a bound.
 *
 * The mechanism pinned here is not the event's existence — a later refactor could rename it and
 * still satisfy that. It is that **inventory cannot grow without the world saying so**. Only two
 * actions add to an organism's inventory: `collect` takes units from a node, and `combine` yields a
 * produced material. If an organism is carrying more at the end of a tick than at the start, one of
 * those two must appear in that tick's events attributed to it. Any future action that quietly
 * grants material — or any silent regression in these two — fails here.
 */

const HORIZON = 400;
const SEEDS = [4_242_424, 91_017] as const;

interface TickSample {
  readonly tick: number;
  /** Organisms whose carried total rose, mapped to the growth in units. */
  readonly grew: ReadonlyMap<OrganismId, number>;
  /** Organisms credited with an inventory-adding event this tick. */
  readonly credited: ReadonlySet<OrganismId>;
  readonly events: readonly WorldEvent[];
}

interface Run {
  readonly seed: number;
  readonly samples: readonly TickSample[];
  readonly collected: readonly Extract<WorldEvent, { kind: 'materialCollected' }>[];
}

function carriedByOrganism(
  organisms: Iterable<{
    readonly id: OrganismId;
    readonly alive: boolean;
    readonly inventory: readonly { readonly quantity: number }[];
  }>,
): Map<OrganismId, number> {
  const carried = new Map<OrganismId, number>();
  for (const organism of organisms) {
    if (!organism.alive) continue;
    let total = 0;
    for (const entry of organism.inventory) total += entry.quantity;
    carried.set(organism.id, total);
  }
  return carried;
}

function run(seed: number): Run {
  let state = generateWorld({ seed, worldId: `w-collect-${seed}` });
  const samples: TickSample[] = [];
  const collected: Extract<WorldEvent, { kind: 'materialCollected' }>[] = [];

  let before = carriedByOrganism(state.organisms.values());
  for (let index = 0; index < HORIZON; index += 1) {
    const result = advanceTick(state);
    state = result.state;
    const after = carriedByOrganism(state.organisms.values());

    const grew = new Map<OrganismId, number>();
    for (const [id, total] of after) {
      // A newborn appears mid-tick with whatever it starts holding, and there is no
      // "before" to compare it against. Only organisms present at both ends are evidence.
      const prior = before.get(id);
      if (prior === undefined) continue;
      if (total > prior) grew.set(id, total - prior);
    }

    const credited = new Set<OrganismId>();
    for (const event of result.events) {
      if (event.kind !== 'materialCollected' && event.kind !== 'materialCombined') continue;
      if (event.organismId) credited.add(event.organismId);
      if (event.kind === 'materialCollected') collected.push(event);
    }

    samples.push({ tick: state.world.tick, grew, credited, events: result.events });
    before = after;
  }

  return { seed, samples, collected };
}

describe('gathering is visible in the world it changes', () => {
  const runs = SEEDS.map(run);

  it.each(runs.map((r) => [r.seed, r] as const))(
    'seed %i emits a collection event when material is gathered',
    (_seed, world) => {
      // The pre-fix world produced exactly zero of these across 3000 ticks while gathering on 28%
      // of them, so any non-zero count is the mechanism working rather than a threshold.
      expect(world.collected.length).toBeGreaterThan(0);
    },
  );

  it.each(runs.map((r) => [r.seed, r] as const))(
    'seed %i never grows an inventory without saying so',
    (_seed, world) => {
      const unexplained = world.samples.flatMap((sample) =>
        [...sample.grew]
          .filter(([id]) => !sample.credited.has(id))
          .map(([id, growth]) => `tick ${sample.tick}: ${id} gained ${growth} units silently`),
      );
      expect(unexplained.slice(0, 5)).toEqual([]);
    },
  );

  it.each(runs.map((r) => [r.seed, r] as const))(
    'seed %i reports a coherent payload for every collection',
    (_seed, world) => {
      const incoherent = world.collected
        .filter(
          (event) =>
            event.payload.quantity <= 0 ||
            event.payload.remaining < 0 ||
            event.payload.label.length === 0 ||
            // A raw content-addressed id in the label means the material catalogue lookup missed,
            // which is the illegibility Phase A spent five commits removing.
            event.payload.label === event.payload.materialId,
        )
        .map((event) => `${event.id}: ${JSON.stringify(event.payload)}`);
      expect(incoherent.slice(0, 5)).toEqual([]);
    },
  );

  it.each(runs.map((r) => [r.seed, r] as const))(
    'seed %i summarises a collection in words, not identifiers',
    (_seed, world) => {
      const first = world.collected[0];
      if (!first)
        throw new Error('no collection to inspect; the emit assertion should have failed');
      expect(first.summary).toContain(first.payload.label);
      expect(first.summary).toContain(String(first.payload.quantity));
    },
  );
});
