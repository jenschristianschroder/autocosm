/**
 * Units of measure for Autocosm.
 *
 * Every authoritative quantity in the simulation is an integer. Integer arithmetic keeps
 * ticks bit-for-bit reproducible across machines and Node.js versions; floating point is
 * only ever used for presentation in the browser.
 *
 * | Symbol | Meaning                                                                  |
 * | ------ | ------------------------------------------------------------------------ |
 * | `cu`   | centi-unit of length. 100 cu = 1 world unit (wu). Rendered as 1 metre.    |
 * | `eu`   | energy unit. Metabolism, movement and construction are priced in `eu`.    |
 * | `mu`   | material unit. Mass and material quantities are counted in `mu`.          |
 * | `hp`   | health point.                                                            |
 * | `‰`    | per-mille (0..1000). Traits, material properties and ratios use this.     |
 * | `tick` | one logical simulation step. Wall-clock mapping is configuration.         |
 */

/** Length in centi-units. 100 cu == 1 world unit. */
export type Cu = number;
/** Energy in energy units. */
export type Eu = number;
/** Material quantity / mass in material units. */
export type Mu = number;
/** Health in health points. */
export type Hp = number;
/** A value expressed in per-mille, always clamped to `[0, 1000]`. */
export type PerMille = number;
/** A logical simulation step index, monotonically increasing from 0. */
export type TickIndex = number;

/** Upper bound of the per-mille scale. */
export const PER_MILLE: PerMille = 1000;

/** Number of centi-units in one world unit. */
export const CU_PER_UNIT = 100;

/**
 * Clamp `value` into `[min, max]`.
 *
 * `NaN` collapses to `min` so that a corrupted upstream value can never poison a tick
 * with a silently propagating `NaN`.
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp to the per-mille range and truncate to an integer. */
export function clampPerMille(value: number): PerMille {
  return Math.trunc(clamp(value, 0, PER_MILLE));
}

/** Truncating integer conversion that never yields `NaN` or `Infinity`. */
export function toInt(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}

/**
 * Multiply `value` by a per-mille ratio using integer arithmetic.
 *
 * `scaleByPerMille(200, 500) === 100`.
 */
export function scaleByPerMille(value: number, ratio: PerMille): number {
  return Math.trunc((toInt(value) * clampPerMille(ratio)) / PER_MILLE);
}

/** Linear interpolation on the per-mille scale, rounded toward zero. */
export function lerpPerMille(from: number, to: number, ratio: PerMille): number {
  const r = clampPerMille(ratio);
  return toInt(from) + Math.trunc(((toInt(to) - toInt(from)) * r) / PER_MILLE);
}

/** Integer square root, used where a deterministic magnitude curve is needed. */
export function isqrt(value: number): number {
  const v = Math.max(0, toInt(value));
  if (v < 2) return v;
  let x = v;
  let y = Math.trunc((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.trunc((x + Math.trunc(v / x)) / 2);
  }
  return x;
}
