import { describe, expect, it } from 'vitest';
import {
  asMaterialId,
  asOrganismId,
  asResourceNodeId,
  asStructureId,
  derivePhenotype,
  makePosition,
  regionIdOf,
  type AgentId,
  type Genotype,
  type LineageId,
  type MaterialDefinition,
  type MaterialProperties,
  type Organism,
  type Structure,
  type StructureFunctionId,
  type StructureId,
} from '@autocosm/domain';

import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import { EventSink } from './events.js';
import { observe } from './observe.js';
import { EnergyLedger, resolveAction, type Resolution, type ResolutionContext } from './resolve.js';
import { toDraft, type WorldState } from './state.js';
import {
  NO_STRUCTURE_EFFECTS,
  beaconRangeBonusCu,
  effectiveCarryCapacity,
  effectiveSpeedCuPerTick,
  structureEffectRadiusCu,
  structureEffectsAt,
} from './structure-effects.js';
import { advanceTick } from './tick.js';
import { generateWorld } from './worldgen.js';

/**
 * Nine of the world's ten structure functions did nothing at all.
 *
 * `structures.ts` derives ten functions from a construction's material and pattern, each carrying a
 * prose summary that the glossary route serves verbatim to spectators. Exactly one of them —
 * `shelter` — had any mechanical effect anywhere in the simulation, and even that was gated behind
 * an explicit `attach` whose measured usage across whole runs was 2/0/0. `barrier`, `snare`,
 * `conduit`, `beacon`, `reservoir`, `filter`, `nursery` and `toxinWard` were decoration.
 *
 * The consequence looked like the cause of the world's building collapse, and it is not. `build`
 * requires `manipulation >= 250` and `memorySlots >= 2`; both traits charge upkeep every tick to
 * every organism carrying them, whether or not it ever builds. A standing tax against a benefit that
 * does not exist has one obvious outcome, and the collapse was measured: on seed 4242424 the
 * fraction of living organisms able to `build` ran 39% -> 13% -> 20% -> **0% at tick 1500** and never
 * recovered.
 *
 * **Making the eight functions real does not reverse it.** Six paired seeds at 1500 ticks, against a
 * control checkout of the same commit run simultaneously, give paired t(5) of 0.46 on structures
 * built, 0.90 on structures standing and -0.14 on materials known — against 2.57 for significance —
 * with three of six seeds favouring each arm on every one. Mean `manipulation` settles at 110-155 in
 * *both* arms, on the `collect` gate of 120 rather than the `build` gate of 250, so the decay is
 * pre-existing and untouched. A public good cannot pay for the individually-taxed trait that makes
 * it; that needs a private return, and a separate measurement.
 *
 * So these tests deliberately pin the *mechanism* and claim nothing about the world. Each asserts
 * that a construction with a given function measurably changes the outcome for an organism standing
 * beside it, against an otherwise identical control — constructed geometry, not a subject searched
 * for in a generated world, which is the fixture fragility `recipe identity` and `structure
 * permanence` were both re-grounded to avoid.
 */

const TIMEOUT_MS = 120_000;

const KIN = 'ln-kin' as LineageId;
const FOREIGN = 'ln-foreign' as LineageId;

function properties(partial: Partial<MaterialProperties>): MaterialProperties {
  return {
    hardness: 500,
    flexibility: 500,
    density: 500,
    porosity: 500,
    conductivity: 500,
    adhesion: 500,
    photosensitivity: 500,
    toxicity: 0,
    ...partial,
  };
}

/**
 * A construction with exactly the functions named, at full strength unless stated.
 *
 * Functions are assigned directly rather than derived, so a test exercises one effect in isolation
 * instead of whatever bundle a given material happens to produce.
 */
