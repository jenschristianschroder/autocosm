import {
  Prng,
  TRAIT_CATALOGUE,
  TRAIT_IDS,
  asOrganismId,
  clampPerMille,
  complexityScore,
  derivePhenotype,
  hashSeed,
  makePosition,
  normaliseGenotype,
  regionIdOf,
  scaleByPerMille,
  type Genotype,
  type Organism,
  type TraitId,
} from '@autocosm/domain';
import type { SimulationConfig } from './config.js';
import type { EventSink } from './events.js';
import type { EnergyLedger } from './resolve.js';
import type { WorldDraft } from './state.js';

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
  readonly reason?: string;
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

export function reproduce(args: ReproduceArgs): ReproductionOutcome {
  const { draft, config, parent } = args;
  const phenotype = derivePhenotype(parent.genotype);
  if (parent.ageTicks < phenotype.maturityAgeTicks) return { child: null, reason: 'notMature' };
  if (draft.world.tick < parent.reproductionReadyTick) return { child: null, reason: 'onCooldown' };
  if (draft.organisms.size >= config.maxOrganisms) return { child: null, reason: 'population' };

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

  const child: Organism = {
    id: childId,
    worldId: parent.worldId,
    agentId: parent.agentId,
    lineageId: parent.lineageId,
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
  if (lineage) {
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
