import { describe, expect, it } from 'vitest';
import {
  asAgentId,
  asLineageId,
  type Lineage,
  type LineageId,
  type Organism,
} from '@autocosm/domain';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import type { WorldState } from './state.js';

/**
 * Extinction must describe the world rather than outrank it.
 *
 * `extinctAtTick` was a one-way latch: set the first tick a lineage held no living organisms and
 * never cleared. That is sound while the only writer is this engine — nothing reproduces from zero
 * — but it made the record unable to disagree with itself, and the deployed world proved it can.
 *
 * Measured on production at tick 11623: `ln-hunters` carried 354 living organisms, confirmed
 * against `/api/v1/snapshot`, while its agent read `extinct`. `ln-grazers` carried 26, also
 * `extinct`. Only `ln-weavers` read `active`. `stats.livingOrganisms` was 422 — exactly
 * 352 + 26 + 44 — so the population counts agreed with each other and only the *status* was wrong.
 *
 * Two defects fell out of that, and these tests pin both.
 *
 * The stat lied. `activeLineages` counted `extinctAtTick === undefined` while `evaluateSpeciation`
 * counted `livingCount > 0`, so the world reported one lineage to a spectator while speciation
 * correctly saw three. That number is where a "lineage monoculture" reading came from, and there
 * was no monoculture.
 *
 * The damage compounded rather than sat still. The extinction branch is guarded on
 * `extinctAtTick === undefined`, so a lineage already latched can never emit `lineageExtinct`
 * again, and the real death of those 354 organisms would have passed unrecorded.
 */

const RUN_TIMEOUT_MS = 600_000;

/** Advance far enough to have a real population, births and deaths on several lineages. */
function warmWorld(seed: number, worldId: string, ticks: number): WorldState {
  let state = generateWorld({ seed, worldId });
  for (let i = 0; i < ticks; i += 1) state = advanceTick(state).state;
  return state;
}

function livingByLineage(state: WorldState): Map<string, Organism[]> {
  const byLineage = new Map<string, Organism[]>();
  for (const organism of state.organisms.values()) {
    if (!organism.alive) continue;
    const bucket = byLineage.get(organism.lineageId) ?? [];
    bucket.push(organism);
    byLineage.set(organism.lineageId, bucket);
  }
  return byLineage;
}

