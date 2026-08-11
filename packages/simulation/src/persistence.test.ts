import { describe, expect, it } from 'vitest';
import { TRAIT_IDS } from '@autocosm/domain';
import { generateWorld } from './worldgen.js';
import { advanceTick } from './tick.js';
import { fromRecords, toRecords } from './persistence.js';
import { sortedIds, type WorldState } from './state.js';

/**
 * The persistence projection is the seam between the deterministic tick engine and Azure Tables.
 * If a round trip through records loses or reshapes anything the tick reads, the simulation stops
 * being replayable across job executions — so these tests assert byte-for-byte behavioural
 * equality, not merely "no exception thrown".
 */

const SEED = 91_017;

function run(state: WorldState, ticks: number): WorldState {
  let next = state;
  for (let i = 0; i < ticks; i += 1) next = advanceTick(next).state;
  return next;
}

/**
 * A deep fingerprint covering every field the tick engine reads back.
 *
 * Four of these accessors previously named fields that do not exist — `pressure.untilTick`,
 * `calendar.dayLengthTicks`, `calendar.light`, `calendar.heat` — plus `region.temperature` and
 * `region.light`. Each stringified to `undefined`, so the round-trip could have dropped the calendar
 * and the pressure window entirely and this test would still have passed. Test files were excluded
 * from `tsc`, so nothing caught it; `tsconfig.tests.json` now checks them.
 */
function fingerprint(state: WorldState): string {
  const parts: string[] = [
    `tick:${state.world.tick}`,
    `seed:${state.world.seed}`,
    `pressure:${state.world.pressure.kind}@${state.world.pressure.startedAtTick}-${state.world.pressure.endsAtTick}:${state.world.pressure.severity}`,
    `calendar:${state.world.calendar.ticksPerDay}/${state.world.calendar.ticksPerPressureCycle}/${state.world.calendar.simulatedMinutesPerTick}`,
    `stats:${JSON.stringify(state.world.stats)}`,
    `signals:${state.signals
      .map((s) => `${s.organismId}:${s.channel}:${s.intensity}:${s.recipe?.key ?? '-'}`)
      .join(',')}`,
  ];
  for (const id of sortedIds(state.organisms)) {
    const o = state.organisms.get(id);
    if (!o) continue;
    parts.push(
      [
        o.id,
        o.alive ? 1 : 0,
        o.energy,
        o.health,
        o.ageTicks,
        o.position.x,
        o.position.z,
        o.regionId,
        o.inventory.map((e) => `${e.materialId}:${e.quantity}`).join(','),
        TRAIT_IDS.map((t) => o.genotype[t]).join('.'),
        JSON.stringify(o.lifetime),
      ].join('|'),
    );
  }
  for (const id of sortedIds(state.structures)) {
    const s = state.structures.get(id);
    if (!s) continue;
    parts.push(
      [
        s.id,
        s.integrity,
        s.components.map((c) => `${c.materialId}:${c.quantity}`).join(','),
        s.functions.map((f) => `${f.id}=${f.magnitude}`).join('+'),
        s.usage.length,
      ].join('|'),
    );
  }
  for (const id of sortedIds(state.materials)) {
    const m = state.materials.get(id);
    if (!m) continue;
    parts.push(
      [m.id, m.origin, JSON.stringify(m.properties), m.derivedFrom?.length ?? 0].join('|'),
    );
  }
  for (const id of sortedIds(state.resources)) {
    const r = state.resources.get(id);
    if (!r) continue;
    parts.push([r.id, r.quantity, r.materialId].join('|'));
  }
  for (const id of sortedIds(state.regions)) {
    const r = state.regions.get(id);
    if (!r) continue;
    parts.push(
      [r.id, r.biome, r.biomass, r.mineralRichness, r.baseTemperature, r.lightModifier].join('|'),
    );
  }
  for (const id of sortedIds(state.agents)) {
    const a = state.agents.get(id);
    if (!a) continue;
    parts.push(
      [
        a.id,
        a.status,
        JSON.stringify(a.drives),
        [...a.knowledge.knownMaterialIds].join(','),
        a.knowledge.recipes
          .map(
            (r) =>
              `${r.key}:${r.label}>${r.producesMaterialId ?? '-'}#${r.components.length}` +
              `<${r.learnedFromLineageId ?? '-'}`,
          )
          .join('+'),
        [...a.knowledge.knownStructureIds].join(','),
        (state.memories.get(a.id) ?? []).map((m) => `${m.id}:${m.salience}:${m.note}`).join(';'),
        (state.goals.get(a.id) ?? []).map((g) => `${g.id}:${g.status}`).join(';'),
      ].join('|'),
    );
  }
  for (const id of sortedIds(state.lineages)) {
    const l = state.lineages.get(id);
    if (!l) continue;
    parts.push(
      [l.id, l.generations, l.livingCount, l.births, l.deaths, l.extinctAtTick ?? '-'].join('|'),
    );
  }
  for (const id of sortedIds(state.lineageNodes)) {
    const n = state.lineageNodes.get(id);
    if (!n) continue;
    parts.push([n.organismId, n.parentOrganismId ?? '-', n.generation, n.bornAtTick].join('|'));
  }
  return parts.join('\n');
}

