import { describe, expect, it } from 'vitest';

import {
  BASE_MATERIALS,
  MATERIAL_REACTION_RULES,
  REACTION_IDS,
  combineMaterials,
  deriveMaterialId,
  explainedReactions,
  indexMaterials,
  reactionsForComponents,
  type MaterialComponent,
  type MaterialDefinition,
} from './materials.js';
import { STRUCTURE_FUNCTION_RULES } from './structures.js';
import { asMaterialId } from './ids.js';

/**
 * Material composition used to be a volume-weighted mean and nothing else — a convex combination,
 * so every composite fell inside the hull of the fourteen base materials and repeated blending
 * pulled the whole reachable space toward its centroid. Conductivity, toxicity and
 * photosensitivity are each held by only two or three base materials, so they were halved on first
 * blend and truncated to zero shortly after. That made `conduit`, `beacon` and `toxinWard`
 * categorically unreachable through crafting: a species that learned to combine became strictly
 * less capable than one that only gathered.
 *
 * These tests pin the escape rather than the numbers. They assert that a composite can exceed its
 * best ingredient on a target axis, that the three stranded functions are reachable from crafted
 * material, and — just as importantly — that the escape stays earned: order cannot matter, dilution
 * cannot pay, and nutrition can never exceed the mean it came from.
 */

const catalogue = indexMaterials(BASE_MATERIALS);

function base(id: string): MaterialDefinition {
  const definition = catalogue.get(asMaterialId(id));
  if (!definition) throw new Error(`missing base material ${id}`);
  return definition;
}

function combine(components: readonly MaterialComponent[]): MaterialDefinition {
  const result = combineMaterials(deriveMaterialId(components), components, catalogue, 1);
  if (!result) throw new Error('combine returned null');
  return result;
}

const pair = (a: string, b: string, qa = 10, qb = 10): readonly MaterialComponent[] => [
  { materialId: asMaterialId(a), quantity: qa },
  { materialId: asMaterialId(b), quantity: qb },
];

