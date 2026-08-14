import { describe, expect, it } from 'vitest';
import {
  BASE_MATERIALS,
  REACTION_IDS,
  biomeForElevation,
  combineMaterials,
  reactionsForComponents,
  type Biome,
  type MaterialDefinition,
  type MaterialId,
} from '@autocosm/domain';
import { generateWorld } from './worldgen.js';

/*
 * Can the world supply what the world requires?
 *
 * This file exists because of a defect that no other test could see. `lightCrystal` is listed in
 * exactly one biome palette, `ridge`; `ridge` requires a region-mean elevation that the terrain
 * generator's own averaging made unreachable; so the material had **zero deposits in every world
 * ever generated**. It is the only base material carrying photosensitivity and conductivity
 * together, which are the two drivers of `phosphorescing` — a reaction that had therefore never
 * once been the best available combination in any organism's inventory, in any sampled tick, in
 * any world.
 *
 * Every layer above this looked healthy. `reactions.test.ts` proves the photosensitivity rules work
 * — using `lightCrystal` as its fixture, so the suite was validating chemistry the world could not
 * supply. The material catalogue listed it. The glossary explained it. The biome enum declared
 * `ridge`, and the persistence, API and observation schemas all carried it.
 *
 * The invariants below are deliberately about *supply*, not about mechanism: a rule that fires
 * correctly on a constructed fixture is worth nothing if its ingredients never spawn.
 */

// Enough seeds to speak about rare terrain: `ridge` is the rarest biome in the world and is
// expected in only a small handful of these.
const SEEDS = [
  4242424, 91017, 7, 555, 20260101, 31337, 1, 999, 123456, 2026, 31, 64, 1024, 77777, 300, 20250101,
  8675309, 42, 101, 5150,
];

const ALL_BIOMES: readonly Biome[] = ['abyss', 'shallows', 'shore', 'plain', 'highland', 'ridge'];

/**
 * `water` is the world's only `fluid` and is environmental rather than gatherable — it is not a
 * deposit an organism walks up to and collects. Every other base material must be obtainable, or it
 * is catalogue decoration.
 */
const NOT_A_DEPOSIT = new Set(['water']);

interface WorldCensus {
  readonly biomes: ReadonlySet<Biome>;
  readonly nodeMaterials: ReadonlySet<string>;
}

function censusOf(seed: number): WorldCensus {
  const state = generateWorld({ seed, worldId: `w-reach-${seed}` });
  const biomes = new Set<Biome>();
  for (const region of state.regions.values()) biomes.add(region.biome);
  const nodeMaterials = new Set<string>();
  for (const node of state.resources.values()) nodeMaterials.add(String(node.materialId));
  return { biomes, nodeMaterials };
}