describe('world persistence projection', () => {
  it('round trips a freshly generated world without loss', () => {
    const state = generateWorld({ seed: SEED, worldId: 'w-persist' });
    const restored = fromRecords(toRecords(state));
    expect(fingerprint(restored)).toBe(fingerprint(state));
  });

  it('round trips a world that has evolved, built and signalled', { timeout: 60_000 }, () => {
    const state = run(generateWorld({ seed: SEED, worldId: 'w-persist' }), 160);
    // Guard against a vacuous assertion: the world must actually contain the interesting shapes.
    expect(state.structures.size).toBeGreaterThan(0);
    expect([...state.materials.values()].some((m) => m.origin === 'composite')).toBe(true);
    expect([...state.agents.values()].some((a) => a.knowledge.recipes.length > 0)).toBe(true);

    const restored = fromRecords(toRecords(state));
    expect(fingerprint(restored)).toBe(fingerprint(state));
  });

  it(
    'replays identically after a round trip, proving a job restart is invisible',
    { timeout: 60_000 },
    () => {
      const start = run(generateWorld({ seed: SEED, worldId: 'w-persist' }), 100);

      const continuous = run(start, 40);
      const viaStorage = run(fromRecords(toRecords(start)), 40);

      expect(fingerprint(viaStorage)).toBe(fingerprint(continuous));
    },
  );

  it('survives repeated round trips between every tick', { timeout: 60_000 }, () => {
    let continuous = generateWorld({ seed: SEED, worldId: 'w-persist' });
    let chunked = generateWorld({ seed: SEED, worldId: 'w-persist' });
    for (let i = 0; i < 40; i += 1) {
      continuous = advanceTick(continuous).state;
      chunked = advanceTick(fromRecords(toRecords(chunked))).state;
    }
    expect(fingerprint(chunked)).toBe(fingerprint(continuous));
  });

  it('does not persist terrain, deriving it from the seed instead', () => {
    const state = generateWorld({ seed: SEED, worldId: 'w-persist' });
    const bundle = toRecords(state);
    expect(JSON.stringify(bundle)).not.toContain('terrain');

    const restored = fromRecords(bundle);
    for (const organism of state.organisms.values()) {
      expect(restored.terrain.elevationAtPosition(organism.position)).toBe(
        state.terrain.elevationAtPosition(organism.position),
      );
    }
  });

  it(
    'produces records that are all stamped with the current record version',
    { timeout: 60_000 },
    () => {
      const bundle = toRecords(run(generateWorld({ seed: SEED, worldId: 'w-persist' }), 80));
      const versions = new Set<number>();
      for (const value of Object.values(bundle)) {
        for (const record of Array.isArray(value) ? value : [value]) {
          versions.add((record as { rv: number }).rv);
        }
      }
      expect([...versions]).toEqual([1]);
    },
  );

  it('rejects a corrupted record rather than loading an invalid world', () => {
    const bundle = toRecords(generateWorld({ seed: SEED, worldId: 'w-persist' }));
    const corrupted: typeof bundle = {
      ...bundle,
      organisms: bundle.organisms.map((o, i) => (i === 0 ? { ...o, energy: Number.NaN } : o)),
    };
    expect(() => fromRecords(corrupted)).toThrow();
  });

  it('loads a lineage persisted before drift was tracked', () => {
    // The exact shape of the outage in `9ebfbe3`: adding a *required* field to a record schema
    // rejects every row already in production and takes the world down with a 500. A lineage
    // written before `foundingGenotype` existed must still load, anchored to where it stands now.
    const bundle = toRecords(generateWorld({ seed: SEED, worldId: 'w-persist' }));
    const legacy: typeof bundle = {
      ...bundle,
      lineages: bundle.lineages.map((lineage) => {
        const { foundingGenotype: _dropped, ...rest } = lineage;
        return rest;
      }),
    };

    const restored = fromRecords(legacy);
    expect(restored.lineages.size).toBe(bundle.lineages.length);
    for (const lineage of restored.lineages.values()) {
      expect(lineage.foundingGenotype).toStrictEqual(lineage.meanGenotype);
    }
  });

  it('re-keys a recipe stored under the old material-identity scheme', () => {
    // Splitting `mx` (a substance) from `rx` (a procedure) changed what `deriveRecipeKey` returns.
    // A stored key is a cache of a pure function, so a stale one is not merely cosmetic: the
    // `some(r => r.key === key)` dedupe in `learnRecipe` would miss it and the agent would end up
    // holding the same procedure twice, once under each scheme.
    const bundle = toRecords(generateWorld({ seed: SEED, worldId: 'w-persist' }));
    const first = bundle.agents[0];
    if (!first) throw new Error('expected a generated agent');

    const components = [
      { materialId: 'mat-fibre', quantity: 2 },
      { materialId: 'mat-chitin', quantity: 3 },
    ];
    const legacy: typeof bundle = {
      ...bundle,
      agents: bundle.agents.map((agent) =>
        agent === first
          ? {
              ...agent,
              knowledge: {
                ...agent.knowledge,
                // The same procedure recorded twice: once under the superseded key, once fresh.
                recipes: [
                  { key: 'mxdeadbe', label: 'Legacy weave', components, learnedAtTick: 4 },
                  {
                    key: 'rx0000ff',
                    label: 'Legacy weave',
                    components,
                    producesMaterialId: 'mat-fibre',
                    learnedAtTick: 9,
                  },
                ],
              },
            }
          : agent,
      ),
    };

    const restored = fromRecords(legacy);
    const agent = [...restored.agents.values()].find((a) => a.id === first.id);
    if (!agent) throw new Error('expected the agent to load');

    expect(agent.knowledge.recipes).toHaveLength(1);
    const recipe = agent.knowledge.recipes[0];
    if (!recipe) throw new Error('expected the collapsed recipe');
    expect(recipe.key.startsWith('rx')).toBe(true);
    // Keep-first, matching `learnRecipe`: the earliest record of the procedure survives.
    expect(recipe.learnedAtTick).toBe(4);
  });

  it('keeps what a recipe produces across a round trip', () => {
    // `producesMaterialId` reached the in-memory type and the DTO before it reached the record
    // schema, which made it write-only: set on discovery, gone on the next hydrate, with the read
    // model silently falling back to the stored label forever. Zod strips unknown keys, so nothing
    // failed — the field simply evaporated.
    const bundle = toRecords(generateWorld({ seed: SEED, worldId: 'w-persist' }));
    const first = bundle.agents[0];
    if (!first) throw new Error('expected a generated agent');

    const withProduct: typeof bundle = {
      ...bundle,
      agents: bundle.agents.map((agent) =>
        agent === first
          ? {
              ...agent,
              knowledge: {
                ...agent.knowledge,
                recipes: [
                  {
                    key: 'rxignored',
                    label: 'Bound Resinweave',
                    components: [
                      { materialId: 'mat-fibre', quantity: 2 },
                      { materialId: 'mat-resin', quantity: 1 },
                    ],
                    producesMaterialId: 'mx1a2b3c',
                    learnedAtTick: 11,
                    learnedFromLineageId: 'ln-weavers',
                  },
                ],
              },
            }
          : agent,
      ),
    };

    const restored = fromRecords(withProduct);
    const recipe = [...restored.agents.values()].find((a) => a.id === first.id)?.knowledge
      .recipes[0];
    if (!recipe) throw new Error('expected the recipe to load');
    expect(recipe.producesMaterialId).toBe('mx1a2b3c');
    expect(recipe.learnedFromLineageId).toBe('ln-weavers');

    // And it must survive the write side too, which carries its own structural type.
    const rewritten = toRecords(restored).agents.find((a) => a.id === first.id);
    expect(rewritten?.knowledge.recipes[0]?.producesMaterialId).toBe('mx1a2b3c');
  });
});
