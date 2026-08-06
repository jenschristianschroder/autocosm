import {
  ACTION_PROPOSAL_JSON_SHAPE,
  MAX_OBSERVED_MEMORIES,
  MAX_OBSERVED_ORGANISMS,
  MAX_OBSERVED_RESOURCES,
  MAX_OBSERVED_SIGNALS,
  MAX_OBSERVED_STRUCTURES,
  type Observation,
} from '@autocosm/domain';

/**
 * Prompt construction.
 *
 * The model sees only what the organism could plausibly perceive plus its own drives, memories and
 * unresolved creator goals. Nothing global — no world census, no other lineage's private state, no
 * storage identifiers — is ever included. Keeping the projection here (rather than inline in the
 * provider) makes the leak surface auditable in one file.
 */

export const SYSTEM_PROMPT = [
  'You are the decision function of one organism in a simulated evolutionary world.',
  'You do not control the world. You propose a single action; a deterministic simulation decides',
  'whether it is possible and what actually happens. Invalid or unaffordable proposals are rejected.',
  '',
  'Rules:',
  '- Choose exactly one action, and only from the provided availableActions list.',
  '- Prefer survival when energy or health is low. Energy is spent by every action.',
  '- Only reference identifiers that appear in the observation. Invented identifiers are rejected.',
  '- Reply with a single JSON object and nothing else. No prose, no markdown fence, no reasoning.',
  '- The rationale must be at most 180 characters and must not contain chain-of-thought.',
  '',
  'Required JSON shape:',
  ACTION_PROPOSAL_JSON_SHAPE,
].join('\n');

/** Hard ceiling on prompt size, defended independently of the model's own token limit. */
export const MAX_PROMPT_CHARS = 12_000;

export function buildUserPrompt(observation: Observation, reason: string): string {
  const projection = projectObservation(observation, reason);
  const text = JSON.stringify(projection);
  return text.length <= MAX_PROMPT_CHARS
    ? text
    : JSON.stringify(projectObservation(observation, reason, true));
}

/**
 * A compact, allow-listed projection of the observation.
 *
 * `terse` drops the lowest-value collections first so an unusually rich observation degrades
 * gracefully instead of blowing the prompt budget.
 */
function projectObservation(observation: Observation, reason: string, terse = false): unknown {
  const cap = <T>(items: readonly T[], limit: number): readonly T[] =>
    items.slice(0, terse ? Math.ceil(limit / 2) : limit);

  return {
    reason,
    tick: observation.tick,
    self: {
      organismId: observation.self.organismId,
      energy: observation.self.energy,
      maxEnergy: observation.self.maxEnergy,
      health: observation.self.health,
      maxHealth: observation.self.maxHealth,
      ageTicks: observation.self.ageTicks,
      maxAgeTicks: observation.self.maxAgeTicks,
      mature: observation.self.mature,
      reproductionReady: observation.self.reproductionReady,
      generation: observation.self.generation,
      position: observation.self.position,
      regionId: observation.self.regionId,
      inventory: observation.self.inventory,
      planning: observation.self.planning,
      manipulation: observation.self.manipulation,
      speedCuPerTick: observation.self.speedCuPerTick,
      moveCostPer100Cu: observation.self.moveCostPer100Cu,
      perceptionRadiusCu: observation.self.perceptionRadiusCu,
    },
    environment: observation.environment,
    drives: observation.drives,
    temperament: observation.temperament,
    aspiration: observation.aspiration,
    goals: observation.goals.map((g) => g.text),
    knownRecipes: cap(observation.knownRecipes, 6),
    availableActions: observation.availableActions,
    organisms: cap(observation.organisms, MAX_OBSERVED_ORGANISMS),
    resources: cap(observation.resources, MAX_OBSERVED_RESOURCES),
    structures: cap(observation.structures, MAX_OBSERVED_STRUCTURES),
    signals: cap(observation.signals, MAX_OBSERVED_SIGNALS),
    memories: cap(observation.memories, terse ? 2 : MAX_OBSERVED_MEMORIES).map((m) => ({
      kind: m.kind,
      note: m.note,
      salience: m.salience,
    })),
  };
}
