import {
  Prng,
  TRAIT_CATALOGUE,
  TRAIT_IDS,
  asAgentId,
  asLineageId,
  asOrganismId,
  clampPerMille,
  complexityScore,
  derivePhenotype,
  hashSeed,
  makePosition,
  normaliseGenotype,
  regionIdOf,
  scaleByPerMille,
  type Agent,
  type Genotype,
  type Lineage,
  type Organism,
  type RejectionReason,
  type TraitId,
} from '@autocosm/domain';
import type { SimulationConfig } from './config.js';
import type { EventSink } from './events.js';
import type { EnergyLedger } from './resolve.js';
import type { WorldDraft } from './state.js';
import { countLivingOrganisms } from './state.js';
import { countActiveLineages, evaluateSpeciation, splinterName } from './speciation.js';

/**
 * Reproduction, mutation and inheritance.
 *
 * Three channels are kept strictly separate:
 *  - **genetic**: the genotype below, inherited and mutated at reproduction;
 *  - **lifetime**: `Organism.lifetime`, which is *never* copied to offspring;
 *  - **cultural**: `Agent.knowledge`, which spreads only via signalling and memory.
 *
 * Mixing these would collapse the model into Lamarckian inheritance, which the world is
 * explicitly not.
 */
export interface ReproductionOutcome {
  readonly child: Organism | null;
  /**
   * Typed, not `string`.
   *
   * This was `string`, which meant nothing forced it to be a reason the rest of the world
   * understands. `tick.ts` could not widen it to a `RejectionReason` without a cast, so it
   * emitted a hardcoded `actionUnavailable` in the structured payload and put the real cause
   * only in the prose summary. Every programmatic reader of the rejection stream — including
   * the production probe that is this project's fastest diagnostic — therefore saw a constant
   * where the cause should have been.
   */
  readonly reason?: RejectionReason;
}

/** Maximum absolute change to one trait in one mutation event, in per-mille. */
export const MAX_MUTATION_STEP = 90;

export function mutateGenotype(genotype: Genotype, rng: Prng, chancePerMille: number): Genotype {
  const next: Partial<Record<TraitId, number>> = {};
  for (const id of TRAIT_IDS) {
    const base = genotype[id];
    if (!rng.chance(chancePerMille)) {
      next[id] = base;
      continue;
    }
    // Symmetric bounded drift. No trait can jump to an extreme in a single generation.
    const delta = rng.nextRange(-MAX_MUTATION_STEP, MAX_MUTATION_STEP);
    next[id] = clampPerMille(base + delta);
  }
  return normaliseGenotype(next);
}

export interface ReproduceArgs {
  readonly draft: WorldDraft;
  readonly config: SimulationConfig;
  readonly events: EventSink;
  readonly ledger: EnergyLedger;
  readonly parent: Organism;
  readonly investment: number;
  readonly ordinal: number;
}

interface SplinterArgs {
  readonly draft: WorldDraft;
  readonly config: SimulationConfig;
  readonly parent: Organism;
  readonly childGenotype: Genotype;
  readonly childId: string;
}

interface Splinter {
  readonly agent: Agent;
  readonly lineage: Lineage;
  readonly divergence: number;
  readonly trait: TraitId;
}

/**
 * Give a sufficiently divergent newborn a lineage and an agent of its own.
 *
 * Writes both into the draft and returns them, or returns `null` if the newborn is still its
 * parent's kind. The daughter agent inherits a *copy* of its parent's knowledge: culture passes
 * vertically at the moment of the split, exactly as it would to any other offspring, and the two
 * bodies of knowledge then diverge independently. Copying rather than sharing is the point — a
 * shared reference would make the two lineages permanently identical culturally, so nothing
 * could ever be learned across the boundary.
 *
 * Identifiers derive from the child's own id, which is already deterministic in world, tick and
 * ordinal, so a replay reconstructs the same lineage tree.
 */
