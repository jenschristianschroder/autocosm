import { describe, expect, it } from 'vitest';
import { generateWorld } from '@autocosm/simulation';
import {
  asMaterialId,
  combineMaterials,
  deriveMaterialId,
  deriveRecipeKey,
  type MaterialComponent,
} from '@autocosm/domain';
import { composeAgentDetail } from './read-model.js';

/**
 * Read-model joins.
 *
 * A spectator sees names, not identifiers. These assert that the projection resolves ids to derived
 * names rather than passing raw storage values through, and that it heals labels persisted before
 * the naming rules existed instead of trusting them.
 */

const COMPONENTS: readonly MaterialComponent[] = [
  { materialId: asMaterialId('fibre'), quantity: 60 },
  { materialId: asMaterialId('resin'), quantity: 40 },
];

function worldWithLearnedRecipe(storedLabel: string) {
  const state = generateWorld({ seed: 90_210, worldId: 'test-world' });
  const agent = [...state.agents.values()][0];
  if (!agent) throw new Error('seeded world has no agents');

  // The world stores a composite under `deriveMaterialId(components)`, which is what makes the
  // recipe -> material join possible at all. Mirror that here rather than inventing an id.
  const composite = combineMaterials(deriveMaterialId(COMPONENTS), COMPONENTS, state.materials, 4);
  if (!composite) throw new Error('seeded world lacks the base materials this fixture combines');

  return {
    agentId: agent.id,
    composite,
    state: {
      ...state,
      materials: new Map([...state.materials, [composite.id, composite]]),
      agents: new Map([
        ...state.agents,
        [
          agent.id,
          {
            ...agent,
            knowledge: {
              ...agent.knowledge,
              knownMaterialIds: [asMaterialId('fibre'), composite.id],
              recipes: [
                {
                  key: deriveRecipeKey(COMPONENTS),
                  label: storedLabel,
                  components: COMPONENTS,
                  learnedAtTick: 4,
                },
              ],
            },
          },
        ],
      ]),
    },
  };
}

describe('composeAgentDetail material joins', () => {
  it('names known materials instead of listing identifiers', () => {
    const { state, agentId, composite } = worldWithLearnedRecipe('irrelevant');
    const detail = composeAgentDetail(state, agentId);

    const chip = detail?.knownMaterials.find((m) => m.id === composite.id);
    expect(chip?.label).toBe(composite.label);
    expect(chip?.label).not.toBe(composite.id);
    expect(chip?.subtitle.length).toBeGreaterThan(0);

    // The primordial material keeps its hand-authored name.
    expect(detail?.knownMaterials.find((m) => m.id === 'fibre')?.label).toBe('Fibre');
  });

  it('calls a design what it makes, even when the stored label predates naming', () => {
    // This is the exact shape of the labels the world accumulated: ingredient ids concatenated.
    const { state, agentId, composite } = worldWithLearnedRecipe('mx1a2b3c-fibre');
    const recipe = composeAgentDetail(state, agentId)?.knownRecipes[0];

    expect(recipe?.label).toBe(composite.label);
    expect(recipe?.label).not.toContain('-');
    expect(recipe?.producesMaterialId).toBe(composite.id);
    expect(recipe?.components.map((c) => c.label)).toEqual(['Fibre', 'Resin']);
  });

  it('falls back to the stored label when the material is not in the catalogue', () => {
    // A recipe can be taught by a lineage whose discovery is outside this world's catalogue view.
    const { state, agentId, composite } = worldWithLearnedRecipe('Old Name');
    const withoutMaterial = {
      ...state,
      materials: new Map([...state.materials].filter(([id]) => id !== composite.id)),
    };
    const recipe = composeAgentDetail(withoutMaterial, agentId)?.knownRecipes[0];

    expect(recipe?.label).toBe('Old Name');
  });
});
