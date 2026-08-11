import {
  clampPerMille,
  distance,
  scaleByPerMille,
  type LineageId,
  type Position,
  type Structure,
  type StructureId,
} from '@autocosm/domain';

/**
 * What a construction does to the organisms standing around it.
 *
 * Ten function types are derived in `structures.ts`, each carrying a prose summary describing a
 * real mechanical effect, and until this module existed **one** of them had any effect anywhere in
 * the simulation: `shelter` discounted upkeep for an organism explicitly attached to it
 * (`tick.ts`), and `anchor` merely permitted that attach. `barrier`, `snare`, `conduit`, `beacon`,
 * `reservoir`, `filter`, `nursery` and `toxinWard` were decoration — and the glossary served all
 * ten to spectators as though they were real.
 *
 * The motivation was the creation collapse: on seed 4242424 the fraction of living organisms able
 * to `build` runs 39% -> 13% -> 20% -> **0% at tick 1500** and never recovers, on the theory that a
 * trait taxed every tick against a benefit that does not exist can only be selected away.
 *
 * **That theory is not supported, and this module does not fix the collapse.** Measured across six
 * paired seeds at 1500 ticks, against a control checkout of the same commit run simultaneously:
 *
 * | metric | control mean | with this module | paired t(5) | seeds favouring control |
 * |---|---|---|---|---|
 * | structures built | 57.7 | 52.2 | 0.46 | 3/6 |
 * | standing at 1500 | 24.8 | 17.7 | 0.90 | 3/6 |
 * | materials known | 291.2 | 300.0 | -0.14 | 3/6 |
 * | peak structures | 31.8 | 28.3 | 0.56 | 3/6 |
 *
 * Significance needs |t| >= 2.57. Every metric is a coin flip, and the spread *within* one arm
 * (`built` runs 15-109 across control seeds) is several times the difference *between* arms. An
 * earlier single-seed comparison read as a catastrophic regression and was chaos — which is the
 * whole reason the control is now six paired seeds rather than one.
 *
 * The collapse itself is untouched because its cause lies elsewhere. Mean genotype `manipulation`
 * falls from ~410 at founding to 110-155 by tick 1500 in **both** arms, settling on the `collect`
 * gate of 120 rather than the `build` gate of 250 — so it is pre-existing, and making structure
 * functions real does not move it. It cannot: every effect here is a *public* good shared by
 * whatever stands in range, and a public good cannot pay for the individually-taxed trait that
 * produces it. Reversing the collapse needs a private return that scales past 250, which is a
 * separate balance change with its own measurement.
 *
 * What this module does claim, and no more: eight documented functions that did nothing now do what
 * their own summary says, at no measurable cost to the world.
 *
 * Two design decisions follow.
 *
 * **Effects apply by proximity, not by `attach`.** The one real benefit was gated behind an
 * explicit action requiring the structure to be inspected and within `interactionRadiusCu`, and
 * spending a turn on it costs the organism everything below it in the heuristic ladder. Measured
 * `structureUsage` across whole runs was 2/0/0, so even shelter was effectively unreachable.
 * Standing in the lee of a wall is sheltered by the wall.
 *
 * **Benefits are open to anyone in range; only deterrents check lineage.** Lineages are spatially
 * partitioned — measured across three seeds, `sharedRegions = 0` — so proximity is overwhelmingly
 * kin, and kin selection is the standard resolution of the public-goods problem that sank the
 * builder. Leaving benefits open is also what gives a foreign construction any worth to a stranger,
 * which is the premise of the inspection channel.
 */

/** Aggregate effect of every construction whose field covers one point. Integers throughout. */
export interface StructureEffects {
  /** `shelter` — proportion of metabolic upkeep waived. */
  readonly upkeepDiscountPerMille: number;
  /** `nursery` — further upkeep waived, for organisms below maturity only. */
  readonly juvenileDiscountPerMille: number;
  /** `conduit` — energy delivered per tick, in eu. */
  readonly energyPerTick: number;
  /** `filter` — proportion added to the nutrition of anything eaten here. */
  readonly feedingYieldPerMille: number;
  /** `reservoir` — extra carrying volume, in mu. */
  readonly carryBonus: number;
  /** `toxinWard` — toxic load on a non-kin organism, compared against its resistance. */
  readonly toxinExposure: number;
  /** `barrier` and `snare` — proportion of a non-kin organism's step withheld. */
  readonly impedancePerMille: number;
}

