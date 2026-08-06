import { describe, expect, it } from 'vitest';
import { asOrganismId, type WorldEvent } from '@autocosm/domain';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';
import { resolveAction, EnergyLedger, type ResolutionContext } from './resolve.js';
import { EventSink } from './events.js';
import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import { toDraft, sortedIds, type WorldState } from './state.js';

/**
 * The seeded world has to be *interesting* on first load, not merely valid. These tests assert
 * the emergent behaviour the product promises: lineages that feed, reproduce, signal, build
 * persistent things, and discover each other's creations.
 *
 * The simulation is deterministic, so these are exact assertions about one seed rather than
 * statistical hopes. If a balance change breaks the story the world tells, they fail.
 */

const SEED = 4_242_424;
const HORIZON = 500;

const run = ((): { state: WorldState; events: WorldEvent[] } => {
  let state = generateWorld({ seed: SEED, worldId: 'w-eco' });
  const events: WorldEvent[] = [];
  for (let i = 0; i < HORIZON; i += 1) {
    const result = advanceTick(state);
    events.push(...result.events);
    state = result.state;
  }
  return { state, events };
})();

const kinds = new Set(run.events.map((e) => e.kind));
const countOf = (kind: string): number => run.events.filter((e) => e.kind === kind).length;

describe('seeded biosphere', () => {
  const { state, events } = run;

  it('starts with eight lineages spread across the world', () => {
    const founding = [...state.lineages.values()].filter((l) => l.foundedAtTick === 0);
    expect(founding.length).toBe(8);
    const regions = new Set(founding.map((l) => l.originRegionId));
    expect(regions.size).toBeGreaterThan(1);
  });

  it('generates a full region grid with resource nodes and materials', () => {
    expect(state.regions.size).toBe(64);
    expect(state.resources.size).toBeGreaterThan(200);
    expect(state.materials.size).toBeGreaterThanOrEqual(10);
  });

  it('keeps most lineages alive over five hundred ticks', () => {
    const alive = new Set(
      [...state.organisms.values()].filter((o) => o.alive).map((o) => o.lineageId),
    );
    expect(alive.size).toBeGreaterThanOrEqual(6);
  });

  it('sustains a population rather than collapsing or exploding', () => {
    const living = [...state.organisms.values()].filter((o) => o.alive);
    expect(living.length).toBeGreaterThan(20);
    expect(living.length).toBeLessThan(DEFAULT_SIMULATION_CONFIG.maxOrganismsProcessedPerTick);
  });

  it('produces births, deaths, feeding and migration', () => {
    for (const required of ['organismBorn', 'organismDied', 'organismFed', 'organismMigrated']) {
      expect(kinds.has(required), `expected a ${required} event`).toBe(true);
    }
    expect(countOf('organismBorn')).toBeGreaterThan(50);
    expect(countOf('organismDied')).toBeGreaterThan(50);
  });

  it('applies periodic environmental pressure', () => {
    expect(kinds.has('environmentalPressure')).toBe(true);
  });

  it('discovers and combines materials found in the world', () => {
    expect(countOf('materialDiscovered')).toBeGreaterThan(0);
    expect(countOf('materialCombined')).toBeGreaterThan(0);
  });

  it('builds persistent structures from discovered materials', () => {
    const built = events.filter((e) => e.kind === 'structureBuilt');
    expect(built.length).toBeGreaterThan(0);

    // More than one lineage must reach the manipulation and memory thresholds, otherwise
    // construction is an accident of one archetype rather than an evolved capability.
    const builders = new Set(built.map((e) => e.lineageId));
    expect(builders.size).toBeGreaterThan(1);

    const structure = [...state.structures.values()][0];
    expect(structure).toBeDefined();
    if (!structure) return;
    expect(structure.components.length).toBeGreaterThan(0);
    expect(structure.createdByLineageId).toBeTruthy();
    expect(structure.volume).toBeGreaterThan(0);

    // Function derivation is asserted across the world, not on this arbitrary sample. A structure
    // whose materials miss every threshold in FUNCTION_RULES is a designed outcome — describeStructure
    // renders it as `inert <pattern>` — and roughly half of everything built is inert, so sampling one
    // structure tests which one happened to be first, not whether derivation works.
    const withFunctions = [...state.structures.values()].filter((s) => s.functions.length > 0);
    expect(withFunctions.length).toBeGreaterThan(0);
  });

  it('lets a different lineage discover another lineage’s creation', () => {
    const builtBy = new Map<string, string | undefined>();
    for (const event of events) {
      if (event.kind !== 'structureBuilt') continue;
      const payload = event.payload as { structureId: string };
      builtBy.set(payload.structureId, event.lineageId);
    }
    const crossLineage = events.filter((event) => {
      if (event.kind !== 'structureUsed') return false;
      const payload = event.payload as { structureId: string };
      const owner = builtBy.get(payload.structureId);
      return owner !== undefined && owner !== event.lineageId;
    });
    expect(crossLineage.length).toBeGreaterThan(0);
  });

  it('spreads knowledge only through experience or teaching, never by magic', () => {
    for (const agent of state.agents.values()) {
      for (const recipe of agent.knowledge.recipes) {
        // A recipe is stamped with the tick it was learned; nothing arrives pre-loaded.
        expect(recipe.learnedAtTick).toBeGreaterThan(0);
      }
    }
    // Founding agents start with no structural knowledge at all.
    const fresh = generateWorld({ seed: SEED, worldId: 'w-fresh' });
    for (const agent of fresh.agents.values()) {
      expect(agent.knowledge.recipes).toEqual([]);
      expect(agent.knowledge.knownStructureIds).toEqual([]);
    }
  });

  it('evolves genomes away from their founding values', () => {
    const fresh = generateWorld({ seed: SEED, worldId: 'w-fresh' });
    let drifted = false;
    let deepened = false;
    for (const lineage of state.lineages.values()) {
      if (lineage.generations > 1) deepened = true;
      const original = fresh.lineages.get(lineage.id);
      if (!original) continue;
      for (const key of Object.keys(
        lineage.meanGenotype,
      ) as (keyof typeof lineage.meanGenotype)[]) {
        if (lineage.meanGenotype[key] !== original.meanGenotype[key]) drifted = true;
      }
    }
    expect(deepened).toBe(true);
    expect(drifted).toBe(true);
  });

  it('emits only bounded, attributable events', () => {
    for (const event of events) {
      expect(event.worldId).toBe('w-eco');
      expect(event.tick).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(event.payload).length).toBeLessThan(2048);
      expect(event.summary.length).toBeLessThanOrEqual(160);
    }
  });
});