describe('material reactions', () => {
  it('is deterministic', () => {
    const first = combine(pair('lightCrystal', 'stone'));
    const second = combine(pair('lightCrystal', 'stone'));
    expect(second).toEqual(first);
  });

  it('does not depend on the order the ingredients are given in', () => {
    // Every rule reads the same immutable blend, so the set is commutative by construction. This
    // asserts the construction rather than trusting it: an implementation that applied boosts
    // sequentially would pass every other test here and fail this one.
    const forward = combine(pair('lightCrystal', 'stone', 10, 14));
    const backward = combine(pair('stone', 'lightCrystal', 14, 10));
    expect(backward.properties).toEqual(forward.properties);
    expect(backward.nutritionPerUnit).toEqual(forward.nutritionPerUnit);
  });

  it('lets a composite exceed its best ingredient, which a weighted mean never can', () => {
    const components = pair('stone', 'carapaceShard');
    const result = combine(components);
    const ceiling = Math.max(
      base('stone').properties.hardness,
      base('carapaceShard').properties.hardness,
    );
    expect(result.properties.hardness).toBeGreaterThan(ceiling);
  });

  it('unlocks the three structure functions crafting could never reach', () => {
    const conduitFloor = requirementThreshold('conduit');
    const beaconFloor = requirementThreshold('beacon');
    const wardFloor = requirementThreshold('toxinWard');

    // Each of these was exactly 0 on every composite before reactions existed.
    expect(combine(pair('lightCrystal', 'stone')).properties.conductivity).toBeGreaterThanOrEqual(
      conduitFloor,
    );
    expect(
      combine(pair('lightCrystal', 'mineralSalt')).properties.photosensitivity,
    ).toBeGreaterThanOrEqual(beaconFloor);
    expect(combine(pair('toxinSac', 'resin')).properties.toxicity).toBeGreaterThanOrEqual(
      wardFloor,
    );
  });

  it('pays only for concentration — diluting a potent ingredient destroys the reaction', () => {
    // `toxinSac` is the only strongly toxic base material. Swamped by inert bulk, the blend falls
    // under the threshold and the reaction does not fire, so crafting cannot launder a trace of
    // something potent into a weapon.
    const concentrated = combine(pair('toxinSac', 'resin', 10, 10));
    const diluted = combine(pair('toxinSac', 'resin', 1, 200));
    expect(concentrated.properties.toxicity).toBeGreaterThan(diluted.properties.toxicity);
    // The load-bearing half: the reaction must fire in one case and not the other. Without this,
    // the assertion above passes on a plain weighted mean too and pins nothing.
    expect(reactionsForComponents(pair('toxinSac', 'resin', 10, 10), catalogue)).toContain(
      'concentrating',
    );
    expect(reactionsForComponents(pair('toxinSac', 'resin', 1, 200), catalogue)).toHaveLength(0);
  });

  it('reports the reactions that produced a material, recomputed from its ingredients', () => {
    const components = pair('lightCrystal', 'stone');
    const fired = reactionsForComponents(components, catalogue);
    expect(fired.length).toBeGreaterThan(0);
    for (const id of fired) expect(REACTION_IDS).toContain(id);
    // Recomputed, never stored, so an explanation cannot drift from the rule that produced it.
    expect(reactionsForComponents(components, catalogue)).toEqual(fired);
  });

  it('never lets nutrition exceed the mean of its ingredients', () => {
    // Reactions deliberately do not reach nutrition. If they ever did, combining would become an
    // energy source and the biomass limit that drives the whole ecology would stop binding.
    const components = pair('biofilm', 'algaeMat');
    const result = combine(components);
    const mean =
      (base('biofilm').nutritionPerUnit * 10 + base('algaeMat').nutritionPerUnit * 10) / 20;
    expect(result.nutritionPerUnit).toBeLessThanOrEqual(Math.trunc(mean));
    expect(result.nutritionPerUnit).toBeGreaterThan(0);
  });

  it('makes concentrated toxin inedible, so the same binder cannot make a weapon and a meal', () => {
    const weapon = combine(pair('toxinSac', 'resin'));
    expect(weapon.properties.toxicity).toBeGreaterThan(500);
    expect(weapon.nutritionPerUnit).toBe(0);
  });

  it('publishes a glossary rule for every reaction the simulation can apply', () => {
    expect(MATERIAL_REACTION_RULES.map((rule) => rule.id)).toEqual([...REACTION_IDS]);
    for (const rule of MATERIAL_REACTION_RULES) {
      expect(rule.summary.length).toBeGreaterThan(20);
      expect(rule.requirement.length).toBeGreaterThan(10);
    }
  });

  it('attributes reactions to a material it can verify, and stays silent otherwise', () => {
    const components = pair('lightCrystal', 'stone');
    const made = combine(components);
    expect(explainedReactions(made, catalogue).length).toBeGreaterThan(0);

    // A base material was not made by combining anything.
    expect(explainedReactions(base('stone'), catalogue)).toHaveLength(0);

    // A composite whose stored properties do not match what its ingredients produce today was made
    // under different rules. Recomputing would attribute a reaction that never applied to it, so
    // the honest answer is nothing at all.
    const legacy: MaterialDefinition = {
      ...made,
      properties: { ...made.properties, conductivity: 0 },
    };
    expect(explainedReactions(legacy, catalogue)).toHaveLength(0);
  });
});

/** Reads the numeric floor out of a published requirement, so the test cannot drift from the rule. */
function requirementThreshold(functionId: string): number {
  const rule = STRUCTURE_FUNCTION_RULES.find((entry) => entry.id === functionId);
  if (!rule) throw new Error(`missing function rule ${functionId}`);
  const match = /(\d+)/.exec(rule.requirement);
  if (!match?.[1]) throw new Error(`no threshold in requirement: ${rule.requirement}`);
  return Number(match[1]);
}
