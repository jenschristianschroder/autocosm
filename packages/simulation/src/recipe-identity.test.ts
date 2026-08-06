import { describe, expect, it } from 'vitest';
import {
  derivePhenotype,
  deriveRecipeKey,
  type KnownRecipe,
  type Organism,
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

/** A living organism whose agent knows at least one recipe and has evolved a usable signal. */
function findTeacher(state: WorldState): { organismId: string; recipeKey: string } {
  for (const id of sortedIds(state.organisms)) {
    const organism = state.organisms.get(id);
    if (!organism?.alive) continue;
    if (derivePhenotype(organism.genotype).signalRadiusCu <= 0) continue;
    const recipe = state.agents.get(organism.agentId)?.knowledge.recipes[0];
    if (recipe) return { organismId: id, recipeKey: recipe.key };
  }
  throw new Error('no organism with an evolved signal knows a recipe');
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
  listenerId: string;
} {
  const { organismId } = findTeacher(state);
  const teacher = state.organisms.get(organismId);
  if (!teacher) throw new Error('teacher vanished');
  const recipe = state.agents.get(teacher.agentId)?.knowledge.recipes[0];
  if (!recipe) throw new Error('teacher knows no recipe');

  // The healthiest non-kin organism, so metabolism cannot kill it before the propagation sweep.
  let listener: Organism | undefined;
  for (const id of sortedIds(state.organisms)) {
    const candidate = state.organisms.get(id);
    if (!candidate?.alive || candidate.agentId === teacher.agentId) continue;
    if (derivePhenotype(candidate.genotype).memorySlots < 1) continue;
    if (!listener || candidate.energy > listener.energy) listener = candidate;
  }
  if (!listener) throw new Error('no non-kin organism can hold a memory');

  const organisms = new Map(state.organisms);
  organisms.set(listener.id, { ...listener, position: teacher.position });

  const signal: Signal = {
    organismId: teacher.id,
    lineageId: teacher.lineageId,
    agentId: teacher.agentId,
    position: teacher.position,
    regionId: teacher.regionId,
    channel: 'teach',
    intensity: 600,
    radiusCu: 1,
    // Emitted by the tick that is about to run, which is when propagation considers it.
    emittedAtTick: state.world.tick + 1,
    recipe,
  };

  return {
    state: { ...state, organisms, signals: [signal] },
    recipe,
    listenerId: listener.id,
  };
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
    const before = staged.state.agents.get(
      staged.state.organisms.get(staged.listenerId)?.agentId ?? '',
    );
    expect(before?.knowledge.recipes.some((r) => r.key === staged.recipe.key)).toBe(false);

    const result = advanceTick(staged.state);

    const shared = result.events.filter((e) => e.kind === 'knowledgeShared');
    expect(shared.length).toBe(1);
    expect(shared[0]?.payload).toMatchObject({ recipeKey: staged.recipe.key });

    const listener = result.state.organisms.get(staged.listenerId);
    const learned = result.state.agents
      .get(listener?.agentId ?? '')
      ?.knowledge.recipes.find((r) => r.key === staged.recipe.key);
    expect(learned).toBeDefined();
    expect(learned?.learnedFromLineageId).toBe(staged.state.signals[0]?.lineageId);
    expect(learned?.components).toEqual(staged.recipe.components);
  });

  it('does not re-teach a recipe the listener already holds under another label', () => {
    // Dedupe must key off content. Were it label-based, a later renaming phase would let the same
    // recipe be learned twice and inflate every agent's bounded recipe list.
    const staged = stageTeaching(state);
    const listenerAgentId = staged.state.organisms.get(staged.listenerId)?.agentId ?? '';
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

    expect(result.events.filter((e) => e.kind === 'knowledgeShared')).toHaveLength(0);
    const matching = result.state.agents
      .get(listenerAgentId)
      ?.knowledge.recipes.filter((r) => r.key === staged.recipe.key);
    expect(matching).toHaveLength(1);
    expect(matching?.[0]?.label).toBe('a-different-name');
  });

  it('keys every recipe by the material it produces', () => {
    for (const agent of state.agents.values()) {
      for (const recipe of agent.knowledge.recipes) {
        expect(recipe.key).toBe(deriveRecipeKey(recipe.components));
        const produced = state.materials.get(recipe.key);
        expect(produced).toBeDefined();
        expect(produced?.derivedFrom).toEqual(recipe.components);
      }
    }
  });

  it('teaches by key even after every label has been rewritten', () => {
    const { organismId, recipeKey } = findTeacher(state);
    const ctx = context(state);
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
    const { organismId } = findTeacher(state);
    const result = resolveAction(context(state), organismId, {
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