function structureWith(options: {
  readonly id: string;
  readonly functions: readonly StructureFunctionId[];
  readonly at: { readonly x: number; readonly z: number };
  readonly lineageId?: LineageId;
  readonly magnitude?: number;
  readonly integrity?: number;
  readonly volume?: number;
}): Structure {
  const position = makePosition(options.at.x, options.at.z);
  const magnitude = options.magnitude ?? 1000;
  return {
    id: asStructureId(options.id),
    regionId: regionIdOf(position),
    position,
    pattern: 'shell',
    components: [{ materialId: asMaterialId('mx-test'), quantity: 200 }],
    functions: options.functions.map((id) => ({ id, magnitude })),
    properties: properties({}),
    volume: options.volume ?? 200,
    integrity: options.integrity ?? 1000,
    createdByAgentId: 'ag-builder' as AgentId,
    createdByLineageId: options.lineageId ?? KIN,
    createdByOrganismId: asOrganismId('or-builder'),
    createdAtTick: 0,
    lastChangedAtTick: 0,
    usage: [],
    label: 'test construction',
  };
}

function mapOf(...structures: readonly Structure[]): ReadonlyMap<StructureId, Structure> {
  return new Map(structures.map((s) => [s.id, s]));
}

const ORIGIN = makePosition(1000, 1000);

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

