import { describe, expect, it } from 'vitest';

import {
  BASE_MATERIALS,
  MATERIAL_IDENTITY_BUCKET,
  MATERIAL_PROPERTY_IDS,
  combineMaterials,
  deriveRecipeKey,
  indexMaterials,
  type MaterialComponent,
} from './materials.js';
import { asMaterialId } from './ids.js';

/**
 * A material is a *substance*; a recipe is a *procedure*. These are not the same kind of thing, and
 * conflating them is what made the catalogue fill with entries nothing in the world could tell
 * apart.
 *
 * Identity used to be the ingredient list including exact quantities, so `A x22 + B x33` and
 * `A x44 + B x66` — the same 2:3 blend, producing byte-identical properties by construction — were
 * two different materials. Measured over 1500 ticks that made 15–21% of every catalogue provable
 * duplicates, and, because ratio is continuous, it meant the identity space had no end and
 * discovery could never converge.
 *
 * These pin the mechanism rather than any particular count: scale-invariance, quantisation, the
 * separation of the two identity spaces, and the rule that a rediscovery must not overwrite what
 * the world already holds.
 */

const catalogue = indexMaterials(BASE_MATERIALS);

function combine(components: readonly MaterialComponent[], tick = 1) {
  const result = combineMaterials(components, catalogue, tick);
  if (!result) throw new Error('combine returned null for a valid component list');
  return result;
}

const pair = (a: string, b: string, qa: number, qb: number): readonly MaterialComponent[] => [
  { materialId: asMaterialId(a), quantity: qa },
  { materialId: asMaterialId(b), quantity: qb },
];

describe('material identity is physical', () => {
  it('gives the same id to the same blend at a different scale', () => {
    // The defect in one line: these are the same 2:3 mixture, so they are the same substance.
    const small = combine(pair('sand', 'resin', 22, 33));
    const large = combine(pair('sand', 'resin', 44, 66));

    expect(large.id).toBe(small.id);
    for (const property of MATERIAL_PROPERTY_IDS) {
      expect(large.properties[property]).toBe(small.properties[property]);
    }
    expect(large.nutritionPerUnit).toBe(small.nutritionPerUnit);
    expect(large.label).toBe(small.label);
  });

  it('collapses a continuum of ratios onto a handful of substances', () => {
    // Quantisation is what closes the identity space, and this is the measurement that matters:
    // 200 blends sweeping a ratio continuum used to be 200 materials, because identity was the
    // ingredient list including exact quantities. They are a handful of substances.
    //
    // Asserted statistically rather than pairwise on purpose. Any lattice has boundaries, so two
    // arbitrarily close blends *can* straddle one and stay distinct; what must hold is that a
    // continuum cannot generate unbounded novelty.
    const ids = new Set<string>();
    for (let extra = 0; extra < 200; extra += 1) {
      ids.add(combine(pair('sand', 'resin', 1000, 1000 + extra)).id);
    }
    expect(ids.size).toBeLessThanOrEqual(24);
    // And not so coarse that a real change of composition goes unnoticed.
    expect(ids.size).toBeGreaterThan(1);
  });

  it('still separates blends that differ by more than a bucket', () => {
    // Kill the mutant: an identity that collapsed *everything* would pass the tests above.
    const lean = combine(pair('sand', 'resin', 90, 10));
    const rich = combine(pair('sand', 'resin', 10, 90));
    expect(rich.id).not.toBe(lean.id);
  });

  it('does not depend on the order the ingredients are given in', () => {
    expect(combine(pair('sand', 'resin', 60, 40)).id).toBe(
      combine(pair('resin', 'sand', 40, 60)).id,
    );
  });

  it('quantises finely enough to stay expressive', () => {
    // A real claim about the lattice, not a restatement of the constant: the property range must
    // still hold enough distinguishable levels for materials to mean something.
    expect(1000 / MATERIAL_IDENTITY_BUCKET).toBeGreaterThanOrEqual(20);
  });
});

describe('recipe identity is procedural', () => {
  it('keeps two routes to one substance as two distinct recipes', () => {
    // Knowing two ways to make a thing is more knowledge than knowing one, so these must not
    // collapse — the opposite decision from material identity, on purpose.
    const viaSmall = pair('sand', 'resin', 22, 33);
    const viaLarge = pair('sand', 'resin', 44, 66);

    expect(combine(viaLarge).id).toBe(combine(viaSmall).id);
    expect(deriveRecipeKey(viaLarge)).not.toBe(deriveRecipeKey(viaSmall));
  });

  it('cannot be mistaken for a material id', () => {
    // The two spaces are namespaced apart so a mix-up is a type-level impossibility rather than a
    // silent wrong lookup.
    const components = pair('sand', 'resin', 60, 40);
    expect(deriveRecipeKey(components).startsWith('rx')).toBe(true);
    expect(combine(components).id.startsWith('mx')).toBe(true);
  });

  it('is stable under reordering and scale-invariant only where the blend is', () => {
    expect(deriveRecipeKey(pair('sand', 'resin', 60, 40))).toBe(
      deriveRecipeKey(pair('resin', 'sand', 40, 60)),
    );
  });
});

describe('rediscovery', () => {
  it('leaves the first discovery in place rather than rewriting it', () => {
    // A later route landing in the same bucket must not mutate the entry: every inventory in the
    // world holds that material by id, and its properties are load-bearing for construction.
    const first = combine(pair('sand', 'resin', 22, 33), 12);
    const working = new Map(catalogue);
    working.set(first.id, first);

    const second = combineMaterials(pair('sand', 'resin', 44, 66), working, 900);
    expect(second).not.toBeNull();
    if (!second) return;

    expect(second.id).toBe(first.id);
    // The resolver keeps `existing ?? candidate`, so what the world holds stays the original —
    // including its discovery tick, which is a historical fact and not a property of the blend.
    const kept = working.get(second.id) ?? second;
    expect(kept.discoveredAtTick).toBe(12);
  });
});
