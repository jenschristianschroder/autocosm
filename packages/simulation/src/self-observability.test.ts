import { describe, expect, it } from 'vitest';
import type { AgentActionType, RejectionReason, WorldEvent } from '@autocosm/domain';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import type { WorldState } from './state.js';

/**
 * An organism can only act on what it can perceive.
 *
 * Three behaviours the simulation documents were unimplementable by *any* policy — heuristic or
 * model — because the observation model never carried the signal they need:
 *
 * | Behaviour            | Observable it needs      | What it had           |
 * | -------------------- | ------------------------ | --------------------- |
 * | "feed a starving kin"| the recipient's hunger   | `healthBand` (injury) |
 * | reproduce when ready | its own refractory state | nothing               |
 * | move somewhere       | its own step cost        | nothing               |
 *
 * `decide()` returns on the first matching branch, so a proposal that resolution is *guaranteed* to
 * reject costs the organism its entire turn — it never reaches gather, share, teach, forage or
 * explore. Measured on the previous code over 1500 ticks, `reproduce/onCooldown` alone was over half
 * of every rejection in the world (3156 of 6175 on seed 4242424; 3581 of 6656 on 91017).
 *
 * With the observables present these three rejections are unreachable by construction, which is what
 * these tests pin. They assert on the world's own rejection stream rather than on a staged organism,
 * because the defect was never in the resolver — it was in what the policy could see.
 */

const HORIZON = 600;

interface Run {
  readonly state: WorldState;
  readonly events: readonly WorldEvent[];
}

function run(seed: number, worldId: string): Run {
  let state = generateWorld({ seed, worldId });
  const events: WorldEvent[] = [];
  for (let index = 0; index < HORIZON; index += 1) {
    const result = advanceTick(state);
    events.push(...result.events);
    state = result.state;
  }
  return { state, events };
}

/**
 * `<action>/<reason>` as the simulation itself spells them.
 *
 * Typed against the domain unions rather than plain `string`, so a renamed action or reason — or a
 * mistyped lookup below — is a compile error. The first version of this file harvested
 * `payload.action`; the field is `payload.actionType`, so every key was `undefined/<reason>` and the
 * three "never rejects" assertions passed against a map that could not contain them.
 */
type RejectionKey = `${AgentActionType}/${RejectionReason}`;

/** Every `<action>/<reason>` pair the world rejected, counted. */
function rejections(events: readonly WorldEvent[]): Map<RejectionKey, number> {
  const counts = new Map<RejectionKey, number>();
  for (const event of events) {
    if (event.kind !== 'actionRejected') continue;
    const key: RejectionKey = `${event.payload.actionType}/${event.payload.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('observability of the self', () => {
  const worlds = [run(4_242_424, 'w-observe'), run(91_017, 'w-observe')];

  it('harvests rejections at all', () => {
    // The control for the three assertions below. "Zero of X" is only evidence when the harvester
    // demonstrably sees rejections; a silently empty map satisfies every one of them.
    for (const world of worlds) {
      const counted = [...rejections(world.events).values()].reduce((sum, n) => sum + n, 0);
      expect(counted).toBeGreaterThan(0);
      expect(counted).toBe(world.events.filter((e) => e.kind === 'actionRejected').length);
    }
  });

  it('never proposes a birth during its own refractory period', () => {
    for (const world of worlds) {
      expect(rejections(world.events).get('reproduce/onCooldown') ?? 0).toBe(0);
    }
  });

  it('never offers energy to an organism that is already full', () => {
    for (const world of worlds) {
      expect(rejections(world.events).get('share/actionUnavailable') ?? 0).toBe(0);
    }
  });

  it('never proposes a step it cannot pay for', () => {
    for (const world of worlds) {
      expect(rejections(world.events).get('move/insufficientEnergy') ?? 0).toBe(0);
    }
  });

  it('still reproduces, shares and moves — the gates suppress waste, not behaviour', () => {
    for (const world of worlds) {
      const kinds = new Set(world.events.map((e) => e.kind));
      expect(kinds.has('organismBorn')).toBe(true);
      expect(kinds.has('energyShared')).toBe(true);
      expect(kinds.has('organismMigrated')).toBe(true);
    }
  });

  it('spends the freed turns instead of idling', () => {
    // The point of the gates is that a doomed proposal no longer consumes the turn. Measured over
    // 1500 ticks the total rejection count fell 6175 -> 642 and 6656 -> 571 while energy sharing
    // rose, so the world should now reject only a small fraction of what it attempts.
    for (const world of worlds) {
      const rejected = world.events.filter((e) => e.kind === 'actionRejected').length;
      const requested = world.events.filter((e) => e.kind === 'decisionRequested').length;
      expect(requested).toBeGreaterThan(0);
      expect(rejected).toBeLessThan(requested);
    }
  });
});
