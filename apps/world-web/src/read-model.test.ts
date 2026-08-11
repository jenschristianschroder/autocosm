import { describe, expect, it } from 'vitest';
import { DEFAULT_SIMULATION_CONFIG, generateWorld } from '@autocosm/simulation';
import type { WorldState } from '@autocosm/simulation';
import {
  asMaterialId,
  asStructureId,
  BASE_MATERIALS,
  blendProperties,
  combineMaterials,
  deriveRecipeKey,
  deriveStructureFunctions,
  describeStructure,
  initialIntegrity,
  WorldMetaResponseSchema,
  type MaterialComponent,
  type Structure,
} from '@autocosm/domain';
import {
  composeAgentDetail,
  composeStructureDetail,
  composeSnapshot,
  composeWorldMeta,
} from './read-model.js';

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

  // The world stores a composite under the id derived from the blend it produced, which is what
  // makes the recipe -> material join possible at all. Mirror that here rather than inventing an id.
  const composite = combineMaterials(COMPONENTS, state.materials, 4);
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
                  producesMaterialId: composite.id,
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

/**
 * A world with one construction in it.
 *
 * The seeded world builds nothing on tick zero, so a structure has to be planted. It is derived the
 * same way `applyBuild` derives one — authoritative functions and blended properties from the real
 * components — so the projection is exercised against a structure the simulation could actually
 * produce rather than a hand-tuned literal.
 */
function worldWithStructure(): { state: WorldState; structure: Structure } {
  const state = generateWorld({ seed: 90_210, worldId: 'test-world' });
  const organism = [...state.organisms.values()][0];
  if (!organism) throw new Error('seeded world has no organisms');

  const components: readonly MaterialComponent[] = [
    { materialId: asMaterialId('stone'), quantity: 120 },
    { materialId: asMaterialId('chitin'), quantity: 80 },
  ];
  const functions = deriveStructureFunctions(components, 'shell', state.materials);
  const properties = blendProperties(components, state.materials);
  const structure: Structure = {
    id: asStructureId('st-test-0'),
    regionId: organism.regionId,
    position: organism.position,
    pattern: 'shell',
    components,
    functions,
    properties,
    volume: 200,
    integrity: Math.trunc(initialIntegrity(properties) / 2),
    createdByAgentId: organism.agentId,
    createdByLineageId: organism.lineageId,
    createdByOrganismId: organism.id,
    createdAtTick: 10,
    lastChangedAtTick: 12,
    usage: [{ tick: 11, organismId: organism.id, lineageId: organism.lineageId, kind: 'shelter' }],
    label: describeStructure('shell', functions),
  };

  return {
    structure,
    state: { ...state, structures: new Map([[structure.id, structure]]) },
  };
}

describe('composeStructureDetail', () => {
  it('says who built it, in words a spectator can read', () => {
    const { state, structure } = worldWithStructure();
    const detail = composeStructureDetail(state, structure.id);
    const agent = state.agents.get(structure.createdByAgentId);

    expect(detail?.createdByAgentName).toBe(agent?.name);
    expect(detail?.createdByAgentName).not.toBe(structure.createdByAgentId);
    // The hue is what lets the 3D view show ownership without a single click.
    expect(detail?.createdByLineageHue).toBeGreaterThanOrEqual(0);
    expect(detail?.createdByLineageHue).toBeLessThanOrEqual(360);
  });

  it('names what it is made of', () => {
    const { state, structure } = worldWithStructure();
    const detail = composeStructureDetail(state, structure.id);

    expect(detail?.components.map((c) => c.label)).toEqual(['Stone', 'Chitin']);
    for (const component of detail?.components ?? []) {
      expect(component.subtitle.length).toBeGreaterThan(0);
    }
  });

  it('explains each function rather than emitting a bare identifier', () => {
    const { state, structure } = worldWithStructure();
    const detail = composeStructureDetail(state, structure.id);

    expect(detail?.derivedFunctions.length).toBeGreaterThan(0);
    for (const fn of detail?.derivedFunctions ?? []) {
      expect(fn.label, fn.id).not.toBe(fn.id);
      expect(fn.summary.length, fn.id).toBeGreaterThan(10);
      expect(fn.requirement.length, fn.id).toBeGreaterThan(10);
    }
  });

  it('reports what the structure delivers now, not what it delivered when new', () => {
    const { state, structure } = worldWithStructure();
    const detail = composeStructureDetail(state, structure.id);

    // Integrity is halved in the fixture, so every function must be measurably weaker than its
    // nominal rating. A projection that ignored integrity would report them as equal.
    for (const fn of detail?.derivedFunctions ?? []) {
      expect(fn.effectiveMagnitude, fn.id).toBeLessThan(fn.magnitude);
    }
  });

  it('says when the structure will collapse', () => {
    const { state, structure } = worldWithStructure();
    const detail = composeStructureDetail(state, structure.id);

    expect(detail?.decayPerTick).toBeGreaterThanOrEqual(1);
    expect(detail?.collapsesAtTick).toBeGreaterThan(state.world.tick);
    expect(detail?.usage).toHaveLength(1);
  });

  it('returns nothing for an unknown structure rather than a hollow record', () => {
    const { state } = worldWithStructure();
    expect(composeStructureDetail(state, 'st-does-not-exist')).toBeUndefined();
  });
});