describe('world reachability', () => {
  const censuses = SEEDS.map((seed) => censusOf(seed));

  it('classifies every declared biome in some generated world', () => {
    const seen = new Set<Biome>();
    for (const census of censuses) for (const biome of census.biomes) seen.add(biome);
    const missing = ALL_BIOMES.filter((b) => !seen.has(b));
    expect(
      missing,
      `biome(s) declared but never generated across ${SEEDS.length} seeds: ${missing.join(', ')}. ` +
        'A biome the classifier cannot produce takes its whole material palette down with it.',
    ).toEqual([]);
  });

  it('keeps every biome threshold inside the range region means actually reach', () => {
    // `biomeForElevation` is fed a region *mean*, so the reachable input range is the range of
    // region means — not the range of point elevations, which is far wider. Classifying from means
    // while calibrating against points is precisely how `ridge` became unreachable.
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const seed of SEEDS) {
      const state = generateWorld({ seed, worldId: `w-reach-${seed}` });
      for (const region of state.regions.values()) {
        min = Math.min(min, region.meanElevationCu);
        max = Math.max(max, region.meanElevationCu);
      }
    }
    const reachable = new Set<Biome>();
    for (let e = Math.floor(min); e <= Math.ceil(max); e += 10) reachable.add(biomeForElevation(e));
    const unreachable = ALL_BIOMES.filter((b) => !reachable.has(b));
    expect(
      unreachable,
      `region means span ${min}..${max}, which no elevation classifies as: ` +
        `${unreachable.join(', ')}`,
    ).toEqual([]);
  });

  it('spawns a deposit of every gatherable base material in most worlds', () => {
    // Deliberately per-world, not aggregated. Asking only whether a material spawns *somewhere*
    // across the seed set hides the case that actually bit: sourcing `lightCrystal` from `ridge`
    // alone satisfies "somewhere" — ridge exists in 2 of these 20 worlds — while leaving 90% of
    // worlds without it. Availability is a property of the world a spectator is looking at.
    const worldsWith = new Map<string, number>();
    for (const census of censuses) {
      for (const id of census.nodeMaterials) worldsWith.set(id, (worldsWith.get(id) ?? 0) + 1);
    }
    const floor = Math.ceil(SEEDS.length / 2);
    const expected = BASE_MATERIALS.map((m) => String(m.id)).filter((id) => !NOT_A_DEPOSIT.has(id));
    const scarce = expected
      .map((id) => ({ id, worlds: worldsWith.get(id) ?? 0 }))
      .filter((entry) => entry.worlds < floor);
    expect(
      scarce.map((e) => `${e.id} (${e.worlds}/${SEEDS.length})`),
      `base material(s) absent from more than half of ${SEEDS.length} worlds, so effectively ` +
        'catalogue decoration for most spectators',
    ).toEqual([]);
  });

  it('makes every reaction driver reachable from materials that actually spawn', () => {
    // Combination closure over only those base materials a world genuinely produces deposits of.
    // Reachability in the abstract is not the property that matters; reachability from the ground
    // an organism can stand on is.
    const spawned = new Set<string>();
    for (const census of censuses) for (const id of census.nodeMaterials) spawned.add(id);
    const gatherable = BASE_MATERIALS.filter((m) => spawned.has(String(m.id)));
    expect(gatherable.length).toBeGreaterThan(0);

    const catalogue = new Map<MaterialId, MaterialDefinition>();
    for (const m of gatherable) catalogue.set(m.id, m);
    const fired = new Set<string>();
    const ratios: readonly (readonly [number, number])[] = [
      [50, 50],
      [75, 25],
      [25, 75],
    ];
    let frontier: MaterialDefinition[] = [...gatherable];
    const all: MaterialDefinition[] = [...gatherable];

    for (let generation = 0; generation < 2; generation += 1) {
      const produced: MaterialDefinition[] = [];
      outer: for (const a of frontier) {
        for (const b of all) {
          if (a.id === b.id) continue;
          for (const [qa, qb] of ratios) {
            const components = [
              { materialId: a.id, quantity: qa },
              { materialId: b.id, quantity: qb },
            ];
            for (const reaction of reactionsForComponents(components, catalogue)) {
              fired.add(reaction);
            }
            const result = combineMaterials(components, catalogue, 0);
            if (!result || catalogue.has(result.id)) continue;
            catalogue.set(result.id, result);
            produced.push(result);
            if (produced.length >= 250) break outer;
          }
        }
      }
      all.push(...produced);
      frontier = produced;
    }

    const never = REACTION_IDS.filter((id) => !fired.has(id));
    expect(
      never,
      `reaction(s) that no combination of spawnable materials can trigger: ${never.join(', ')}`,
    ).toEqual([]);
  });

  it('leaves more than a single route to the photosensitivity reactions in most worlds', () => {
    // The sharpest form of the original defect. `phosphorescing` needs photosensitivity and
    // conductivity above 250 together. With `lightCrystal` unobtainable, exactly **one** material
    // in a four-generation closure cleared both — reachable on paper, and never once observed in
    // an inventory, because the only route ran through two base materials whose biome palettes are
    // disjoint (`algaeMat` in shallows/shore, `mineralSalt` in abyss/highland). A lone route is
    // indistinguishable from no route at world scale.
    //
    // Measured per world for the same reason as the supply test above: a median taken over worlds
    // cannot be rescued by one unusually rich seed.
    const counts = censuses.map((census) => {
      const gatherable = BASE_MATERIALS.filter((m) => census.nodeMaterials.has(String(m.id)));
      const catalogue = new Map<MaterialId, MaterialDefinition>();
      for (const m of gatherable) catalogue.set(m.id, m);
      const produced: MaterialDefinition[] = [];
      for (const a of gatherable) {
        for (const b of gatherable) {
          if (a.id === b.id) continue;
          for (const [qa, qb] of [
            [50, 50],
            [75, 25],
            [25, 75],
          ] as const) {
            const result = combineMaterials(
              [
                { materialId: a.id, quantity: qa },
                { materialId: b.id, quantity: qb },
              ],
              catalogue,
              0,
            );
            if (!result || catalogue.has(result.id)) continue;
            catalogue.set(result.id, result);
            produced.push(result);
          }
        }
      }
      return [...gatherable, ...produced].filter(
        (m) => m.properties.photosensitivity > 250 && m.properties.conductivity > 250,
      ).length;
    });

    const sorted = [...counts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    expect(
      median,
      `the median world offers only ${median} single-combination material(s) clearing both ` +
        `phosphorescing drivers (per-world counts: ${sorted.join(', ')}); that is the signature ` +
        'of the driver-carrying base material being unobtainable again',
    ).toBeGreaterThan(1);
  });
});
