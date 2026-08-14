import { describe, expect, it } from 'vitest';
import {
  asMaterialId,
  combineMaterials,
  derivePhenotype,
  deriveRecipeKey,
  scaleByPerMille,
  type AgentId,
  type KnownRecipe,
  type Organism,
  type OrganismId,
  type Signal,
  type WorldEvent,
} from '@autocosm/domain';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import { resolveAction, EnergyLedger, type ResolutionContext } from './resolve.js';
import { EventSink } from './events.js';
import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import { toDraft, sortedIds, type WorldState } from './state.js';
import { toRecords, fromRecords } from './persistence.js';

/**
 * A recipe's identity is its content, never its display label.
 *
 * Teaching used to resolve a recipe by string equality on its label, which meant any change to how
 * materials are named would silently sever cultural transmission and diverge replay — with no test
 * failing. These tests pin the invariant so naming stays free to change.
 */

const SEED = 4_242_424;
const HORIZON = 500;

const run = ((): { state: WorldState; events: WorldEvent[] } => {
  let state = generateWorld({ seed: SEED, worldId: 'w-recipe' });
  const events: WorldEvent[] = [];
  for (let i = 0; i < HORIZON; i += 1) {
    const result = advanceTick(state);
    events.push(...result.events);
    state = result.state;
  }
  return { state, events };
})();

function context(state: WorldState): ResolutionContext {
  const draft = toDraft(state);
  const events = new EventSink(draft.world.id, draft.world.tick);
  return { draft, config: DEFAULT_SIMULATION_CONFIG, events, ledger: new EnergyLedger() };
}

/** Intensity every staged teach signal is emitted at. */
const TEACH_INTENSITY = 600;

/**
 * A living organism that knows a recipe, has evolved a usable signal, and can afford to emit one.
 *
 * Nothing guarantees the world hands one over. Recipes are discovered by whichever lineage happens
 * to combine two materials first, and that lineage can be extinct by any given tick — at seed
 * 4242424 / tick 500 every one of the 56 survivors belongs to an agent that has never learned a
 * recipe. Searching for a naturally-occurring teacher therefore pins these tests to the whole
 * simulation's trajectory, which any behaviour change perturbs, and they have broken that way twice.
 *
 * So the subject is *constructed*: a living, signal-capable organism is chosen, and its agent is
 * granted a recipe that the world genuinely discovered, plus the energy to emit it. Both are
 * transient state, not evolved capability — the organism must still have evolved a signal on its
 * own, because `availableActions` gates the action and no fixture may forge that. The recipe stays
 * content-addressed by `deriveRecipeKey`, which is the property under test.
 */
function findTeacher(state: WorldState): {
  state: WorldState;
  organismId: OrganismId;
  recipeKey: string;
} {
  const signalCost = Math.max(1, scaleByPerMille(6, TEACH_INTENSITY));

  const discovered = [...state.agents.values()].flatMap((a) => a.knowledge.recipes)[0];
  if (!discovered) throw new Error('the world discovered no recipe to teach');

  for (const id of sortedIds(state.organisms)) {
    const organism = state.organisms.get(id);
    if (!organism?.alive) continue;
    if (derivePhenotype(organism.genotype).signalRadiusCu <= 0) continue;
    const agent = state.agents.get(organism.agentId);
    if (!agent) continue;

    const recipe = agent.knowledge.recipes[0] ?? discovered;
    const agents = new Map(state.agents);
    agents.set(agent.id, {
      ...agent,
      knowledge: { ...agent.knowledge, recipes: [recipe, ...agent.knowledge.recipes.slice(1)] },
    });
    const organisms = new Map(state.organisms);
    organisms.set(id, { ...organism, energy: Math.max(organism.energy, signalCost * 4) });

    return {
      state: { ...state, agents, organisms },
      organismId: organism.id,
      recipeKey: recipe.key,
    };
  }
  throw new Error('no living organism has evolved a signal');
}

/**
 * Stages a teach signal that a non-kin listener is guaranteed to be standing inside.
 *
 * Lineages in a generated world settle far enough apart that no organism has ever been within
 * earshot of a non-kin teacher, so cross-lineage transmission cannot be observed by running the
 * world forward. That distance is a spatial balance question, not a recipe-identity one, so this
 * fixture supplies the geometry directly and lets `advanceTick` exercise the real propagation path.
 */