export const NO_STRUCTURE_EFFECTS: StructureEffects = Object.freeze({
  upkeepDiscountPerMille: 0,
  juvenileDiscountPerMille: 0,
  energyPerTick: 0,
  feedingYieldPerMille: 0,
  carryBonus: 0,
  toxinExposure: 0,
  impedancePerMille: 0,
});

/**
 * Base reach of a construction's influence, in cu, before its own bulk is added.
 *
 * Sized to `interactionRadiusCu` (420) so that anything close enough to be worked on is close
 * enough to be sheltered by. A structure is not a point.
 */
const EFFECT_BASE_RADIUS_CU = 420;

/** Ceiling on the reach a construction earns from bulk alone, in cu. */
const EFFECT_BULK_BONUS_CAP_CU = 700;

/**
 * How far a construction's influence reaches.
 *
 * Deliberately much shorter than `structureVisibilityRadiusCu`: a landmark is legible from far
 * outside the ground it actually shelters, so seeing one is an invitation to walk to it.
 */
export function structureEffectRadiusCu(volume: number): number {
  return EFFECT_BASE_RADIUS_CU + Math.min(EFFECT_BULK_BONUS_CAP_CU, Math.max(0, volume) * 3);
}

/** Highest wins; effects never sum. Two shelters are not twice as sheltering. */
function strongest(current: number, candidate: number): number {
  return candidate > current ? candidate : current;
}

/**
 * Energy a perfect conduit delivers per tick, in eu.
 *
 * Comparable to `photosynthesisAtFullLight` (20 eu at full expression) but under it, so a
 * construction supplements a body rather than replacing the need for one.
 */
const CONDUIT_ENERGY_AT_FULL = 9;

/**
 * Sight a perfect beacon adds to *its own* legibility, in cu.
 *
 * A beacon does not sharpen the eye of whoever stands beside it — its summary says it "emits a
 * light signal that organisms can perceive from far outside sensing range", so the range belongs
 * to the structure. That makes it the evolved answer to the measured legibility gap: across three
 * seeds the nearest foreign construction stands at 3 581–7 876 cu against an actual visibility of
 * about 2 200, so a beacon is the only thing in the world that can close a shortfall of that size.
 * A lineage that builds one is choosing to be found.
 */
const BEACON_RANGE_AT_FULL_CU = 2400;

/** Volume a perfect reservoir adds to what an organism can carry, in mu. */
const RESERVOIR_CARRY_AT_FULL = 200;

/**
 * Most of a step a barrier or snare can withhold.
 *
 * Never total: an organism that could be pinned in place indefinitely by a structure it cannot
 * dismantle would be trapped rather than impeded, and nothing in the world could free it.
 */
const MAX_IMPEDANCE_PER_MILLE = 650;

/**
 * Aggregate the constructions covering one point.
 *
 * A ruin does less than a sound building: every magnitude is scaled by integrity, which is also
 * what gives `repair` a return beyond merely postponing a collapse.
 */
