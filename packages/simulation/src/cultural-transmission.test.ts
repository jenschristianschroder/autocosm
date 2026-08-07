import { describe, expect, it } from 'vitest';
import {
  derivePhenotype,
  deriveRecipeKey,
  type MaterialDefinition,
  type Organism,
  type Structure,
} from '@autocosm/domain';

import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import { EnergyLedger, resolveAction, type ResolutionContext } from './resolve.js';
import { EventSink } from './events.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import { toDraft, type WorldState } from './state.js';

/**
 * Knowledge must be able to cross a lineage boundary through a built object.
 *
 * Two places in the simulation already documented this as the design: `observe` grants a structure
 * a long-range landmark bonus because "without this bonus, built objects are effectively invisible
 * in a world this size and knowledge could never cross a lineage boundary", and the heuristic's
 * inspect branch calls itself "how knowledge crosses a lineage boundary". Neither was true.
 * Inspection learned a construction's *materials* and never how any of them were made, and a
 * composite material cannot be gathered — only combined — so its id alone buys almost nothing.
 *
 * Teaching by signal cannot carry culture by itself. Measured over 600 ticks, an organism saw any
 * non-kin organism at all on 0.54% of its turns on one trajectory, and on none of 47,067 turns on
 * another. A building does not have to be met: it stands for over a thousand ticks after its
 * builder is dead and stays legible at landmark range, so it carries knowledge across distance and
 * across time, which is what separates culture from a conversation.
 *
 * These tests pin the mechanism rather than a trajectory. A generated world hands over this
 * conjunction — a foreign, uninspected structure built from a composite, in sight of an organism
 * that can retain what it learns — roughly never, so the geometry is *constructed*, exactly as the
 * recipe-identity suite constructs its teacher and for the same reason. What is asserted is the
 * rule: study a foreign artefact made of something you cannot dig up, and you learn how it was
 * made. How often a world produces that meeting is a separate, measured question.
 */

const TIMEOUT_MS = 120_000;

function context(state: WorldState): ResolutionContext {
  const draft = toDraft(state);
  const events = new EventSink(draft.world.id, draft.world.tick);
  return { draft, config: DEFAULT_SIMULATION_CONFIG, events, ledger: new EnergyLedger() };
}

/** A world advanced far enough to have discovered at least one composite material. */
function worldWithComposite(): { state: WorldState; composite: MaterialDefinition } {
  let state = generateWorld({ seed: 4_242_424, worldId: 'w-culture' });
  for (let index = 0; index < 600; index += 1) {
    state = advanceTick(state).state;
    const composite = [...state.materials.values()].find(
      (m) => m.derivedFrom !== undefined && m.derivedFrom.length > 0,
    );
    if (composite) return { state, composite };
  }
  throw new Error('no composite material was discovered within the horizon');
}

interface Staged {
  readonly state: WorldState;
  readonly organism: Organism;
  readonly structure: Structure;
}

/**
 * Puts a memory-capable organism in sight of a structure raised by a different lineage.
 *
 * The structure is placed at the observer's own position so visibility is unambiguous: this suite
 * is about what studying an artefact teaches, and `applyInspect` already rejects anything beyond
 * `structureVisibilityRadiusCu`, which the observation model tests cover.
 */
function stageForeignStructure(
  state: WorldState,
  composite: MaterialDefinition,
  options: { readonly memorySlots?: number } = {},
): Staged {
  const candidate = [...state.organisms.values()]
    .filter((o) => o.alive && derivePhenotype(o.genotype).memorySlots >= 1)
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!candidate) throw new Error('no living organism can retain what it learns');

  const organism: Organism = { ...candidate, energy: 4000 };
  const organisms = new Map(state.organisms);
  organisms.set(organism.id, organism);

  // A lineage that is definitively not the observer's, so `builtByOwnLineage` cannot be true.
  const foreignLineage = `${organism.lineageId}-foreign` as Structure['createdByLineageId'];
  const foreignAgent = `${organism.agentId}-foreign` as Structure['createdByAgentId'];

  const structure: Structure = {
    id: 'st-foreign-artefact' as Structure['id'],
    label: 'Foreign lattice',
    pattern: 'lattice',
    regionId: organism.regionId,
    position: organism.position,
    volume: 240,
    integrity: 900,
    components: [{ materialId: composite.id, quantity: 60 }],
    properties: composite.properties,
    functions: [],
    usage: [],
    createdByAgentId: foreignAgent,
    createdByLineageId: foreignLineage,
    createdByOrganismId: `${organism.id}-foreign` as Structure['createdByOrganismId'],
    createdAtTick: state.world.tick,
    lastChangedAtTick: state.world.tick,
  };

  const structures = new Map(state.structures);
  structures.set(structure.id, structure);

  let next: WorldState = { ...state, organisms, structures };

  if (options.memorySlots === 0) {
    // Cleared on the genotype the phenotype derives it from, not on the phenotype: capability must
    // remain a property of the body, never something a fixture forges.
    const stripped = stripMemory(organism);
    const withStripped = new Map(next.organisms);
    withStripped.set(stripped.id, stripped);
    next = { ...next, organisms: withStripped };
    return { state: next, organism: stripped, structure };
  }

  return { state: next, organism, structure };
}