function foundSplinterLineage(args: SplinterArgs): Splinter | null {
  const { draft, config, parent } = args;
  const parentLineage = draft.lineages.get(parent.lineageId);
  const parentAgent = draft.agents.get(parent.agentId);
  if (!parentLineage || !parentAgent) return null;

  const verdict = evaluateSpeciation({
    childGenotype: args.childGenotype,
    parentLineage,
    activeLineages: countActiveLineages(draft.lineages),
    maxActiveLineages: config.maxActiveLineages,
    divergenceThreshold: config.speciationDivergence,
    minParentPopulation: config.speciationMinParentPopulation,
  });
  if (!verdict.splits) return null;

  const suffix = args.childId.slice(3);
  const lineageId = asLineageId(`ln-${suffix}`);
  const agentId = asAgentId(`ag-${suffix}`);
  if (draft.lineages.has(lineageId) || draft.agents.has(agentId)) return null;

  const name = splinterName(parentLineage.name, verdict.trait);

  const agent: Agent = {
    id: agentId,
    worldId: parentAgent.worldId,
    lineageId,
    name,
    createdByCreatorId: parentAgent.createdByCreatorId,
    createdAtTick: draft.world.tick,
    status: 'active',
    // Disposition is inherited: a splinter is a divergent body, not a different mind.
    drives: parentAgent.drives,
    temperament: parentAgent.temperament,
    habitat: parentAgent.habitat,
    aspiration: parentAgent.aspiration,
    // A deep copy, so learning after the split belongs to one lineage only.
    knowledge: {
      knownMaterialIds: [...parentAgent.knowledge.knownMaterialIds],
      recipes: parentAgent.knowledge.recipes.map((recipe) => ({ ...recipe })),
      knownStructureIds: [...parentAgent.knowledge.knownStructureIds],
    },
    lastDecisionTick: draft.world.tick,
    decisionCount: 0,
    visualSeed: hashSeed('visual', lineageId) % 65_536,
  };

  const lineage: Lineage = {
    id: lineageId,
    worldId: parent.worldId,
    agentId,
    name,
    foundedAtTick: draft.world.tick,
    originRegionId: parent.regionId,
    generations: 1,
    births: 1,
    deaths: 0,
    livingCount: 1,
    meanGenotype: args.childGenotype,
    // The splinter's own clock starts here: drift is measured from what it was, not from what
    // its parent was, so a daughter cannot immediately split again on inherited distance.
    foundingGenotype: args.childGenotype,
  };

  draft.agents.set(agentId, agent);
  draft.lineages.set(lineageId, lineage);
  return { agent, lineage, divergence: verdict.divergence, trait: verdict.trait };
}

