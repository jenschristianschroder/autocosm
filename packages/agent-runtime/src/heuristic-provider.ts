import { hashSeed, type ActionProposal } from '@autocosm/domain';
import { decideHeuristically } from '@autocosm/simulation';
import { toProposal, type DecisionProvider, type DecisionRequest } from './ports.js';

/**
 * The deterministic decision provider.
 *
 * This is not a stub: it is the policy the world runs on when AI is disabled, unaffordable, or
 * degraded, and it is what makes the local demo work with no cloud credentials. It reuses the same
 * `decideHeuristically` policy the tick engine uses for reflexive behaviour, seeded from the
 * decision identity so the same decision always yields the same action.
 */
export class HeuristicDecisionProvider implements DecisionProvider {
  readonly name = 'heuristic';
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  isAvailable(): boolean {
    return true;
  }

  propose(request: DecisionRequest): Promise<ActionProposal> {
    const startedAtEpochMs = this.#now();
    const seed = hashSeed('decision', request.observation.tick, request.decisionId);
    const action = decideHeuristically(request.observation, seed);
    return Promise.resolve(
      toProposal({
        provider: this.name,
        action,
        rationale: `deterministic policy for ${request.reason}`,
        startedAtEpochMs,
        nowEpochMs: this.#now(),
      }),
    );
  }
}