/** Reduces an organism's memory capacity to zero so it cannot retain a recipe. */
function stripMemory(organism: Organism): Organism {
  return { ...organism, genotype: { ...organism.genotype, memoryCapacity: 0 } };
}

describe('cultural transmission through artefacts', () => {
  it(
    'teaches the recipe a foreign construction is made of',
    () => {
      const { state, composite } = worldWithComposite();
      const staged = stageForeignStructure(state, composite);
      const ctx = context(staged.state);

      const derivedFrom = composite.derivedFrom;
      expect(derivedFrom).toBeDefined();
      if (!derivedFrom) return;
      const key = deriveRecipeKey(derivedFrom);

      // The control: without this, an agent that already knew the recipe would pass vacuously.
      const before = ctx.draft.agents.get(staged.organism.agentId);
      expect(before?.knowledge.recipes.some((r) => r.key === key)).toBe(false);

      const result = resolveAction(ctx, staged.organism.id, {
        type: 'inspect',
        targetKind: 'structure',
        targetId: staged.structure.id,
      });
      expect(result.accepted).toBe(true);

      const after = ctx.draft.agents.get(staged.organism.agentId);
      const learned = after?.knowledge.recipes.find((r) => r.key === key);
      expect(learned).toBeDefined();
      expect(learned?.components).toEqual(derivedFrom);
      // Attribution names the builder, so a recipe's origin reads the same however it travelled.
      expect(learned?.learnedFromLineageId).toBe(staged.structure.createdByLineageId);

      const events = ctx.events.drain();
      const shared = events.find((e) => e.kind === 'knowledgeShared');
      expect(shared).toBeDefined();
      expect(shared?.payload).toMatchObject({
        recipeKey: key,
        toLineageIds: [staged.organism.lineageId],
      });
    },
    TIMEOUT_MS,
  );

  it(
    'still learns the material itself, so inspection never loses ground',
    () => {
      const { state, composite } = worldWithComposite();
      const staged = stageForeignStructure(state, composite);
      const ctx = context(staged.state);

      resolveAction(ctx, staged.organism.id, {
        type: 'inspect',
        targetKind: 'structure',
        targetId: staged.structure.id,
      });

      const after = ctx.draft.agents.get(staged.organism.agentId);
      expect(after?.knowledge.knownMaterialIds).toContain(composite.id);
      expect(after?.knowledge.knownStructureIds).toContain(staged.structure.id);
    },
    TIMEOUT_MS,
  );

  it(
    'transfers nothing to an organism that cannot remember',
    () => {
      const { state, composite } = worldWithComposite();
      const staged = stageForeignStructure(state, composite, { memorySlots: 0 });
      expect(derivePhenotype(staged.organism.genotype).memorySlots).toBe(0);

      const ctx = context(staged.state);
      const derivedFrom = composite.derivedFrom;
      if (!derivedFrom) return;
      const key = deriveRecipeKey(derivedFrom);

      resolveAction(ctx, staged.organism.id, {
        type: 'inspect',
        targetKind: 'structure',
        targetId: staged.structure.id,
      });

      const after = ctx.draft.agents.get(staged.organism.agentId);
      expect(after?.knowledge.recipes.some((r) => r.key === key)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'does not re-learn a recipe the agent already holds',
    () => {
      const { state, composite } = worldWithComposite();
      const staged = stageForeignStructure(state, composite);
      const ctx = context(staged.state);

      const inspect = {
        type: 'inspect',
        targetKind: 'structure',
        targetId: staged.structure.id,
      } as const;

      // `drain` reads the tick's buffer without clearing it, so repetition is measured by counting
      // rather than by expecting an empty second read.
      const shared = (): number =>
        ctx.events.drain().filter((e) => e.kind === 'knowledgeShared').length;

      resolveAction(ctx, staged.organism.id, inspect);
      const afterFirst = ctx.draft.agents.get(staged.organism.agentId);
      const count = afterFirst?.knowledge.recipes.length ?? 0;
      const announced = shared();
      expect(count).toBeGreaterThan(0);
      expect(announced).toBeGreaterThan(0);

      resolveAction(ctx, staged.organism.id, inspect);
      const afterSecond = ctx.draft.agents.get(staged.organism.agentId);
      expect(afterSecond?.knowledge.recipes.length).toBe(count);
      expect(shared()).toBe(announced);
    },
    TIMEOUT_MS,
  );
});