describe('snapshot and world catalogue', () => {
  it('carries the builder on the snapshot so ownership is legible without a second request', () => {
    const { state, structure } = worldWithStructure();
    const snapshot = composeSnapshot(state, { regionId: structure.regionId, radius: 1 });
    const dto = snapshot.structures.find((s) => s.id === structure.id);

    expect(dto?.createdByAgentName).toBe(state.agents.get(structure.createdByAgentId)?.name);
    expect(dto?.createdByLineageHue).toBeGreaterThanOrEqual(0);
  });

  it('publishes the material catalogue by name, with ingredients resolved', () => {
    const { state, composite } = worldWithLearnedRecipe('irrelevant');
    const meta = composeWorldMeta(state, { heuristicOnly: false, aiDegraded: false });
    const entry = meta.materials.find((m) => m.id === composite.id);

    expect(entry?.label).toBe(composite.label);
    expect(entry?.subtitle.length).toBeGreaterThan(0);
    expect(entry?.derivedFrom?.map((c) => c.label)).toEqual(['Fibre', 'Resin']);
    // A primordial material has no ingredients, and saying "derived from nothing" would be a lie.
    expect(meta.materials.find((m) => m.id === 'fibre')?.derivedFrom).toBeUndefined();
  });

  it('orders the catalogue stably so the route stays cacheable', () => {
    const { state } = worldWithLearnedRecipe('irrelevant');
    const ids = composeWorldMeta(state, { heuristicOnly: false, aiDegraded: false }).materials.map(
      (m) => m.id,
    );
    expect(ids).toEqual([...ids].sort());
  });

  it('serves a catalogue saturated to the simulation ceiling without dropping any of it', () => {
    // Three bounds have to stay ordered — `maxMaterials` <= `MAX_CATALOGUE_MATERIALS` <= the
    // schema's `.max()` — and they live in three packages. Invert a pair and a full world either
    // loses an arbitrary alphabetical tail (every material in it renders as a raw id, the exact
    // illegibility this catalogue exists to fix) or fails to serve `/world` at all.
    //
    // This asserts the outcome rather than comparing the constants, because comparing constants is
    // what let them drift: `maxMaterials` was raised to 512 and the read-model slice to 576 while
    // the schema stayed at 384, so a world past 384 materials would have failed validation live
    // while every unit test passed. Saturate the world and push it through the real projection.
    const { state } = worldWithLearnedRecipe('irrelevant');
    const base = BASE_MATERIALS[0];
    if (base === undefined) throw new Error('no base materials to clone');

    const saturated = new Map(state.materials);
    let filler = 0;
    while (saturated.size < DEFAULT_SIMULATION_CONFIG.maxMaterials) {
      const id = asMaterialId(`mxfill${(filler++).toString(36).padStart(6, '0')}`);
      saturated.set(id, { ...base, id });
    }

    const meta = composeWorldMeta(
      { ...state, materials: saturated },
      { heuristicOnly: false, aiDegraded: false },
    );

    expect(meta.materials).toHaveLength(DEFAULT_SIMULATION_CONFIG.maxMaterials);
    expect(() => WorldMetaResponseSchema.parse(meta)).not.toThrow();
  });
});