export function reproduce(args: ReproduceArgs): ReproductionOutcome {
  const { draft, config, parent } = args;
  const phenotype = derivePhenotype(parent.genotype);
  if (parent.ageTicks < phenotype.maturityAgeTicks) return { child: null, reason: 'notMature' };
  if (draft.world.tick < parent.reproductionReadyTick) return { child: null, reason: 'onCooldown' };
  // Counts the living, not the map: corpses are retained for inspection, and including them
  // here would turn a population ceiling into a lifetime birth quota.
  if (countLivingOrganisms(draft) >= config.maxOrganisms) {
    return { child: null, reason: 'population' };
  }

  const investment = clampPerMille(args.investment);
  const spend = Math.max(phenotype.reproductionCost, scaleByPerMille(parent.energy, investment));
  if (parent.energy < spend + phenotype.upkeepPerTick) {
    return { child: null, reason: 'insufficientEnergy' };
  }

  const rng = new Prng(
    hashSeed('reproduce', draft.world.seed, draft.world.tick, parent.id, args.ordinal),
  );
  const childGenotype = mutateGenotype(parent.genotype, rng, phenotype.mutationChancePerMille);
  const childPhenotype = derivePhenotype(childGenotype);

  // Only part of the invested energy reaches the offspring. The remainder is the real cost
  // of reproduction and is destroyed, which is what keeps populations bounded.
  const endowment = Math.min(
    childPhenotype.maxEnergy,
    scaleByPerMille(spend, config.reproductionEfficiency),
  );
  args.ledger.debit(spend - endowment);

  const childId = asOrganismId(
    `or-${draft.world.id}-${String(draft.world.tick).padStart(8, '0')}-${args.ordinal.toString(36)}`,
  );
  const offset = Math.max(40, Math.trunc(phenotype.speedCuPerTick / 2));
  const position = makePosition(
    parent.position.x + rng.nextRange(-offset, offset),
    parent.position.z + rng.nextRange(-offset, offset),
  );

  // Does this newborn belong to its parent's kind, or has it become something else? Resolved
  // before the child is constructed, because the answer decides which lineage and agent it
  // carries for life.
  const split = foundSplinterLineage({
    draft,
    config,
    parent,
    childGenotype,
    childId,
  });

  const child: Organism = {
    id: childId,
    worldId: parent.worldId,
    agentId: split?.agent.id ?? parent.agentId,
    lineageId: split?.lineage.id ?? parent.lineageId,
    regionId: regionIdOf(position),
    position,
    genotype: childGenotype,
    // Lifetime adaptation is deliberately reset: learning is not inherited.
    lifetime: { emphasis: {}, successes: {}, failures: {} },
    energy: endowment,
    health: childPhenotype.maxHealth,
    ageTicks: 0,
    bornAtTick: draft.world.tick,
    generation: parent.generation + 1,
    parentOrganismId: parent.id,
    inventory: [],
    reproductionReadyTick: draft.world.tick + childPhenotype.maturityAgeTicks,
    alive: true,
  };

  draft.organisms.set(child.id, child);
  draft.organisms.set(parent.id, {
    ...parent,
    energy: parent.energy - spend,
    reproductionReadyTick: draft.world.tick + config.reproductionCooldownTicks,
  });
  draft.lineageNodes.set(child.id, {
    organismId: child.id,
    lineageId: child.lineageId,
    parentOrganismId: parent.id,
    bornAtTick: draft.world.tick,
    generation: child.generation,
    complexity: complexityScore(childGenotype),
  });

  const lineage = draft.lineages.get(parent.lineageId);
  if (lineage && !split) {
    draft.lineages.set(lineage.id, {
      ...lineage,
      births: lineage.births + 1,
      livingCount: lineage.livingCount + 1,
      generations: Math.max(lineage.generations, child.generation + 1),
    });
  }

  args.events.emit('organismBorn', child.regionId, {
    summary: `${parent.id} reproduced`,
    organismId: child.id,
    agentId: child.agentId,
    lineageId: child.lineageId,
    payload: { parentOrganismId: parent.id, generation: child.generation },
  });

  if (split) {
    args.events.emit('lineageFounded', child.regionId, {
      summary: `${split.lineage.name} diverged from ${lineage?.name ?? parent.lineageId}`,
      organismId: child.id,
      agentId: split.agent.id,
      lineageId: split.lineage.id,
      payload: {
        parentLineageId: parent.lineageId,
        divergence: split.divergence,
        traitId: split.trait,
      },
    });
  }

  return { child };
}

/**
 * Running mean genome for a lineage.
 *
 * Presentation only — nothing in the simulation reads it — but it makes the lineage tree
 * legible and lets the browser show drift over time.
 */
export function meanGenotypeOf(organisms: readonly Organism[]): Genotype | null {
  if (organisms.length === 0) return null;
  const totals: Partial<Record<TraitId, number>> = {};
  for (const id of TRAIT_IDS) totals[id] = 0;
  for (const organism of organisms) {
    for (const id of TRAIT_IDS) {
      totals[id] = (totals[id] ?? 0) + organism.genotype[id];
    }
  }
  const mean: Partial<Record<TraitId, number>> = {};
  for (const id of TRAIT_IDS) {
    mean[id] = Math.trunc((totals[id] ?? 0) / organisms.length);
  }
  return normaliseGenotype(mean);
}

/**
 * Every trait costs something.
 *
 * Exposed so a regression test can assert the invariant directly against the catalogue
 * rather than trusting prose in the documentation.
 */
export function traitHasCost(id: TraitId): boolean {
  const definition = TRAIT_CATALOGUE[id];
  return definition.upkeepAtFull + definition.massAtFull > 0 || definition.suppresses.length > 0;
}