function stageTeaching(state: WorldState): {
  state: WorldState;
  recipe: KnownRecipe;
  teacherId: OrganismId;
  listenerId: OrganismId;
  listenerAgentId: AgentId;
} {
  const { state: staged, organismId } = findTeacher(state);
  const teacher = staged.organisms.get(organismId);
  if (!teacher) throw new Error('teacher vanished');
  const recipe = staged.agents.get(teacher.agentId)?.knowledge.recipes[0];
  if (!recipe) throw new Error('teacher knows no recipe');

  // The healthiest non-kin organism, so metabolism cannot kill it before the propagation sweep.
  let listener: Organism | undefined;
  for (const id of sortedIds(staged.organisms)) {
    const candidate = staged.organisms.get(id);
    if (!candidate?.alive || candidate.agentId === teacher.agentId) continue;
    if (derivePhenotype(candidate.genotype).memorySlots < 1) continue;
    if (!listener || candidate.energy > listener.energy) listener = candidate;
  }
  if (!listener) throw new Error('no non-kin organism can hold a memory');

  const organisms = new Map(staged.organisms);
  organisms.set(listener.id, { ...listener, position: teacher.position });

  // Propagation reads the listener's position *after* the tick's actions resolve, so a radius of
  // one cu only works while the listener happens not to move — which is a property of the whole
  // simulation's trajectory, not of recipe identity. Sizing the radius to a single step keeps the
  // listener inside it whatever it decides to do, while staying orders of magnitude below the
  // distance to any other organism, so no unintended listener is caught.
  const listenerReach = Math.max(
    1,
    Math.ceil(derivePhenotype(listener.genotype).speedCuPerTick) + 1,
  );

  const signal: Signal = {
    organismId: teacher.id,
    lineageId: teacher.lineageId,
    agentId: teacher.agentId,
    position: teacher.position,
    regionId: teacher.regionId,
    channel: 'teach',
    intensity: TEACH_INTENSITY,
    radiusCu: listenerReach,
    // Emitted by the tick that is about to run, which is when propagation considers it.
    emittedAtTick: state.world.tick + 1,
    recipe,
  };

  return {
    state: { ...staged, organisms, signals: [signal] },
    recipe,
    teacherId: teacher.id,
    listenerId: listener.id,
    listenerAgentId: listener.agentId,
  };
}

/**
 * The `knowledgeShared` events produced by *this* staged teaching, and no others.
 *
 * These assertions used to count every `knowledgeShared` event in the world, which was only ever
 * correct while ambient transmission produced none — the state the roadmap recorded for the whole
 * life of the project. Directed combination gave agents deep, usable recipe trees, other organisms
 * started teaching and inspecting on their own, and the counts became 3 and 2 against expectations
 * of 1 and 0. The assertion was never about the world; it is about one staged teacher reaching one
 * staged listener, so it is scoped to the recipe and the organism that carried it.
 */
function sharedByStagedTeaching(
  events: readonly WorldEvent[],
  staged: { recipe: KnownRecipe; teacherId: OrganismId },
): readonly WorldEvent[] {
  return events.filter(
    (e) =>
      e.kind === 'knowledgeShared' &&
      e.organismId === staged.teacherId &&
      (e.payload as { recipeKey?: string } | undefined)?.recipeKey === staged.recipe.key,
  );
}

