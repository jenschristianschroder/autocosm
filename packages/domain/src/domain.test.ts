import { describe, expect, it } from 'vitest';
import {
  BASE_MATERIALS,
  BASE_MATERIAL_IDS,
  CU_PER_UNIT,
  CreateAgentRequestSchema,
  DEFAULT_CALENDAR,
  DeterministicIdFactory,
  FixedClock,
  HistoryQuerySchema,
  MATERIAL_PROPERTY_IDS,
  MIN_STRUCTURE_VOLUME,
  PER_MILLE,
  Prng,
  REGION_GRID,
  REGION_SPAN_CU,
  SnapshotQuerySchema,
  SubmitGoalRequestSchema,
  TICKS_PER_EPOCH,
  TRAIT_IDS,
  WORLD_SPAN_CU,
  allRegionIds,
  ambientLightPerMille,
  asAgentId,
  asId,
  asMaterialId,
  axisDelta,
  blendProperties,
  clamp,
  clampPerMille,
  combineMaterials,
  complexityScore,
  dayPhasePerMille,
  decayPerTick,
  derivePhenotype,
  deriveStructureFunctions,
  deriveVisual,
  describeStructure,
  distance,
  effectiveTrait,
  epochOfTick,
  hashSeed,
  indexMaterials,
  initialIntegrity,
  isPressureBoundary,
  isValidId,
  isqrt,
  lerpPerMille,
  makePosition,
  normaliseGenotype,
  pressureCycleIndex,
  recordUsage,
  regionCentre,
  regionCoordFromId,
  regionCoordOf,
  regionIdAt,
  regionIdOf,
  regionNeighbourhood,
  scaleByPerMille,
  seedGenotype,
  stepToward,
  tickKey,
  toInt,
  totalVolume,
  withinRadius,
  wrapAxis,
  type Genotype,
  type MaterialComponent,
  type StructureUsage,
  type TraitId,
} from './index.js';

/**
 * Domain primitives.
 *
 * These are the foundations every other package builds on: integer units, the seeded
 * generator, toroidal geometry, logical time, material blending, structure derivation and
 * the public request schemas. The simulation suite proves emergent behaviour; this suite
 * proves the arithmetic underneath it, where an off-by-one silently corrupts every tick.
 */

/* -------------------------------------------------------------------------- */
/* Units                                                                       */
/* -------------------------------------------------------------------------- */