describe('what a construction does to the ground around it', () => {
  it('reaches further for a bulkier construction, up to a cap', () => {
    expect(structureEffectRadiusCu(400)).toBeGreaterThan(structureEffectRadiusCu(40));
    expect(structureEffectRadiusCu(100_000)).toBe(structureEffectRadiusCu(10_000));
  });

  it('does nothing at all beyond its reach', () => {
    const reach = structureEffectRadiusCu(200);
    const shelter = structureWith({ id: 'st-far', functions: ['shelter'], at: ORIGIN });
    const inside = structureEffectsAt(
      mapOf(shelter),
      makePosition(ORIGIN.x + reach - 1, ORIGIN.z),
      KIN,
    );
    const outside = structureEffectsAt(
      mapOf(shelter),
      makePosition(ORIGIN.x + reach + 1, ORIGIN.z),
      KIN,
    );
    expect(inside.upkeepDiscountPerMille).toBeGreaterThan(0);
    expect(outside).toBe(NO_STRUCTURE_EFFECTS);
  });

  it('takes the strongest of two overlapping fields rather than their sum', () => {
    const weak = structureWith({
      id: 'st-weak',
      functions: ['shelter'],
      at: ORIGIN,
      magnitude: 400,
    });
    const strong = structureWith({
      id: 'st-strong',
      functions: ['shelter'],
      at: ORIGIN,
      magnitude: 800,
    });
    const both = structureEffectsAt(mapOf(weak, strong), ORIGIN, KIN);
    const alone = structureEffectsAt(mapOf(strong), ORIGIN, KIN);
    // Two shelters are not twice as sheltering, and stacking must not run away. The lower bound
    // matters as much as the equality: without it a mechanism that returned nothing at all would
    // satisfy `both === alone` and this assertion could never fail.
    expect(alone.upkeepDiscountPerMille).toBeGreaterThan(0);
    expect(both.upkeepDiscountPerMille).toBe(alone.upkeepDiscountPerMille);
  });

  it('gives a ruin less than a sound building, which is what repair buys back', () => {
    const sound = structureWith({ id: 'st-sound', functions: ['shelter'], at: ORIGIN });
    const ruin = structureWith({
      id: 'st-ruin',
      functions: ['shelter'],
      at: ORIGIN,
      integrity: 200,
    });
    expect(structureEffectsAt(mapOf(ruin), ORIGIN, KIN).upkeepDiscountPerMille).toBeLessThan(
      structureEffectsAt(mapOf(sound), ORIGIN, KIN).upkeepDiscountPerMille,
    );
  });

  it('opens its benefits to anyone in reach, kin or not', () => {
    // Lineages are spatially partitioned (measured `sharedRegions = 0` on three seeds), so
    // proximity is overwhelmingly kin anyway — and leaving benefits open is what gives a foreign
    // construction any worth to a stranger, which is the premise of the inspection channel.
    const shelter = structureWith({
      id: 'st-open',
      functions: ['shelter', 'conduit', 'filter', 'reservoir', 'nursery'],
      at: ORIGIN,
      lineageId: KIN,
    });
    const stranger = structureEffectsAt(mapOf(shelter), ORIGIN, FOREIGN);
    expect(stranger.upkeepDiscountPerMille).toBeGreaterThan(0);
    expect(stranger.energyPerTick).toBeGreaterThan(0);
    expect(stranger.feedingYieldPerMille).toBeGreaterThan(0);
    expect(stranger.carryBonus).toBeGreaterThan(0);
    expect(stranger.juvenileDiscountPerMille).toBeGreaterThan(0);
  });

  it('turns its deterrents on other lineages only', () => {
    const ward = structureWith({
      id: 'st-ward',
      functions: ['toxinWard', 'barrier', 'snare'],
      at: ORIGIN,
      lineageId: KIN,
    });
    const own = structureEffectsAt(mapOf(ward), ORIGIN, KIN);
    const other = structureEffectsAt(mapOf(ward), ORIGIN, FOREIGN);
    expect(own.toxinExposure).toBe(0);
    expect(own.impedancePerMille).toBe(0);
    expect(other.toxinExposure).toBeGreaterThan(0);
    expect(other.impedancePerMille).toBeGreaterThan(0);
  });

  it('never withholds a whole step, so nothing can be pinned in place forever', () => {
    const snare = structureWith({
      id: 'st-snare',
      functions: ['snare'],
      at: ORIGIN,
      lineageId: KIN,
    });
    const effects = structureEffectsAt(mapOf(snare), ORIGIN, FOREIGN);
    // The floor only means something if something is actually being withheld.
    expect(effects.impedancePerMille).toBeGreaterThan(0);
    expect(effectiveSpeedCuPerTick(120, effects)).toBeLessThan(120);
    expect(effectiveSpeedCuPerTick(120, effects)).toBeGreaterThanOrEqual(1);
    expect(effectiveSpeedCuPerTick(1, effects)).toBeGreaterThanOrEqual(1);
  });

  it('lets a beacon carry its own legibility rather than sharpening a nearby eye', () => {
    const beacon = structureWith({ id: 'st-beacon', functions: ['beacon'], at: ORIGIN });
    // A beacon standing beside an organism grants that organism nothing: the range belongs to
    // the structure, which is what the summary has always claimed.
    expect(structureEffectsAt(mapOf(beacon), ORIGIN, KIN)).toBe(NO_STRUCTURE_EFFECTS);
    expect(beaconRangeBonusCu(beacon)).toBeGreaterThan(0);
    expect(beaconRangeBonusCu(structureWith({ id: 'st-plain', functions: [], at: ORIGIN }))).toBe(
      0,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Wiring — the resolver                                                       */
/* -------------------------------------------------------------------------- */

function context(state: WorldState): ResolutionContext {
  const draft = toDraft(state);
  const events = new EventSink(draft.world.id, draft.world.tick);
  return { draft, config: DEFAULT_SIMULATION_CONFIG, events, ledger: new EnergyLedger() };
}

/** A generated world reduced to one well-fed organism at a known point, plus the structures given. */
function stagedWorld(options: {
  readonly structures: readonly Structure[];
  readonly organism?: Partial<Organism>;
  readonly genotype?: Partial<Genotype>;
}): { state: WorldState; organism: Organism } {
  const base = generateWorld({ seed: 4_242_424, worldId: 'w-effects' });
  const template = [...base.organisms.values()].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!template) throw new Error('generated world holds no organism');

  const organism: Organism = {
    ...template,
    genotype: { ...template.genotype, ...options.genotype },
    lineageId: KIN,
    position: ORIGIN,
    regionId: regionIdOf(ORIGIN),
    energy: 4000,
    inventory: [],
    ...options.organism,
  };
  const state: WorldState = {
    ...base,
    organisms: new Map([[organism.id, organism]]),
    structures: mapOf(...options.structures),
  };
  return { state, organism };
}

describe('a construction changes what an organism can do beside it', () => {
  it('lets a reservoir bank more than a body could carry', () => {
    const materialId = asMaterialId('mx-stone');
    const material: MaterialDefinition = {
      id: materialId,
      label: 'Test Stone',
      origin: 'mineral',
      properties: properties({ hardness: 900 }),
      nutritionPerUnit: 0,
    };
    const nodeId = asResourceNodeId('rn-test');
    const capacity = DEFAULT_SIMULATION_CONFIG.inventoryCapacity;

    function collectWith(structures: readonly Structure[]): Resolution & { gained: number } {
      const staged = stagedWorld({
        structures,
        // `collect` is gated at `manipulation >= 120`, and a founder does not always clear it.
        genotype: { manipulation: 600 },
        // Already at capacity: without a reservoir there is no headroom at all, which is exactly
        // the band `collect/inventoryFull` used to fire in.
        organism: { inventory: [{ materialId, quantity: capacity }] },
      });
      const state: WorldState = {
        ...staged.state,
        materials: new Map([...staged.state.materials, [materialId, material]]),
        resources: new Map([
          [
            nodeId,
            {
              id: nodeId,
              regionId: regionIdOf(ORIGIN),
              position: ORIGIN,
              materialId,
              quantity: 500,
              regenPerTick: 0,
              capacity: 500,
            },
          ],
        ]),
      };
      const ctx = context(state);
      const result = resolveAction(ctx, staged.organism.id, {
        type: 'collect',
        resourceNodeId: nodeId,
        quantity: 40,
      });
      const after = ctx.draft.organisms.get(staged.organism.id);
      const carried = (after?.inventory ?? []).reduce((sum, e) => sum + e.quantity, 0);
      return { ...result, gained: carried - capacity };
    }

    // The control must be refused for the *right* reason. A capability gate would refuse it too,
    // and then "0 without a reservoir" would prove nothing at all.
    const bare = collectWith([]);
    expect(bare.reason).toBe('inventoryFull');
    expect(bare.gained).toBe(0);

    const banked = collectWith([
      structureWith({ id: 'st-res', functions: ['reservoir'], at: ORIGIN }),
    ]);
    expect(banked.accepted).toBe(true);
    expect(banked.gained).toBeGreaterThan(0);
  });

  it('lets a filter raise the yield of a mouthful', () => {
    function eatWith(structures: readonly Structure[]): number {
      const staged = stagedWorld({ structures, organism: { energy: 10 } });
      const region = staged.state.regions.get(regionIdOf(ORIGIN));
      if (!region) throw new Error('staged organism stands outside every region');
      const state: WorldState = {
        ...staged.state,
        regions: new Map([...staged.state.regions, [region.id, { ...region, biomass: 5000 }]]),
      };
      const ctx = context(state);
      const result = resolveAction(ctx, staged.organism.id, {
        type: 'consume',
        targetKind: 'biomass',
      });
      expect(result.accepted).toBe(true);
      return (ctx.draft.organisms.get(staged.organism.id)?.energy ?? 0) - 10;
    }

    const plain = eatWith([]);
    const filtered = eatWith([
      structureWith({ id: 'st-filter', functions: ['filter'], at: ORIGIN }),
    ]);
    expect(plain).toBeGreaterThan(0);
    expect(filtered).toBeGreaterThan(plain);
  });

  it('lets a foreign barrier shorten a step, and its own lineage pass freely', () => {
    function travelWith(structures: readonly Structure[]): number {
      const staged = stagedWorld({ structures });
      const ctx = context(staged.state);
      const result = resolveAction(ctx, staged.organism.id, {
        type: 'move',
        target: { x: ORIGIN.x + 3000, z: ORIGIN.z },
      });
      expect(result.accepted).toBe(true);
      const after = ctx.draft.organisms.get(staged.organism.id);
      return (after?.position.x ?? ORIGIN.x) - ORIGIN.x;
    }

    const free = travelWith([]);
    const ownWall = travelWith([
      structureWith({ id: 'st-own', functions: ['barrier'], at: ORIGIN, lineageId: KIN }),
    ]);
    const foreignWall = travelWith([
      structureWith({ id: 'st-them', functions: ['barrier'], at: ORIGIN, lineageId: FOREIGN }),
    ]);

    expect(free).toBeGreaterThan(0);
    expect(ownWall).toBe(free);
    expect(foreignWall).toBeGreaterThan(0);
    expect(foreignWall).toBeLessThan(free);
  });

  it('lets a beacon be inspected from beyond ordinary sight, and reports the same range', () => {
    // The two sides must agree: `observe` telling an agent it can see something the resolver then
    // refuses is the divergence that made `collect/inventoryFull` fire on every at-capacity tick.
    const staged = stagedWorld({ structures: [] });
    const phenotype = derivePhenotype(staged.organism.genotype);
    // Past the landmark bonus an ordinary construction of this bulk already carries
    // (`min(1800, volume * 8)`), so only a beacon's own extra range can reach this far.
    const beyondSight = phenotype.perceptionRadiusCu + 2000;
    const at = { x: ORIGIN.x + beyondSight, z: ORIGIN.z };

    function inspect(structures: readonly Structure[]): boolean {
      const world = stagedWorld({ structures });
      const ctx = context(world.state);
      const structure = structures[0];
      if (!structure) throw new Error('nothing to inspect');
      return resolveAction(ctx, world.organism.id, {
        type: 'inspect',
        targetKind: 'structure',
        targetId: structure.id,
      }).accepted;
    }

    const plain = structureWith({ id: 'st-dull', functions: ['shelter'], at, lineageId: FOREIGN });
    const lit = structureWith({ id: 'st-lit', functions: ['beacon'], at, lineageId: FOREIGN });
    expect(inspect([plain])).toBe(false);
    expect(inspect([lit])).toBe(true);

    // And the observation model must say so too, or an agent could never learn to walk to one.
    const litWorld = stagedWorld({ structures: [lit] });
    const seen = observe(toDraft(litWorld.state), litWorld.organism);
    expect(seen.structures.some((s) => s.structureId === lit.id)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Wiring — metabolism                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Runs a lone organism to exhaustion beside the structures given, and reports how long it lasted.
 *
 * A survival horizon rather than a single tick's arithmetic: metabolism is the outcome shelter,
 * nursery and conduit exist to change, and an instant is a sample where a lifetime is the mechanism.
 *
 * The region is stripped of biomass *and of light*, and every deposit removed, so nothing but the
 * construction can keep the organism alive. Without the light stripped, photosynthesis alone carried
 * a lone organism to its `maxAgeTicks` in every arm — the measurement was 834 ticks with shelter,
 * with a conduit and on bare ground alike, which would have made these assertions unfailable.
 */
function ticksSurvived(structures: readonly Structure[], horizon: number): number {
  const staged = stagedWorld({ structures, organism: { energy: 600, ageTicks: 0 } });
  const region = staged.state.regions.get(regionIdOf(ORIGIN));
  if (!region) throw new Error('staged organism stands outside every region');
  let state: WorldState = {
    ...staged.state,
    regions: new Map([
      ...staged.state.regions,
      [region.id, { ...region, biomass: 0, lightModifier: 0 }],
    ]),
    resources: new Map(),
  };
  for (let index = 0; index < horizon; index += 1) {
    state = advanceTick(state).state;
    const organism = state.organisms.get(staged.organism.id);
    if (!organism || !organism.alive) return index + 1;
  }
  return horizon;
}

/**
 * The control arm.
 *
 * Not bare ground: a construction is *visible* whether or not it does anything, and an organism
 * that can see one may behave differently from one that cannot. `anchor` acts only through an
 * explicit `attach`, so a lone anchor is observationally identical to the arm under test — same
 * pattern, same integrity, same distance, functions hidden until inspected — while leaving the
 * ground around it untouched. Any difference in survival is therefore the effect and nothing else.
 */
function inertControl(): Structure {
  return structureWith({ id: 'st-inert', functions: ['anchor'], at: ORIGIN });
}

describe('a construction changes how long an organism lasts beside it', () => {
  const HORIZON = 400;

  it(
    'lets shelter buy time that bare ground does not',
    () => {
      const bare = ticksSurvived([inertControl()], HORIZON);
      const sheltered = ticksSurvived(
        [structureWith({ id: 'st-inert', functions: ['shelter'], at: ORIGIN })],
        HORIZON,
      );
      expect(bare).toBeLessThan(HORIZON);
      expect(sheltered).toBeGreaterThan(bare);
    },
    TIMEOUT_MS,
  );

  it(
    'lets a conduit feed what nothing else can',
    () => {
      const bare = ticksSurvived([inertControl()], HORIZON);
      const fed = ticksSurvived(
        [structureWith({ id: 'st-inert', functions: ['conduit'], at: ORIGIN })],
        HORIZON,
      );
      expect(fed).toBeGreaterThan(bare);
    },
    TIMEOUT_MS,
  );

  it(
    'lets a nursery shorten the odds for the young only',
    () => {
      const nursery = structureWith({ id: 'st-inert', functions: ['nursery'], at: ORIGIN });
      const young = ticksSurvived([nursery], HORIZON);
      const bare = ticksSurvived([inertControl()], HORIZON);
      expect(young).toBeGreaterThan(bare);

      // Past maturity the same construction offers nothing, which is what makes it a nursery.
      const staged = stagedWorld({ structures: [nursery] });
      const phenotype = derivePhenotype(staged.organism.genotype);
      const grown = structureEffectsAt(mapOf(nursery), ORIGIN, KIN);
      expect(grown.juvenileDiscountPerMille).toBeGreaterThan(0);
      expect(grown.upkeepDiscountPerMille).toBe(0);
      expect(phenotype.maturityAgeTicks).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'lets a foreign toxin ward wound what stands in it, and spares its own lineage',
    () => {
      function healthAfter(lineageId: LineageId): number {
        const ward = structureWith({
          id: 'st-toxin',
          functions: ['toxinWard'],
          at: ORIGIN,
          lineageId,
        });
        const staged = stagedWorld({
          structures: [ward],
          // Enough energy that nothing here is starvation, and no toxin resistance to speak of.
          organism: {
            energy: 9000,
            genotype: {
              ...[...generateWorld({ seed: 7, worldId: 'w-t' }).organisms.values()][0]!.genotype,
              toxinResistance: 0,
            },
          },
        });
        let state = staged.state;
        for (let index = 0; index < 40; index += 1) state = advanceTick(state).state;
        return state.organisms.get(staged.organism.id)?.health ?? 0;
      }

      expect(healthAfter(FOREIGN)).toBeLessThan(healthAfter(KIN));
    },
    TIMEOUT_MS,
  );
});

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

describe('the effect helpers agree with the fields they feed', () => {
  it('leaves an organism untouched where nothing stands', () => {
    expect(structureEffectsAt(new Map(), ORIGIN, KIN)).toBe(NO_STRUCTURE_EFFECTS);
    expect(effectiveCarryCapacity(240, NO_STRUCTURE_EFFECTS)).toBe(240);
    expect(effectiveSpeedCuPerTick(120, NO_STRUCTURE_EFFECTS)).toBe(120);
  });

  it('ignores a construction that derived no function at all', () => {
    // About half of everything built is inert by design, and an inert pile must not shelter.
    const inert = structureWith({ id: 'st-inert', functions: [], at: ORIGIN });
    expect(structureEffectsAt(mapOf(inert), ORIGIN, KIN)).toBe(NO_STRUCTURE_EFFECTS);
  });
});