describe('recipe identity', () => {
  const { state, events } = run;

  it('accumulates recipes by discovery', () => {
    const learned = [...state.agents.values()].flatMap((a) => a.knowledge.recipes);
    expect(learned.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'materialDiscovered')).toBe(true);
  });

  it('transmits a recipe to a listener in earshot, matched by key not label', () => {
    const staged = stageTeaching(state);
    const before = staged.state.agents.get(staged.listenerAgentId);
    expect(before?.knowledge.recipes.some((r) => r.key === staged.recipe.key)).toBe(false);

    const result = advanceTick(staged.state);

    const shared = sharedByStagedTeaching(result.events, staged);
    expect(shared.length).toBe(1);
    expect(shared[0]?.payload).toMatchObject({ recipeKey: staged.recipe.key });

    const learned = result.state.agents
      .get(staged.listenerAgentId)
      ?.knowledge.recipes.find((r) => r.key === staged.recipe.key);
    expect(learned).toBeDefined();
    expect(learned?.learnedFromLineageId).toBe(staged.state.signals[0]?.lineageId);
    expect(learned?.components).toEqual(staged.recipe.components);
  });

  it('does not re-teach a recipe the listener already holds under another label', () => {
    // Dedupe must key off content. Were it label-based, a later renaming phase would let the same
    // recipe be learned twice and inflate every agent's bounded recipe list.
    const staged = stageTeaching(state);
    const listenerAgentId = staged.listenerAgentId;
    const agents = new Map(staged.state.agents);
    const agent = agents.get(listenerAgentId);
    if (!agent) throw new Error('listener has no agent');
    agents.set(listenerAgentId, {
      ...agent,
      knowledge: {
        ...agent.knowledge,
        recipes: [...agent.knowledge.recipes, { ...staged.recipe, label: 'a-different-name' }],
      },
    });

    const result = advanceTick({ ...staged.state, agents });

    expect(sharedByStagedTeaching(result.events, staged)).toHaveLength(0);
    const matching = result.state.agents
      .get(listenerAgentId)
      ?.knowledge.recipes.filter((r) => r.key === staged.recipe.key);
    expect(matching).toHaveLength(1);
    expect(matching?.[0]?.label).toBe('a-different-name');
  });

  it('identifies a recipe by its ingredients and records what it makes', () => {
    // This assertion used to read `state.materials.get(asMaterialId(recipe.key))` — resolving a
    // recipe key as a material id. That was sound only while one hash served both, and splitting
    // substance (`mx`, derived from physical properties) from procedure (`rx`, derived from the
    // ingredient list) makes it structurally impossible. The two namespaces are now disjoint by
    // construction, which is why a recipe has to carry `producesMaterialId` to say what it makes
    // rather than having the answer read out of its own identity.
    //
    // Note what this cannot assert: that the product's `derivedFrom` equals the recipe's
    // components. The mapping is deliberately many-to-one — the same two ingredients at a
    // different ratio land in the same property bucket and are therefore the same substance, so a
    // material records whichever procedure discovered it first, not the one being examined here.
    // The invariant that does hold is the one that matters: re-running the combination reproduces
    // the identity the recipe claims.
    let checked = 0;
    for (const agent of state.agents.values()) {
      for (const recipe of agent.knowledge.recipes) {
        expect(recipe.key).toBe(deriveRecipeKey(recipe.components));
        expect(recipe.key.startsWith('rx')).toBe(true);
        // A procedure is not a substance: its key must never name a material.
        expect(state.materials.get(asMaterialId(recipe.key))).toBeUndefined();

        const producedId = recipe.producesMaterialId;
        expect(producedId).toBeDefined();
        if (!producedId) continue;
        expect(state.materials.get(producedId)).toBeDefined();

        const remade = combineMaterials(recipe.components, state.materials, state.world.tick);
        expect(remade?.id).toBe(producedId);
        checked += 1;
      }
    }
    // Guard against the whole loop being vacuous, which is how an assertion silently stops testing.
    expect(checked).toBeGreaterThan(0);
  });

  it('teaches by key even after every label has been rewritten', () => {
    const { state: staged, organismId, recipeKey } = findTeacher(state);
    const ctx = context(staged);
    for (const [agentId, agent] of ctx.draft.agents) {
      ctx.draft.agents.set(agentId, {
        ...agent,
        knowledge: {
          ...agent.knowledge,
          recipes: agent.knowledge.recipes.map((r) => ({
            ...r,
            label: 'renamed-by-a-later-phase',
          })),
        },
      });
    }

    const result = resolveAction(ctx, organismId, {
      type: 'signal',
      channel: 'teach',
      intensity: 600,
      recipeKey,
    });

    expect(result.accepted).toBe(true);
    const signal = ctx.draft.signals.at(-1);
    expect(signal?.channel).toBe('teach');
    expect(signal?.recipe?.key).toBe(recipeKey);
  });

  it('rejects a teach signal naming a recipe the agent does not know', () => {
    const { state: staged, organismId } = findTeacher(state);
    const result = resolveAction(context(staged), organismId, {
      type: 'signal',
      channel: 'teach',
      intensity: 600,
      recipeKey: 'mx-never-discovered',
    });
    expect(result.accepted).toBe(false);
    expect(result.accepted ? undefined : result.reason).toBe('unknownTarget');
  });

  it('holds one recipe per content, however its ingredients were ordered', () => {
    for (const agent of state.agents.values()) {
      const keys = agent.knowledge.recipes.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
      // Deduplication must survive re-ordered ingredients, which the key normalises away.
      for (const recipe of agent.knowledge.recipes) {
        expect(deriveRecipeKey([...recipe.components].reverse())).toBe(recipe.key);
      }
    }
  });

  it('restores the key of a recipe stored before recipes were content-addressed', () => {
    // A live world contains records written without `key`. Rejecting them would strand the world,
    // and defaulting them to a placeholder would silently break teaching. The key is a pure
    // function of the components the old record already carries, so it is recomputed on read.
    const bundle = toRecords(state);
    const legacy = {
      ...bundle,
      agents: bundle.agents.map((agent) => ({
        ...agent,
        knowledge: {
          ...agent.knowledge,
          recipes: agent.knowledge.recipes.map(({ key: _dropped, ...rest }) => rest),
        },
      })),
    };
    expect(legacy.agents.some((a) => a.knowledge.recipes.length > 0)).toBe(true);

    const restored = fromRecords(legacy as unknown as Parameters<typeof fromRecords>[0]);

    let checked = 0;
    for (const [agentId, agent] of restored.agents) {
      const original = state.agents.get(agentId);
      expect(agent.knowledge.recipes).toEqual(original?.knowledge.recipes);
      for (const recipe of agent.knowledge.recipes) {
        expect(recipe.key).toBe(deriveRecipeKey(recipe.components));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