describe('units', () => {
  it('clamps into range and collapses NaN to the lower bound', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    // A NaN that propagated through a tick would poison every downstream value.
    expect(clamp(Number.NaN, 3, 10)).toBe(3);
  });

  it('keeps per-mille values inside [0, 1000] and integral', () => {
    expect(clampPerMille(-5)).toBe(0);
    expect(clampPerMille(5000)).toBe(PER_MILLE);
    expect(clampPerMille(499.9)).toBe(499);
    expect(clampPerMille(Number.NaN)).toBe(0);
  });

  it('never produces NaN or Infinity from toInt', () => {
    expect(toInt(3.9)).toBe(3);
    expect(toInt(-3.9)).toBe(-3);
    expect(toInt(Number.NaN)).toBe(0);
    expect(toInt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toInt(Number.NEGATIVE_INFINITY, 7)).toBe(7);
  });

  it('scales by a per-mille ratio using integer arithmetic', () => {
    expect(scaleByPerMille(200, 500)).toBe(100);
    expect(scaleByPerMille(200, 0)).toBe(0);
    expect(scaleByPerMille(200, PER_MILLE)).toBe(200);
    // Ratios above the scale are clamped rather than amplifying the value.
    expect(scaleByPerMille(200, 5000)).toBe(200);
  });

  it('interpolates on the per-mille scale', () => {
    expect(lerpPerMille(0, 100, 0)).toBe(0);
    expect(lerpPerMille(0, 100, 1000)).toBe(100);
    expect(lerpPerMille(0, 100, 500)).toBe(50);
    expect(lerpPerMille(100, 0, 500)).toBe(50);
  });

  it('computes an exact integer square root', () => {
    for (const n of [0, 1, 2, 3, 4, 15, 16, 17, 1023, 1024, 1_000_000]) {
      const root = isqrt(n);
      expect(root).toBe(Math.floor(Math.sqrt(n)));
      expect(root * root).toBeLessThanOrEqual(n);
      expect((root + 1) * (root + 1)).toBeGreaterThan(n);
    }
    expect(isqrt(-9)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* PRNG                                                                        */
/* -------------------------------------------------------------------------- */

describe('seeded generator', () => {
  it('produces an identical stream for an identical seed', () => {
    const a = new Prng(12_345);
    const b = new Prng(12_345);
    const left = Array.from({ length: 64 }, () => a.nextUint32());
    const right = Array.from({ length: 64 }, () => b.nextUint32());
    expect(left).toEqual(right);
  });

  it('produces a different stream for a different seed', () => {
    const a = Array.from(
      { length: 32 },
      (
        (p) => () =>
          p.nextUint32()
      )(new Prng(1)),
    );
    const b = Array.from(
      { length: 32 },
      (
        (p) => () =>
          p.nextUint32()
      )(new Prng(2)),
    );
    expect(a).not.toEqual(b);
  });

  it('stays inside the unsigned 32-bit range', () => {
    const prng = new Prng(7);
    for (let i = 0; i < 500; i += 1) {
      const value = prng.nextUint32();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xff_ff_ff_ff);
    }
  });

  it('bounds nextInt and handles an empty range', () => {
    const prng = new Prng(99);
    for (let i = 0; i < 500; i += 1) {
      const value = prng.nextInt(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
    expect(prng.nextInt(0)).toBe(0);
    expect(prng.nextInt(-4)).toBe(0);
  });

  it('bounds nextRange inclusively and tolerates an inverted range', () => {
    const prng = new Prng(31);
    for (let i = 0; i < 500; i += 1) {
      const value = prng.nextRange(-5, 5);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThanOrEqual(5);
    }
    expect(prng.nextRange(4, 4)).toBe(4);
    expect(prng.nextRange(9, 2)).toBe(9);
  });

  it('treats chance boundaries as certainties', () => {
    const prng = new Prng(5);
    expect(prng.chance(0)).toBe(false);
    expect(prng.chance(-100)).toBe(false);
    expect(prng.chance(1000)).toBe(true);
    expect(prng.chance(4000)).toBe(true);
  });

  it('produces a roughly calibrated chance over many draws', () => {
    const prng = new Prng(2024);
    let hits = 0;
    for (let i = 0; i < 20_000; i += 1) if (prng.chance(250)) hits += 1;
    // Deterministic input, so this is an exactness check on a known-good generator, not a
    // flaky statistical test: the band is wide enough to survive any correct implementation.
    expect(hits).toBeGreaterThan(4_400);
    expect(hits).toBeLessThan(5_600);
  });

  it('picks only elements of the supplied array and nothing from an empty one', () => {
    const prng = new Prng(64);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 100; i += 1) {
      expect(items).toContain(prng.pick(items));
    }
    expect(prng.pick([])).toBeUndefined();
  });

  it('forks reproducible but independent streams', () => {
    const first = new Prng(808).fork('organism');
    const second = new Prng(808).fork('organism');
    const other = new Prng(808).fork('structure');
    expect(first.nextUint32()).toBe(second.nextUint32());
    expect(new Prng(808).fork('organism').nextUint32()).not.toBe(other.nextUint32());
  });

  it('hashes seeds stably and distinguishes part boundaries', () => {
    expect(hashSeed('world', 12, 'org-1')).toBe(hashSeed('world', 12, 'org-1'));
    expect(hashSeed('world', 12, 'org-1')).not.toBe(hashSeed('world', 13, 'org-1'));
    // A delimiter is mixed in per part, so concatenation cannot collide with separate parts.
    expect(hashSeed('ab', 'c')).not.toBe(hashSeed('a', 'bc'));
    expect(hashSeed('x')).toBeGreaterThanOrEqual(0);
    expect(hashSeed('x')).toBeLessThanOrEqual(0xff_ff_ff_ff);
  });
});

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

describe('identifiers', () => {
  it('accepts the permitted alphabet and rejects everything else', () => {
    expect(isValidId('abc-123_XYZ')).toBe(true);
    expect(isValidId('')).toBe(false);
    expect(isValidId('has space')).toBe(false);
    expect(isValidId('slash/es')).toBe(false);
    expect(isValidId('a'.repeat(65))).toBe(false);
  });

  it('throws rather than branding an invalid string', () => {
    expect(() => asAgentId('good-id')).not.toThrow();
    expect(() => asId('bad id')).toThrow(RangeError);
    // The thrown message must not echo an unbounded untrusted string back to a log.
    try {
      asId('x'.repeat(500));
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(140);
    }
  });

  it('generates identifiers that are a pure function of world, tick and namespace', () => {
    const a = new DeterministicIdFactory('world', 42);
    const b = new DeterministicIdFactory('world', 42);
    expect(a.next('org')).toBe(b.next('org'));
    expect(a.next('org')).toBe(b.next('org'));
    // Counters are per namespace, so interleaving cannot shift another namespace's ordinals.
    expect(a.next('evt')).toBe(b.next('evt'));
    expect(new DeterministicIdFactory('world', 43).next('org')).not.toBe(
      new DeterministicIdFactory('world', 42).next('org'),
    );
  });

  it('produces identifiers that are themselves valid identifiers', () => {
    const factory = new DeterministicIdFactory('autocosm', 7);
    for (let i = 0; i < 20; i += 1) {
      expect(isValidId(factory.next('memory'))).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

describe('toroidal geometry', () => {
  it('wraps rather than clamps at the world edge', () => {
    expect(wrapAxis(0)).toBe(0);
    expect(wrapAxis(WORLD_SPAN_CU)).toBe(0);
    expect(wrapAxis(WORLD_SPAN_CU + 5)).toBe(5);
    expect(wrapAxis(-1)).toBe(WORLD_SPAN_CU - 1);
    expect(wrapAxis(-WORLD_SPAN_CU - 3)).toBe(WORLD_SPAN_CU - 3);
  });

  it('takes the short way round when measuring displacement', () => {
    expect(axisDelta(10, 40)).toBe(30);
    expect(axisDelta(40, 10)).toBe(-30);
    // Across the seam: 10 cu apart, not WORLD_SPAN_CU - 10.
    expect(axisDelta(5, WORLD_SPAN_CU - 5)).toBe(-10);
    expect(axisDelta(WORLD_SPAN_CU - 5, 5)).toBe(10);
  });

  it('measures distance across the seam', () => {
    const a = makePosition(5, 5);
    const b = makePosition(WORLD_SPAN_CU - 5, 5);
    expect(distance(a, b)).toBe(10);
    expect(withinRadius(a, b, 10)).toBe(true);
    expect(withinRadius(a, b, 9)).toBe(false);
  });

  it('steps toward a target without overshooting', () => {
    const origin = makePosition(0, 0);
    const target = makePosition(1000, 0);
    const stepped = stepToward(origin, target, 300);
    expect(stepped.x).toBe(300);
    expect(stepped.z).toBe(0);
    // A step longer than the gap lands exactly on the target rather than past it.
    expect(stepToward(origin, target, 5000)).toEqual(target);
    expect(stepToward(origin, target, 0)).toEqual(origin);
    expect(stepToward(origin, origin, 100)).toEqual(origin);
  });

  it('never lets a step leave the world', () => {
    const prng = new Prng(4242);
    for (let i = 0; i < 400; i += 1) {
      const from = makePosition(prng.nextInt(WORLD_SPAN_CU), prng.nextInt(WORLD_SPAN_CU));
      const to = makePosition(prng.nextInt(WORLD_SPAN_CU), prng.nextInt(WORLD_SPAN_CU));
      const next = stepToward(from, to, prng.nextRange(1, 900));
      expect(next.x).toBeGreaterThanOrEqual(0);
      expect(next.x).toBeLessThan(WORLD_SPAN_CU);
      expect(next.z).toBeGreaterThanOrEqual(0);
      expect(next.z).toBeLessThan(WORLD_SPAN_CU);
    }
  });

  it('maps every position to exactly one region of the lattice', () => {
    expect(allRegionIds()).toHaveLength(REGION_GRID * REGION_GRID);
    expect(new Set(allRegionIds()).size).toBe(REGION_GRID * REGION_GRID);

    const prng = new Prng(77);
    const ids = new Set(allRegionIds().map(String));
    for (let i = 0; i < 400; i += 1) {
      const position = makePosition(prng.nextInt(WORLD_SPAN_CU), prng.nextInt(WORLD_SPAN_CU));
      expect(ids.has(String(regionIdOf(position)))).toBe(true);
    }
  });

  it('round trips a region id through its coordinates', () => {
    for (let row = 0; row < REGION_GRID; row += 1) {
      for (let col = 0; col < REGION_GRID; col += 1) {
        const id = regionIdAt(col, row);
        expect(regionCoordFromId(id)).toEqual({ col, row });
        // The centre of a region must map back to that same region.
        expect(regionIdOf(regionCentre({ col, row }))).toBe(id);
      }
    }
  });

  it('rejects a malformed or out-of-range region id', () => {
    expect(regionCoordFromId('nonsense')).toBeNull();
    expect(regionCoordFromId('r1')).toBeNull();
    expect(regionCoordFromId(`r${REGION_GRID}x0`)).toBeNull();
  });

  it('wraps region coordinates so the lattice has no edge', () => {
    expect(regionIdAt(-1, -1)).toBe(regionIdAt(REGION_GRID - 1, REGION_GRID - 1));
    expect(regionIdAt(REGION_GRID, REGION_GRID)).toBe(regionIdAt(0, 0));
  });

  it('gives every region exactly nine neighbours including itself', () => {
    for (const id of allRegionIds()) {
      const neighbourhood = regionNeighbourhood(id);
      expect(neighbourhood).toHaveLength(9);
      expect(neighbourhood).toContain(id);
      expect(new Set(neighbourhood).size).toBe(9);
    }
  });

  it('keeps the region grid consistent with the world span', () => {
    expect(REGION_SPAN_CU * REGION_GRID).toBe(WORLD_SPAN_CU);
    expect(WORLD_SPAN_CU % CU_PER_UNIT).toBe(0);
    const corner = makePosition(0, 0);
    expect(regionCoordOf(corner)).toEqual({ col: 0, row: 0 });
    expect(regionCoordOf(makePosition(WORLD_SPAN_CU - 1, WORLD_SPAN_CU - 1))).toEqual({
      col: REGION_GRID - 1,
      row: REGION_GRID - 1,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Logical time                                                                */
/* -------------------------------------------------------------------------- */

describe('logical time', () => {
  it('cycles the day phase and never leaves [0, 1000)', () => {
    const { ticksPerDay } = DEFAULT_CALENDAR;
    expect(dayPhasePerMille(0, DEFAULT_CALENDAR)).toBe(0);
    expect(dayPhasePerMille(ticksPerDay, DEFAULT_CALENDAR)).toBe(0);
    expect(dayPhasePerMille(ticksPerDay / 2, DEFAULT_CALENDAR)).toBe(500);
    for (let tick = 0; tick < ticksPerDay * 3; tick += 1) {
      const phase = dayPhasePerMille(tick, DEFAULT_CALENDAR);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1000);
    }
  });

  it('keeps ambient light bounded with a starlight floor', () => {
    let min = 1001;
    let max = -1;
    for (let tick = 0; tick < DEFAULT_CALENDAR.ticksPerDay * 2; tick += 1) {
      const light = ambientLightPerMille(tick, DEFAULT_CALENDAR);
      min = Math.min(min, light);
      max = Math.max(max, light);
    }
    expect(min).toBeGreaterThanOrEqual(60);
    expect(max).toBeLessThanOrEqual(1000);
    // Noon is brighter than midnight, which is what makes photosynthesis a real tradeoff.
    expect(
      ambientLightPerMille(DEFAULT_CALENDAR.ticksPerDay / 2, DEFAULT_CALENDAR),
    ).toBeGreaterThan(ambientLightPerMille(0, DEFAULT_CALENDAR));
  });

  it('marks pressure boundaries once per cycle and never at tick zero', () => {
    const { ticksPerPressureCycle } = DEFAULT_CALENDAR;
    expect(isPressureBoundary(0, DEFAULT_CALENDAR)).toBe(false);
    expect(isPressureBoundary(ticksPerPressureCycle, DEFAULT_CALENDAR)).toBe(true);
    expect(isPressureBoundary(ticksPerPressureCycle + 1, DEFAULT_CALENDAR)).toBe(false);
    expect(pressureCycleIndex(ticksPerPressureCycle * 2 + 3, DEFAULT_CALENDAR)).toBe(2);
  });

  it('buckets ticks into epochs so no partition grows without bound', () => {
    expect(epochOfTick(0)).toBe(0);
    expect(epochOfTick(TICKS_PER_EPOCH - 1)).toBe(0);
    expect(epochOfTick(TICKS_PER_EPOCH)).toBe(1);
    expect(epochOfTick(-5)).toBe(0);
  });

  it('produces lexicographically ordered tick keys', () => {
    const keys = [0, 1, 9, 10, 99, 100, 1000, 999_999].map(tickKey);
    expect([...keys].sort()).toEqual(keys);
    expect(keys.every((k) => k.length === 12)).toBe(true);
  });

  it('freezes and advances a fixed clock', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-01-01T00:00:00.000Z');
    const before = clock.nowEpochMs();
    clock.advanceMs(90_000);
    expect(clock.nowEpochMs()).toBe(before + 90_000);
    expect(clock.nowIso()).toBe('2026-01-01T00:01:30.000Z');
    expect(() => new FixedClock('not a date')).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Traits                                                                      */
/* -------------------------------------------------------------------------- */

describe('genotype handling', () => {
  it('seeds a complete genome inside the per-mille range', () => {
    const seed = seedGenotype();
    expect(Object.keys(seed)).toHaveLength(TRAIT_IDS.length);
    for (const id of TRAIT_IDS) {
      expect(seed[id]).toBeGreaterThanOrEqual(0);
      expect(seed[id]).toBeLessThanOrEqual(PER_MILLE);
    }
  });

  it('normalises an untrusted partial genome without trusting any of it', () => {
    const normalised = normaliseGenotype({
      metabolicRate: 99_999,
      motility: -400,
      armor: 512.9,
    } as Partial<Record<TraitId, number>>);
    expect(normalised.metabolicRate).toBe(PER_MILLE);
    expect(normalised.motility).toBe(0);
    expect(normalised.armor).toBe(512);
    // Every unspecified trait falls back to its seed value rather than to zero or undefined.
    expect(Object.keys(normalised)).toHaveLength(TRAIT_IDS.length);
    for (const id of TRAIT_IDS) expect(Number.isInteger(normalised[id])).toBe(true);
  });

  it('ignores keys that are not traits', () => {
    const normalised = normaliseGenotype({
      notATrait: 900,
    } as unknown as Partial<Record<TraitId, number>>);
    expect(normalised).not.toHaveProperty('notATrait');
  });

  it('suppresses antagonistic traits so expression is never a free ladder', () => {
    const full = normaliseGenotype(
      Object.fromEntries(TRAIT_IDS.map((id) => [id, 1000])) as Record<TraitId, number>,
    );
    let suppressedSomewhere = false;
    for (const id of TRAIT_IDS) {
      const effective = effectiveTrait(full, id);
      expect(effective).toBeGreaterThanOrEqual(0);
      expect(effective).toBeLessThanOrEqual(full[id]);
      if (effective < full[id]) suppressedSomewhere = true;
    }
    expect(suppressedSomewhere).toBe(true);
  });

  it('derives a bounded, integral phenotype from any genome', () => {
    const genomes: Genotype[] = [
      seedGenotype(),
      normaliseGenotype(Object.fromEntries(TRAIT_IDS.map((id) => [id, 0]))),
      normaliseGenotype(Object.fromEntries(TRAIT_IDS.map((id) => [id, 1000]))),
    ];
    for (const genotype of genomes) {
      const body = derivePhenotype(genotype);
      for (const [key, value] of Object.entries(body)) {
        expect(Number.isInteger(value), `${key} must be integral`).toBe(true);
        expect(Number.isFinite(value), `${key} must be finite`).toBe(true);
        expect(value, `${key} must not be negative`).toBeGreaterThanOrEqual(0);
      }
      // A body that cannot move or cannot age would break movement and mortality entirely.
      expect(body.speedCuPerTick).toBeGreaterThan(0);
      expect(body.maxAgeTicks).toBeGreaterThanOrEqual(60);
      expect(body.upkeepPerTick).toBeGreaterThanOrEqual(1);
      expect(body.maxEnergy).toBeGreaterThan(0);
      expect(body.effectivePlanning).toBeLessThanOrEqual(PER_MILLE);
    }
  });

  it('is a pure function of the genome', () => {
    const genotype = seedGenotype();
    expect(derivePhenotype(genotype)).toEqual(derivePhenotype(genotype));
    expect(deriveVisual(genotype)).toEqual(deriveVisual(genotype));
  });

  it('derives a visual phenotype inside its declared ranges', () => {
    const prng = new Prng(31_337);
    for (let i = 0; i < 200; i += 1) {
      const genotype = normaliseGenotype(
        Object.fromEntries(TRAIT_IDS.map((id) => [id, prng.nextInt(1001)])),
      );
      const visual = deriveVisual(genotype);
      expect(visual.hue).toBeGreaterThanOrEqual(0);
      expect(visual.hue).toBeLessThan(360);
      expect(visual.appendages).toBeGreaterThanOrEqual(0);
      expect(visual.appendages).toBeLessThanOrEqual(8);
      expect(visual.spines).toBeLessThanOrEqual(12);
      expect(visual.eyes).toBeLessThanOrEqual(6);
      for (const key of [
        'saturation',
        'luminance',
        'scale',
        'elongation',
        'plating',
        'translucency',
        'glow',
      ] as const) {
        expect(visual[key], key).toBeGreaterThanOrEqual(0);
        expect(visual[key], key).toBeLessThanOrEqual(PER_MILLE);
      }
    }
  });

  it('makes inherited traits visible rather than cosmetic', () => {
    const base = seedGenotype();
    const armoured = normaliseGenotype({ ...base, armor: 1000, aggression: 1000 });
    const bare = normaliseGenotype({ ...base, armor: 0, aggression: 0 });
    expect(deriveVisual(armoured).plating).toBeGreaterThan(deriveVisual(bare).plating);
    expect(deriveVisual(armoured).spines).toBeGreaterThan(deriveVisual(bare).spines);

    const large = normaliseGenotype({ ...base, bodySize: 1000 });
    const small = normaliseGenotype({ ...base, bodySize: 0 });
    expect(deriveVisual(large).scale).toBeGreaterThan(deriveVisual(small).scale);
  });

  it('scores complexity monotonically', () => {
    const low = normaliseGenotype(Object.fromEntries(TRAIT_IDS.map((id) => [id, 100])));
    const high = normaliseGenotype(Object.fromEntries(TRAIT_IDS.map((id) => [id, 900])));
    expect(complexityScore(high)).toBeGreaterThan(complexityScore(low));
  });
});

/* -------------------------------------------------------------------------- */
/* Materials                                                                   */
/* -------------------------------------------------------------------------- */

describe('materials', () => {
  const catalogue = indexMaterials(BASE_MATERIALS);

  it('defines a complete, bounded property vector for every base material', () => {
    expect(BASE_MATERIALS.length).toBe(BASE_MATERIAL_IDS.length);
    expect(new Set(BASE_MATERIAL_IDS).size).toBe(BASE_MATERIAL_IDS.length);
    for (const material of BASE_MATERIALS) {
      expect(isValidId(material.id)).toBe(true);
      for (const property of MATERIAL_PROPERTY_IDS) {
        const value = material.properties[property];
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(PER_MILLE);
      }
      expect(material.nutritionPerUnit).toBeGreaterThanOrEqual(0);
    }
  });

  it('blends properties by volume, never inventing a property from nothing', () => {
    const stone = catalogue.get(asMaterialId('stone'));
    const fibre = catalogue.get(asMaterialId('fibre'));
    expect(stone).toBeDefined();
    expect(fibre).toBeDefined();
    if (!stone || !fibre) return;

    const blended = blendProperties(
      [
        { materialId: stone.id, quantity: 50 },
        { materialId: fibre.id, quantity: 50 },
      ],
      catalogue,
    );
    // Every blended value lies between the two inputs; nothing is created.
    for (const property of MATERIAL_PROPERTY_IDS) {
      const lo = Math.min(stone.properties[property], fibre.properties[property]);
      const hi = Math.max(stone.properties[property], fibre.properties[property]);
      expect(blended[property]).toBeGreaterThanOrEqual(lo);
      expect(blended[property]).toBeLessThanOrEqual(hi);
    }
  });

  it('is unaffected by component order', () => {
    const components: MaterialComponent[] = [
      { materialId: asMaterialId('clay'), quantity: 30 },
      { materialId: asMaterialId('resin'), quantity: 70 },
      { materialId: asMaterialId('sand'), quantity: 10 },
    ];
    expect(blendProperties(components, catalogue)).toEqual(
      blendProperties([...components].reverse(), catalogue),
    );
  });

  it('ignores unknown or zero-quantity components rather than trusting a claim', () => {
    const real = blendProperties([{ materialId: asMaterialId('clay'), quantity: 100 }], catalogue);
    const withGhost = blendProperties(
      [
        { materialId: asMaterialId('clay'), quantity: 100 },
        { materialId: asMaterialId('unobtainium'), quantity: 900 },
        { materialId: asMaterialId('resin'), quantity: 0 },
      ],
      catalogue,
    );
    expect(withGhost).toEqual(real);
  });

  it('returns a zero vector for an empty blend instead of NaN', () => {
    const empty = blendProperties([], catalogue);
    for (const property of MATERIAL_PROPERTY_IDS) expect(empty[property]).toBe(0);
    expect(totalVolume([])).toBe(0);
    expect(totalVolume([{ materialId: asMaterialId('sand'), quantity: -50 }])).toBe(0);
  });

  it('combines materials lossily and refuses impossible combinations', () => {
    const components: MaterialComponent[] = [
      { materialId: asMaterialId('sand'), quantity: 60 },
      { materialId: asMaterialId('resin'), quantity: 40 },
    ];
    const composite = combineMaterials(
      asMaterialId('sandResin'),
      'Sand resin',
      components,
      catalogue,
      12,
    );
    expect(composite).not.toBeNull();
    if (!composite) return;

    expect(composite.origin).toBe('composite');
    expect(composite.derivedFrom).toHaveLength(2);
    expect(composite.discoveredAtTick).toBe(12);

    // Binding fills voids and stiffens; nutrition is at most the mean, never more.
    const blended = blendProperties(components, catalogue);
    expect(composite.properties.hardness).toBeGreaterThanOrEqual(blended.hardness);
    expect(composite.properties.porosity).toBeLessThanOrEqual(blended.porosity);
    const meanNutrition =
      (60 * (catalogue.get(asMaterialId('sand'))?.nutritionPerUnit ?? 0) +
        40 * (catalogue.get(asMaterialId('resin'))?.nutritionPerUnit ?? 0)) /
      100;
    expect(composite.nutritionPerUnit).toBeLessThanOrEqual(meanNutrition);

    for (const property of MATERIAL_PROPERTY_IDS) {
      expect(composite.properties[property]).toBeLessThanOrEqual(PER_MILLE);
      expect(composite.properties[property]).toBeGreaterThanOrEqual(0);
    }

    // A single ingredient is not a combination, and an unknown ingredient is not usable.
    expect(
      combineMaterials(asMaterialId('x'), 'X', [components[0] as MaterialComponent], catalogue, 1),
    ).toBeNull();
    expect(combineMaterials(asMaterialId('x'), 'X', [], catalogue, 1)).toBeNull();
    expect(
      combineMaterials(
        asMaterialId('x'),
        'X',
        [
          { materialId: asMaterialId('sand'), quantity: 10 },
          { materialId: asMaterialId('nothingReal'), quantity: 10 },
        ],
        catalogue,
        1,
      ),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Structures                                                                  */
/* -------------------------------------------------------------------------- */

describe('structure derivation', () => {
  const catalogue = indexMaterials(BASE_MATERIALS);

  it('never derives a function below the minimum volume', () => {
    const tiny: MaterialComponent[] = [
      { materialId: asMaterialId('stone'), quantity: MIN_STRUCTURE_VOLUME - 1 },
    ];
    expect(deriveStructureFunctions(tiny, 'shell', catalogue)).toEqual([]);
  });

  it('derives only functions the pattern permits', () => {
    const sticky: MaterialComponent[] = [{ materialId: asMaterialId('resin'), quantity: 300 }];
    const asSnare = deriveStructureFunctions(sticky, 'snare', catalogue).map((f) => f.id);
    const asConduit = deriveStructureFunctions(sticky, 'conduit', catalogue).map((f) => f.id);
    expect(asSnare).toContain('snare');
    // The same material in a pattern that cannot express snaring does not snare.
    expect(asConduit).not.toContain('snare');
  });

  it('orders derived functions stably so replays stay byte-identical', () => {
    const mixed: MaterialComponent[] = [
      { materialId: asMaterialId('stone'), quantity: 200 },
      { materialId: asMaterialId('chitin'), quantity: 150 },
      { materialId: asMaterialId('resin'), quantity: 100 },
    ];
    const first = deriveStructureFunctions(mixed, 'shell', catalogue);
    const reversed = deriveStructureFunctions([...mixed].reverse(), 'shell', catalogue);
    expect(first).toEqual(reversed);
    expect([...first].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(first);
  });

  it('keeps every derived magnitude inside the per-mille scale', () => {
    const prng = new Prng(606);
    const ids = [...BASE_MATERIAL_IDS];
    for (let i = 0; i < 200; i += 1) {
      const components: MaterialComponent[] = Array.from({ length: 3 }, () => ({
        materialId: ids[prng.nextInt(ids.length)] ?? ids[0]!,
        quantity: prng.nextRange(20, 400),
      }));
      for (const pattern of ['lattice', 'shell', 'mesh', 'vessel', 'snare'] as const) {
        for (const derived of deriveStructureFunctions(components, pattern, catalogue)) {
          expect(derived.magnitude).toBeGreaterThan(0);
          expect(derived.magnitude).toBeLessThanOrEqual(PER_MILLE);
          expect(Number.isInteger(derived.magnitude)).toBe(true);
        }
      }
    }
  });

  it('derives integrity and decay from material properties', () => {
    const hard = blendProperties([{ materialId: asMaterialId('stone'), quantity: 100 }], catalogue);
    const soft = blendProperties(
      [{ materialId: asMaterialId('biofilm'), quantity: 100 }],
      catalogue,
    );
    expect(initialIntegrity(hard)).toBeGreaterThan(initialIntegrity(soft));
    expect(initialIntegrity(hard)).toBeLessThanOrEqual(PER_MILLE);
    // Everything decays: an abandoned structure must eventually disappear so storage stays bounded.
    expect(decayPerTick(hard)).toBeGreaterThanOrEqual(1);
    expect(decayPerTick(soft)).toBeGreaterThanOrEqual(decayPerTick(hard));
  });

  it('bounds the retained usage history', () => {
    const entry = (tick: number): StructureUsage => ({
      tick,
      organismId: asId('org-1'),
      lineageId: asId('lin-1'),
      kind: 'inspect',
    });
    let usage: readonly StructureUsage[] = [];
    for (let tick = 0; tick < 100; tick += 1) usage = recordUsage(usage, entry(tick));
    expect(usage.length).toBeLessThanOrEqual(12);
    // The most recent entry survives; the oldest is dropped.
    expect(usage.at(-1)?.tick).toBe(99);
  });

  it('labels a structure from what it does, not from what it was called', () => {
    expect(describeStructure('shell', [])).toBe('inert shell');
    expect(
      describeStructure('shell', [
        { id: 'shelter', magnitude: 800 },
        { id: 'barrier', magnitude: 200 },
      ]),
    ).toBe('shelter shell');
  });
});

/* -------------------------------------------------------------------------- */
/* Public request schemas                                                      */
/* -------------------------------------------------------------------------- */

describe('public request schemas', () => {
  const validAgent = {
    name: 'Tidepool Weaver',
    aspiration: 'seek the ocean and endure',
    habitat: 'shallows',
    temperament: 'balanced',
    sensoryBias: 'light',
    visualSeed: 1234,
    drives: { survive: 600, forage: 500, reproduce: 400, explore: 400, cooperate: 300, build: 300 },
  };

  it('accepts a well-formed authoring request', () => {
    const parsed = CreateAgentRequestSchema.safeParse(validAgent);
    expect(parsed.success).toBe(true);
  });

  it('rejects an over-long or hostile name', () => {
    expect(CreateAgentRequestSchema.safeParse({ ...validAgent, name: 'a' }).success).toBe(false);
    expect(
      CreateAgentRequestSchema.safeParse({ ...validAgent, name: 'x'.repeat(41) }).success,
    ).toBe(false);
    expect(
      CreateAgentRequestSchema.safeParse({ ...validAgent, name: '<script>alert(1)</script>' })
        .success,
    ).toBe(false);
  });

  it('caps total drive weight so no creator can author an omni-competent cell', () => {
    const maxed = {
      ...validAgent,
      drives: {
        survive: 1000,
        forage: 1000,
        reproduce: 1000,
        explore: 1000,
        cooperate: 1000,
        build: 1000,
      },
    };
    expect(CreateAgentRequestSchema.safeParse(maxed).success).toBe(false);
  });

  it('rejects out-of-range and non-integer numbers', () => {
    expect(CreateAgentRequestSchema.safeParse({ ...validAgent, visualSeed: -1 }).success).toBe(
      false,
    );
    expect(CreateAgentRequestSchema.safeParse({ ...validAgent, visualSeed: 1.5 }).success).toBe(
      false,
    );
    expect(CreateAgentRequestSchema.safeParse({ ...validAgent, visualSeed: 70_000 }).success).toBe(
      false,
    );
  });

  it('rejects an unknown habitat, temperament or sensory bias', () => {
    for (const patch of [
      { habitat: 'volcano' },
      { temperament: 'omniscient' },
      { sensoryBias: 'telepathic' },
    ]) {
      expect(CreateAgentRequestSchema.safeParse({ ...validAgent, ...patch }).success).toBe(false);
    }
  });

  it('bounds a broad goal', () => {
    expect(SubmitGoalRequestSchema.safeParse({ text: 'seek the ocean' }).success).toBe(true);
    expect(SubmitGoalRequestSchema.safeParse({ text: 'no' }).success).toBe(false);
    expect(SubmitGoalRequestSchema.safeParse({ text: 'x'.repeat(161) }).success).toBe(false);
  });

  it('caps snapshot radius so one request can never span the world', () => {
    expect(SnapshotQuerySchema.parse({}).radius).toBe(1);
    expect(SnapshotQuerySchema.safeParse({ radius: '2' }).success).toBe(true);
    expect(SnapshotQuerySchema.safeParse({ radius: 3 }).success).toBe(false);
    expect(SnapshotQuerySchema.safeParse({ radius: 999 }).success).toBe(false);
  });

  it('caps history page size and cursor length', () => {
    expect(HistoryQuerySchema.parse({}).limit).toBe(50);
    expect(HistoryQuerySchema.safeParse({ limit: 200 }).success).toBe(true);
    expect(HistoryQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(HistoryQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(HistoryQuerySchema.safeParse({ cursor: 'x'.repeat(257) }).success).toBe(false);
  });

  it('rejects an identifier that is not an Autocosm identifier', () => {
    expect(SnapshotQuerySchema.safeParse({ regionId: 'r1x1' }).success).toBe(true);
    expect(SnapshotQuerySchema.safeParse({ regionId: '../../etc/passwd' }).success).toBe(false);
    expect(SnapshotQuerySchema.safeParse({ regionId: 'a b' }).success).toBe(false);
  });
});