export function structureEffectsAt(
  structures: ReadonlyMap<StructureId, Structure>,
  position: Position,
  lineageId: LineageId,
): StructureEffects {
  if (structures.size === 0) return NO_STRUCTURE_EFFECTS;

  let upkeepDiscountPerMille = 0;
  let juvenileDiscountPerMille = 0;
  let energyPerTick = 0;
  let feedingYieldPerMille = 0;
  let carryBonus = 0;
  let toxinExposure = 0;
  let impedancePerMille = 0;

  for (const structure of structures.values()) {
    if (structure.functions.length === 0) continue;
    // Cheap rejection before the square root: the field is small next to the world.
    const reach = structureEffectRadiusCu(structure.volume);
    if (Math.abs(structure.position.x - position.x) > reach) continue;
    if (Math.abs(structure.position.z - position.z) > reach) continue;
    if (distance(structure.position, position) > reach) continue;

    const foreign = structure.createdByLineageId !== lineageId;
    for (const fn of structure.functions) {
      const power = scaleByPerMille(fn.magnitude, structure.integrity);
      if (power <= 0) continue;
      switch (fn.id) {
        case 'shelter':
          upkeepDiscountPerMille = strongest(upkeepDiscountPerMille, Math.trunc(power / 2));
          break;
        case 'nursery':
          juvenileDiscountPerMille = strongest(juvenileDiscountPerMille, Math.trunc(power / 2));
          break;
        case 'conduit':
          energyPerTick = strongest(energyPerTick, scaleByPerMille(CONDUIT_ENERGY_AT_FULL, power));
          break;
        // A beacon acts on its own legibility, not on the eye of whoever stands beside it.
        // See `beaconRangeBonusCu`, which both the observation model and `applyInspect` read.
        case 'beacon':
          break;
        case 'filter':
          feedingYieldPerMille = strongest(feedingYieldPerMille, Math.trunc(power / 2));
          break;
        case 'reservoir':
          carryBonus = strongest(carryBonus, scaleByPerMille(RESERVOIR_CARRY_AT_FULL, power));
          break;
        case 'toxinWard':
          if (foreign) toxinExposure = strongest(toxinExposure, power);
          break;
        case 'barrier':
        case 'snare':
          if (foreign) {
            impedancePerMille = strongest(
              impedancePerMille,
              Math.min(MAX_IMPEDANCE_PER_MILLE, power),
            );
          }
          break;
        // `anchor` acts through `attach`, which resolves against the structure directly.
        case 'anchor':
          break;
      }
    }
  }

  // A structure whose only functions act elsewhere — `beacon` on its own legibility, `anchor`
  // through `attach` — leaves the ground around it untouched, and must be indistinguishable from
  // bare ground here.
  const untouched =
    upkeepDiscountPerMille === 0 &&
    juvenileDiscountPerMille === 0 &&
    energyPerTick === 0 &&
    feedingYieldPerMille === 0 &&
    carryBonus === 0 &&
    toxinExposure === 0 &&
    impedancePerMille === 0;
  if (untouched) return NO_STRUCTURE_EFFECTS;
  return {
    upkeepDiscountPerMille: clampPerMille(upkeepDiscountPerMille),
    juvenileDiscountPerMille: clampPerMille(juvenileDiscountPerMille),
    energyPerTick,
    feedingYieldPerMille: clampPerMille(feedingYieldPerMille),
    carryBonus,
    toxinExposure,
    impedancePerMille: clampPerMille(impedancePerMille),
  };
}

/**
 * How much further away a beacon is legible than an ordinary construction of the same bulk.
 *
 * Read by the observation model *and* by `applyInspect`, so an agent can never see a beacon it is
 * then refused permission to inspect — the divergence that made `collect/inventoryFull` fire on
 * every at-capacity tick before `5797c22`.
 */
export function beaconRangeBonusCu(structure: Pick<Structure, 'functions' | 'integrity'>): number {
  let bonus = 0;
  for (const fn of structure.functions) {
    if (fn.id !== 'beacon') continue;
    const power = scaleByPerMille(fn.magnitude, structure.integrity);
    bonus = strongest(bonus, scaleByPerMille(BEACON_RANGE_AT_FULL_CU, power));
  }
  return bonus;
}

/** Carrying volume available to an organism standing here. Observation and resolution must agree. */
export function effectiveCarryCapacity(base: number, effects: StructureEffects): number {
  return base + effects.carryBonus;
}

/** Step length available to an organism moving from here. */
export function effectiveSpeedCuPerTick(base: number, effects: StructureEffects): number {
  if (effects.impedancePerMille <= 0) return base;
  return Math.max(1, base - scaleByPerMille(base, effects.impedancePerMille));
}
