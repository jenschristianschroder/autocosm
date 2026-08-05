import {
  asDecisionId,
  derivePhenotype,
  type DecisionReason,
  type Observation,
  type Organism,
  type PendingDecision,
} from '@autocosm/domain';
import type { SimulationConfig } from './config.js';
import type { WorldDraft } from './state.js';

/**
 * When is a decision worth paying a model for?
 *
 * Routine survival is handled by the deterministic policy for free. A pending AI decision
 * is only created at a genuine branch point, and even then only when the lineage has
 * evolved enough deliberation to use the answer, and only within a hard per-tick budget.
 * These three gates together are the main cost control in the system.
 */
export interface DecisionCandidate {
  readonly organism: Organism;
  readonly reason: DecisionReason;
  /** Higher wins when the per-tick budget is exhausted. */
  readonly priority: number;
}

export function detectDecisionPoint(
  draft: WorldDraft,
  organism: Organism,
  observation: Observation,
  config: SimulationConfig,
): DecisionCandidate | null {
  const agent = draft.agents.get(organism.agentId);
  if (!agent || agent.status !== 'active') return null;

  const phenotype = derivePhenotype(organism.genotype);
  const sinceLast = draft.world.tick - agent.lastDecisionTick;
  if (sinceLast < config.minTicksBetweenDecisionsPerLineage) return null;

  // A new creator goal always earns a considered response, regardless of planning depth:
  // even a simple organism should visibly react to being given a purpose.
  const pendingGoal = (draft.goals.get(organism.agentId) ?? []).find((g) => g.status === 'pending');
  if (pendingGoal) {
    return { organism, reason: 'newCreatorGoal', priority: 100 };
  }

  // Below the planning threshold the lineage cannot use a considered answer, so paying for
  // one would be waste.
  if (phenotype.effectivePlanning < config.minPlanningForDiscretionaryDecision) return null;

  const energyRatio =
    observation.self.maxEnergy <= 0
      ? 0
      : Math.trunc((observation.self.energy * 1000) / observation.self.maxEnergy);

  if (energyRatio < 200) {
    return { organism, reason: 'starvationRisk', priority: 90 };
  }

  const unknownStructure = observation.structures.some((s) => !s.inspected);
  const unknownMaterial = observation.resources.some((r) => !r.known);
  if (unknownStructure || unknownMaterial) {
    return { organism, reason: 'novelDiscovery', priority: 70 };
  }

  const conflict = observation.organisms.some(
    (o) => !o.kin && o.threatBand !== 'harmless' && o.distanceCu <= 600,
  );
  if (conflict) {
    return { organism, reason: 'socialConflict', priority: 60 };
  }

  if (
    observation.self.mature &&
    energyRatio > 750 &&
    draft.world.tick >= organism.reproductionReadyTick
  ) {
    return { organism, reason: 'reproductionStrategy', priority: 50 };
  }

  if (
    observation.availableActions.includes('build') &&
    observation.self.inventory.reduce((s, e) => s + e.quantity, 0) >= 80
  ) {
    return { organism, reason: 'constructionOpportunity', priority: 45 };
  }

  const kinNearby = observation.organisms.filter((o) => o.kin).length;
  if (kinNearby >= 3 && observation.availableActions.includes('signal')) {
    return { organism, reason: 'cooperationOpportunity', priority: 30 };
  }

  if (
    draft.world.pressure.severity > 500 &&
    draft.world.pressure.startedAtTick === draft.world.tick
  ) {
    return { organism, reason: 'environmentalShift', priority: 80 };
  }

  return null;
}

/** Turn a candidate into a stored pending decision with a deterministic identifier. */
export function toPendingDecision(
  draft: WorldDraft,
  candidate: DecisionCandidate,
  observation: Observation,
  config: SimulationConfig,
): PendingDecision {
  return {
    id: asDecisionId(
      `dec-${draft.world.id}-${String(draft.world.tick).padStart(8, '0')}-${candidate.organism.id}`.slice(
        0,
        64,
      ),
    ),
    worldId: draft.world.id,
    agentId: candidate.organism.agentId,
    lineageId: candidate.organism.lineageId,
    organismId: candidate.organism.id,
    regionId: candidate.organism.regionId,
    createdAtTick: draft.world.tick,
    expiresAtTick: draft.world.tick + config.decisionExpiryTicks,
    reason: candidate.reason,
    status: 'pending',
    observation,
    attempts: 0,
  };
}

/** Rank and truncate candidates to the per-tick budget, deterministically. */
export function selectDecisions(
  candidates: readonly DecisionCandidate[],
  budget: number,
): DecisionCandidate[] {
  return candidates
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.organism.id < b.organism.id ? -1 : a.organism.id > b.organism.id ? 1 : 0),
    )
    .slice(0, Math.max(0, budget));
}