/** A lineage that currently has living organisms, so the corruption below is the production one. */
function populatedLineage(state: WorldState): Lineage {
  const byLineage = livingByLineage(state);
  for (const [id, living] of [...byLineage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lineage = state.lineages.get(id as LineageId);
    if (lineage && living.length > 0) return lineage;
  }
  throw new Error('no populated lineage to corrupt');
}

/**
 * Reproduce production's exact contradiction: a lineage flagged extinct that still has organisms.
 *
 * How the deployed world reached it is historical — an earlier repair — and is deliberately not
 * modelled here. What matters is that the engine must not be able to stay in the state, whatever
 * put it there.
 */
function markExtinctWhileAlive(state: WorldState, lineage: Lineage): WorldState {
  const lineages = new Map(state.lineages);
  lineages.set(lineage.id, { ...lineage, extinctAtTick: state.world.tick });
  const agents = new Map(state.agents);
  const agent = agents.get(lineage.agentId);
  if (agent) {
    agents.set(agent.id, { ...agent, status: 'extinct', extinctAtTick: state.world.tick });
  }
  return { ...state, lineages, agents };
}

/**
 * Add a lineage that has not been given a body yet.
 *
 * This is the state between `world-web` recording a spectator's agent and the tick — the only
 * authoritative writer — creating its first cell. `foundPendingLineages` waits on the agent record,
 * so withholding it holds the lineage in the window a spectator's creation genuinely passes through.
 */
function addUnfoundedLineage(state: WorldState): WorldState {
  const template = populatedLineage(state);
  const lineages = new Map(state.lineages);
  lineages.set(asLineageId('ln-unfounded'), {
    ...template,
    id: asLineageId('ln-unfounded'),
    agentId: asAgentId('ag-unfounded'),
    name: 'Unfounded',
    foundedAtTick: state.world.tick,
    generations: 0,
    births: 0,
    deaths: 0,
    livingCount: 0,
  });
  return { ...state, lineages };
}

/** Kill every living member of a lineage, which is a genuine extinction rather than a corruption. */
function killLineage(state: WorldState, lineageId: LineageId): WorldState {
  const organisms = new Map(state.organisms);
  for (const [id, organism] of organisms) {
    if (organism.lineageId !== lineageId || !organism.alive) continue;
    organisms.set(id, { ...organism, alive: false, diedAtTick: state.world.tick });
  }
  return { ...state, organisms };
}

describe('a lineage recorded extinct while its organisms still live', () => {
  it(
    'clears the record on the next tick rather than carrying the contradiction forward',
    () => {
      const warmed = warmWorld(7, 'w-extinction', 120);
      const target = populatedLineage(warmed);
      const corrupted = markExtinctWhileAlive(warmed, target);

      // The corruption is real before the tick, so this test cannot pass by never having applied it.
      expect(corrupted.lineages.get(target.id)?.extinctAtTick).toBeDefined();
      expect(corrupted.agents.get(target.agentId)?.status).toBe('extinct');

      const next = advanceTick(corrupted).state;

      expect(next.lineages.get(target.id)?.extinctAtTick).toBeUndefined();
      expect(next.lineages.get(target.id)?.livingCount).toBeGreaterThan(0);
      expect(next.agents.get(target.agentId)?.status).toBe('active');
      expect(next.agents.get(target.agentId)?.extinctAtTick).toBeUndefined();
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'is counted as active, because the organisms are the world and the flag is only a record',
    () => {
      const warmed = warmWorld(7, 'w-extinction', 120);
      const target = populatedLineage(warmed);
      const corrupted = markExtinctWhileAlive(warmed, target);

      // Production reported 1 active lineage against 3 populated ones. The stat must be derived
      // from living members, so it cannot contradict the organisms it is counting.
      const next = advanceTick(corrupted).state;
      const populated = [...next.lineages.values()].filter((l) => l.livingCount > 0).length;
      expect(populated).toBeGreaterThan(0);
      expect(next.world.stats.activeLineages).toBe(populated);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'counts a lineage awaiting its founder as neither living nor dead',
    () => {
      // The reason the two counts are not derived from each other. A lineage a spectator has just
      // created sits with no members and no death until the tick places its founder, so
      // `size - active` would have to call it either alive or dead, and it is neither. Its agent
      // is withheld here, which is the same condition `foundPendingLineages` waits on.
      const warmed = warmWorld(7, 'w-extinction', 120);
      const withPending = addUnfoundedLineage(warmed);

      const stats = advanceTick(withPending).state.world.stats;
      const total = withPending.lineages.size;
      expect(stats.activeLineages).toBeLessThan(total);
      expect(stats.extinctLineages).toBeLessThan(total);
      expect(stats.activeLineages + stats.extinctLineages).toBe(total - 1);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'can still record a later extinction, which a latched lineage never could',
    () => {
      // The forward cost of the latch, and the reason clearing it is not cosmetic. A lineage stuck
      // extinct is skipped by the extinction branch forever, so its real death emits nothing.
      const warmed = warmWorld(7, 'w-extinction', 120);
      const target = populatedLineage(warmed);

      const recovered = advanceTick(markExtinctWhileAlive(warmed, target)).state;
      expect(recovered.lineages.get(target.id)?.extinctAtTick).toBeUndefined();

      const result = advanceTick(killLineage(recovered, target.id));
      const extinctions = result.events.filter(
        (e) => e.kind === 'lineageExtinct' && e.lineageId === target.id,
      );
      expect(extinctions).toHaveLength(1);
      expect(result.state.lineages.get(target.id)?.extinctAtTick).toBeDefined();
      expect(result.state.agents.get(target.agentId)?.status).toBe('extinct');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'does not resurrect a lineage that genuinely has no members',
    () => {
      // Kill-the-mutant: deleting the extinction branch entirely would pass the tests above.
      const warmed = warmWorld(7, 'w-extinction', 120);
      const target = populatedLineage(warmed);

      const result = advanceTick(killLineage(warmed, target.id));
      expect(result.state.lineages.get(target.id)?.livingCount).toBe(0);
      expect(result.state.lineages.get(target.id)?.extinctAtTick).toBeDefined();
      expect(result.state.agents.get(target.agentId)?.status).toBe('extinct');

      // And it stays extinct across further ticks, because nothing reproduces from zero.
      const later = advanceTick(result.state).state;
      expect(later.lineages.get(target.id)?.extinctAtTick).toBeDefined();
      expect(later.agents.get(target.agentId)?.status).toBe('extinct');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'counts every lineage the same way the world does, at every tick',
    () => {
      // The two counts must agree with the organisms rather than with each other. Production's
      // `activeLineages` asked `extinctAtTick === undefined` while `evaluateSpeciation` asked
      // `livingCount > 0`, so the world told a spectator it held one lineage while speciation
      // correctly saw three. Checked every tick, because a disagreement that appears for one tick
      // is the same defect as one that persists.
      //
      // The same loop asserts the recovery branch is never needed by an ordinary world. The
      // self-heal must not be quietly papering over a live defect in this engine: if an
      // uncorrupted trajectory ever reaches the contradiction, that is a real bug and this fails.
      let state = generateWorld({ seed: 4_242_424, worldId: 'w-extinction-honest' });
      for (let i = 0; i < 400; i += 1) {
        state = advanceTick(state).state;
        const lineages = [...state.lineages.values()];
        for (const lineage of lineages) {
          if (lineage.extinctAtTick !== undefined && lineage.livingCount > 0) {
            throw new Error(
              `lineage ${lineage.id} was extinct with ${lineage.livingCount} living at tick ${state.world.tick}`,
            );
          }
        }
        expect(state.world.stats.activeLineages).toBe(
          lineages.filter((l) => l.livingCount > 0).length,
        );
        expect(state.world.stats.extinctLineages).toBe(
          lineages.filter((l) => l.extinctAtTick !== undefined).length,
        );
      }
      expect(state.world.tick).toBe(400);
    },
    RUN_TIMEOUT_MS,
  );
});