describe('action rejection', () => {
  function context(state: WorldState): ResolutionContext {
    const draft = toDraft(state);
    const events = new EventSink(draft.world.id, draft.world.tick);
    return { draft, config: DEFAULT_SIMULATION_CONFIG, events, ledger: new EnergyLedger() };
  }

  const world = generateWorld({ seed: SEED, worldId: 'w-reject' });
  const actorId = sortedIds(world.organisms)[0];
  if (actorId === undefined) throw new Error('no organisms');

  it('rejects an attack on a non-existent target', () => {
    const result = resolveAction(context(world), actorId, {
      type: 'attack',
      targetOrganismId: 'or-does-not-exist',
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('unknownTarget');
  });

  it('rejects an attack on itself', () => {
    const result = resolveAction(context(world), actorId, {
      type: 'attack',
      targetOrganismId: actorId,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('selfTarget');
  });

  it('rejects sharing with an out-of-range organism', () => {
    const self = world.organisms.get(actorId);
    expect(self).toBeDefined();
    if (!self) return;
    const far = sortedIds(world.organisms).find((id) => {
      const other = world.organisms.get(id);
      if (!other) return false;
      return Math.abs(other.position.x - self.position.x) > 20_000;
    });
    expect(far).toBeDefined();
    if (far === undefined) return;
    const result = resolveAction(context(world), actorId, {
      type: 'share',
      targetOrganismId: far,
      energy: 5,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('outOfRange');
  });

  it('rejects an action the organism has not evolved the capability for', () => {
    const ctx = context(world);
    const organism = ctx.draft.organisms.get(actorId);
    expect(organism).toBeDefined();
    if (!organism) return;
    ctx.draft.organisms.set(actorId, {
      ...organism,
      genotype: { ...organism.genotype, manipulation: 0, appendages: 0 },
    });
    const result = resolveAction(ctx, actorId, {
      type: 'build',
      pattern: 'shell',
      components: [{ materialId: 'stone', quantity: 200 }],
      label: 'impossible',
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('capabilityNotEvolved');
  });

  it('rejects an unknown organism outright', () => {
    const result = resolveAction(context(world), asOrganismId('or-ghost'), { type: 'rest' });
    expect(result.accepted).toBe(false);
  });

  it('rejects building from material the organism is not carrying', () => {
    const ctx = context(world);
    const organism = ctx.draft.organisms.get(actorId);
    expect(organism).toBeDefined();
    if (!organism) return;
    // Give it the body for the job but an empty inventory.
    ctx.draft.organisms.set(actorId, {
      ...organism,
      genotype: { ...organism.genotype, manipulation: 1000, appendages: 900, memoryCapacity: 900 },
      inventory: [],
    });
    const result = resolveAction(ctx, actorId, {
      type: 'build',
      pattern: 'shell',
      components: [{ materialId: 'stone', quantity: 200 }],
      label: 'castle in the air',
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('insufficientMaterial');
  });

  it('never lets a rejected action change world state', () => {
    const ctx = context(world);
    const before = JSON.stringify([...ctx.draft.organisms.values()]);
    resolveAction(ctx, actorId, { type: 'attack', targetOrganismId: 'or-does-not-exist' });
    resolveAction(ctx, actorId, {
      type: 'consume',
      targetKind: 'resourceNode',
      targetId: 'rn-nope',
    });
    resolveAction(ctx, actorId, { type: 'inspect', targetKind: 'structure', targetId: 'st-nope' });
    const after = JSON.stringify([...ctx.draft.organisms.values()]);
    expect(after).toEqual(before);
    expect(ctx.events.drain().length).toBe(0);
  });
});
