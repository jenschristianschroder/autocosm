/**
 * Speciation — how a lineage divides.
 *
 * Without this, lineage identity is a strict ratchet. `reproduce` copies the parent's
 * `lineageId` onto every child, and a lineage is constructed in only two places: worldgen, and
 * a spectator authoring an agent. Diversity could therefore only ever fall, and nothing inside
 * the simulation could raise it.
 *
 * Measured over 3000 ticks on three seeds before this module existed: not one lineage was ever
 * created after worldgen, and every world decayed monotonically from 8 founding lineages to 2.
 * The deployment had reached 1. A world that trends to a monoculture cannot evolve new kinds of
 * thing, and cross-lineage cultural transmission is not merely rare in it but definitionally
 * impossible — there is no second lineage left to learn from.
 *
 * A splinter forms when a child's genome has drifted far enough from its lineage's *founding*
 * genome that it is no longer usefully described as the same kind of organism. The reference has
 * to be fixed. Measured over 3000 ticks on three seeds, a newborn sits a flat ~10 from its
 * lineage's running mean however long the world has run — median 9, maximum 27 across ~3000
 * births — because the mean tracks the living population and therefore chases it. Distance from
 * the founding genome instead accumulates steadily, reaching 43-56 by tick 3000. Only the second
 * quantity can ever register that a population has become something else; a threshold on the
 * first is unreachable at every point in the trait space, whatever value it is given.
 *
 * The daughter inherits a copy of its parent's culture, so knowledge passes vertically at the
 * moment of the split and then diverges — which is what eventually gives horizontal transmission
 * something to carry.
 */

import {
  TRAIT_IDS,
  type Genotype,
  type TraitId,
  type Lineage,
  type LineageId,
} from '@autocosm/domain';

/**
 * Mean absolute difference across the whole genome, on the same 0-1000 scale as a trait.
 *
 * Averaged rather than summed so the threshold means the same thing if the genome ever gains or
 * loses a trait. Symmetric and pure.
 */
export function genotypeDivergence(a: Genotype, b: Genotype): number {
  let total = 0;
  for (const id of TRAIT_IDS) {
    total += Math.abs(a[id] - b[id]);
  }
  return Math.round(total / TRAIT_IDS.length);
}

/**
 * The single trait that has drifted furthest from the lineage's founding genome.
 *
 * Ties break by `TRAIT_IDS` order, so the answer is stable across processes and replays. This is
 * what the splinter is named for, so a spectator can read what a new kind of organism became
 * good at without opening anything.
 */
export function dominantDivergentTrait(child: Genotype, reference: Genotype): TraitId {
  let best: TraitId = 'metabolicRate';
  let bestGap = -1;
  for (const id of TRAIT_IDS) {
    const gap = Math.abs(child[id] - reference[id]);
    if (gap > bestGap) {
      bestGap = gap;
      best = id;
    }
  }
  return best;
}

/**
 * One adjective per trait, for naming a splinter after what set it apart.
 *
 * A static versioned word table, deliberately not generated: the same trait must always produce
 * the same word, in every process and every replay. Single words only, so a name stays short
 * enough to read in a list.
 */
const TRAIT_EPITHET: Readonly<Record<TraitId, string>> = Object.freeze({
  metabolicRate: 'Fervent',
  energyReserve: 'Deep',
  photosynthesis: 'Sunfed',
  thermalTolerance: 'Tempered',
  toxinResistance: 'Warded',
  motility: 'Swift',
  buoyancy: 'Adrift',
  bodySize: 'Great',
  photoreception: 'Bright',
  chemoreception: 'Keen',
  perceptionRange: 'Farsighted',
  armor: 'Plated',
  regeneration: 'Mending',
  camouflage: 'Hidden',
  aggression: 'Fierce',
  sociality: 'Legion',
  signalStrength: 'Clarion',
  memoryCapacity: 'Mindful',
  learningRate: 'Quick',
  planningDepth: 'Patient',
  manipulation: 'Deft',
  reproductiveInvestment: 'Fecund',
  mutability: 'Restless',
  longevity: 'Enduring',
});

/**
 * Name a splinter for the trait that set it apart, keeping the parent's stem.
 *
 * The stem is the parent's final word, so a splinter of "Keen Weavers" is "Plated Weavers"
 * rather than "Plated Keen Weavers" — names stay bounded however deep the tree goes, while the
 * ancestral kind stays readable in every descendant.
 */
export function splinterName(parentName: string, trait: TraitId): string {
  const words = parentName.trim().split(/\s+/u);
  const stem = words[words.length - 1] ?? parentName;
  return `${TRAIT_EPITHET[trait]} ${stem}`.slice(0, 64);
}

/**
 * Lineages with at least one living member.
 *
 * Counts the living, not the ever-created. A cumulative count here would repeat the population
 * ceiling's defect exactly: once this many lineages had ever existed, no world could ever
 * diversify again, and the failure would be invisible because the survivors look healthy.
 */
export function countActiveLineages(lineages: ReadonlyMap<LineageId, Lineage>): number {
  let active = 0;
  for (const lineage of lineages.values()) {
    if (lineage.livingCount > 0) active += 1;
  }
  return active;
}

export interface SpeciationCheck {
  readonly childGenotype: Genotype;
  readonly parentLineage: Lineage;
  readonly activeLineages: number;
  readonly maxActiveLineages: number;
  readonly divergenceThreshold: number;
  readonly minParentPopulation: number;
}

export type SpeciationVerdict =
  | { readonly splits: false }
  | { readonly splits: true; readonly divergence: number; readonly trait: TraitId };

/**
 * Decide whether a newborn founds a lineage of its own.
 *
 * Divergence is measured against the parent lineage's *founding* genome, never its running mean —
 * see the module docstring for the measurement that forced this. Three conditions, each guarding
 * a different failure. Divergence keeps a split meaningful rather than arbitrary. A minimum parent
 * population means only an established lineage can bud, so a dying one cannot shed splinters that
 * inherit its predicament. The active-lineage ceiling keeps the world's agent set bounded, which
 * matters because every lineage competes for the same fixed `maxDecisionsPerTick` budget —
 * fragmenting without limit would starve every lineage of cognition rather than enrich the world.
 */
export function evaluateSpeciation(check: SpeciationCheck): SpeciationVerdict {
  if (check.parentLineage.livingCount < check.minParentPopulation) return { splits: false };
  if (check.activeLineages >= check.maxActiveLineages) return { splits: false };
  const reference = check.parentLineage.foundingGenotype;
  const divergence = genotypeDivergence(check.childGenotype, reference);
  if (divergence < check.divergenceThreshold) return { splits: false };
  return {
    splits: true,
    divergence,
    trait: dominantDivergentTrait(check.childGenotype, reference),
  };
}
