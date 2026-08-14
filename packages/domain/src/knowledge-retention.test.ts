import { describe, expect, it } from 'vitest';
import { BASE_MATERIAL_IDS } from './materials.js';
import { asMaterialId } from './ids.js';
import { MAX_KNOWN_RECIPES, type KnownRecipe, retainRecipes } from './entities.js';
import { AgentRecordSchema } from './records.js';

/**
 * What an agent keeps when it knows more than it can hold.
 *
 * These construct their subject rather than searching a generated world for one. Whether any agent
 * sits on a particular tech tree at a particular tick is a property of the trajectory; which recipe
 * gets dropped is a property of the mechanism, and only the second is under test here.
 */

const [BASE_A, BASE_B, BASE_C] = BASE_MATERIAL_IDS;

function recipe(
  produces: string,
  components: readonly string[],
  learnedAtTick: number,
): KnownRecipe {
  return {
    key: `k-${produces}`,
    label: produces,
    components: components.map((materialId) => ({
      materialId: asMaterialId(materialId),
      quantity: 10,
    })),
    learnedAtTick,
    producesMaterialId: asMaterialId(produces),
  };
}

/** Ingredients an agent can actually put its hands on: base materials plus what it can make. */
function usableCount(recipes: readonly KnownRecipe[]): number {
  const base = new Set(BASE_MATERIAL_IDS.map((id) => String(id)));
  const producible = new Set(
    recipes.flatMap((r) =>
      r.producesMaterialId === undefined ? [] : [String(r.producesMaterialId)],
    ),
  );
  return recipes.filter((r) =>
    r.components.every(
      (c) => base.has(String(c.materialId)) || producible.has(String(c.materialId)),
    ),
  ).length;
}

/**
 * A three-deep chain plus one independent tip. `mxC` is the most advanced thing this agent can
 * make, and it is reachable only through `mxA` and `mxB`.
 */
function chainOfFour(): KnownRecipe[] {
  return [
    recipe('mxA', [String(BASE_A), String(BASE_B)], 10),
    recipe('mxB', ['mxA', String(BASE_C)], 20),
    recipe('mxC', ['mxB', String(BASE_A)], 30),
    recipe('mxD', [String(BASE_B), String(BASE_C)], 40),
  ];
}

describe('retainRecipes', () => {
  it('keeps everything while under the bound', () => {
    const held = chainOfFour();
    expect(retainRecipes(held, 4)).toEqual(held);
    expect(retainRecipes(held, 99)).toEqual(held);
  });

  it('always honours the bound', () => {
    for (let limit = 1; limit <= 4; limit += 1) {
      expect(retainRecipes(chainOfFour(), limit)).toHaveLength(limit);
    }
  });

  it('drops a tip rather than the foundation the rest of the tree stands on', () => {
    const kept = retainRecipes(chainOfFour(), 3);
    const produced = kept.map((r) => String(r.producesMaterialId));
    // `mxA` is depended on by `mxB`, which is depended on by `mxC`. Only `mxC` and `mxD` are tips,
    // and `mxC` is the older of the two.
    expect(produced).toContain('mxA');
    expect(produced).not.toContain('mxC');
    // FIFO would have dropped `mxA` here and stranded everything above it.
    expect(usableCount(kept)).toBe(3);
  });

  it('evicts knowledge it can never act on before knowledge it can', () => {
    const held = [
      recipe('mxA', [String(BASE_A), String(BASE_B)], 10),
      recipe('mxB', ['mxA', String(BASE_C)], 20),
      // Learned by inspecting a foreign construction: the agent has never seen how to make `mxZ`,
      // so this is the newest thing it knows and also the only thing it can never do.
      recipe('mxY', ['mxZ', String(BASE_A)], 30),
    ];
    const kept = retainRecipes(held, 2);
    expect(kept.map((r) => String(r.producesMaterialId))).toEqual(['mxA', 'mxB']);
    expect(usableCount(kept)).toBe(2);
  });

  it('prunes a whole dead subtree, not one node of it per eviction', () => {
    const held = [
      recipe('mxA', [String(BASE_A), String(BASE_B)], 10),
      recipe('mxB', ['mxA', String(BASE_C)], 20),
      recipe('mxY', ['mxZ', String(BASE_A)], 30), // unmakeable
      recipe('mxX', ['mxY', String(BASE_B)], 40), // unmakeable only because mxY is
    ];
    const kept = retainRecipes(held, 2);
    expect(kept.map((r) => String(r.producesMaterialId))).toEqual(['mxA', 'mxB']);
  });

  it('leaves nothing dead when it has to cut a tree in half', () => {
    // Six-deep chain into two slots: whatever survives must still be executable.
    const chain: KnownRecipe[] = [recipe('mx0', [String(BASE_A), String(BASE_B)], 0)];
    for (let i = 1; i < 6; i += 1) {
      chain.push(recipe(`mx${i}`, [`mx${i - 1}`, String(BASE_C)], i * 10));
    }
    const kept = retainRecipes(chain, 2);
    expect(kept).toHaveLength(2);
    expect(usableCount(kept)).toBe(2);
    expect(kept.map((r) => String(r.producesMaterialId))).toEqual(['mx0', 'mx1']);
  });

  it('is deterministic', () => {
    const first = retainRecipes(chainOfFour(), 2);
    for (let i = 0; i < 5; i += 1) {
      expect(retainRecipes(chainOfFour(), 2)).toEqual(first);
    }
  });

  it('treats a recipe that never recorded what it makes as a tip', () => {
    // Only records persisted before material identity became physical look like this. It is not the
    // oldest thing held, so dropping it is a judgement about dependency rather than about age.
    const legacy: KnownRecipe = {
      key: 'k-legacy',
      label: 'legacy',
      components: [{ materialId: asMaterialId(String(BASE_A)), quantity: 10 }],
      learnedAtTick: 20,
    };
    const held = [
      recipe('mxA', [String(BASE_A), String(BASE_B)], 10),
      legacy,
      recipe('mxB', ['mxA', String(BASE_C)], 30),
    ];
    const kept = retainRecipes(held, 2);
    expect(kept.some((r) => r.key === 'k-legacy')).toBe(false);
    expect(kept.map((r) => String(r.producesMaterialId))).toEqual(['mxA', 'mxB']);
  });

  it('cannot produce an agent that persistence would refuse to read back', () => {
    // The record cap derives from this constant, so the two can never drift apart. Asserted through
    // the schema rather than against a literal, because the literal is the thing that used to lie.
    const recipes = Array.from({ length: MAX_KNOWN_RECIPES }, (_, i) =>
      recipe(`mx${i}`, [String(BASE_A), String(BASE_B)], i),
    );
    const parsed = AgentRecordSchema.shape.knowledge.safeParse({
      knownMaterialIds: [],
      recipes: recipes.map((r) => ({
        key: r.key,
        label: r.label,
        components: r.components.map((c) => ({
          materialId: String(c.materialId),
          quantity: c.quantity,
        })),
        learnedAtTick: r.learnedAtTick,
        producesMaterialId: String(r.producesMaterialId),
      })),
      knownStructureIds: [],
    });
    expect(parsed.success).toBe(true);
  });
});
