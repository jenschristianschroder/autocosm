import type { Biome } from './entities.js';
import { MAX_ELEVATION_CU, MIN_ELEVATION_CU, WORLD_SPAN_CU, type Position } from './geometry.js';
import { Prng, hashSeed } from './prng.js';
import { type Cu, clamp, toInt } from './units.js';

/**
 * Procedural terrain.
 *
 * The height field is a pure function of the world seed, so the tick engine and the browser
 * derive byte-identical terrain without shipping a heightmap asset. Three octaves of value
 * noise are combined with integer bilinear interpolation; no floating point is used, so the
 * simulation and the renderer agree exactly on where the shoreline is.
 */
interface Octave {
  readonly divisions: number;
  readonly amplitude: number;
  readonly values: Int32Array;
}

const OCTAVE_SPECS: readonly { divisions: number; amplitude: number }[] = [
  { divisions: 4, amplitude: 2400 },
  { divisions: 12, amplitude: 900 },
  { divisions: 32, amplitude: 300 },
];

/** Elevation offset applied after summing octaves, tuning the land/water ratio. */
const SEA_LEVEL_BIAS = -520;

export class TerrainField {
  readonly seed: number;
  readonly #octaves: readonly Octave[];

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.#octaves = OCTAVE_SPECS.map((spec, index) => {
      const rng = new Prng(hashSeed('terrain', this.seed, index));
      const side = spec.divisions + 1;
      const values = new Int32Array(side * side);
      for (let row = 0; row < side; row += 1) {
        for (let col = 0; col < side; col += 1) {
          // Wrap the last row/column onto the first so the toroidal world is seamless.
          const c = col === spec.divisions ? 0 : col;
          const r = row === spec.divisions ? 0 : row;
          values[row * side + col] =
            c === col && r === row
              ? rng.nextRange(-spec.amplitude, spec.amplitude)
              : (values[r * side + c] ?? 0);
        }
      }
      return { divisions: spec.divisions, amplitude: spec.amplitude, values };
    });
  }

  /** Elevation in centi-units relative to sea level. */
  elevationAt(x: Cu, z: Cu): Cu {
    let total = SEA_LEVEL_BIAS;
    for (const octave of this.#octaves) {
      total += sampleOctave(octave, x, z);
    }
    return Math.trunc(clamp(total, MIN_ELEVATION_CU, MAX_ELEVATION_CU));
  }

  elevationAtPosition(position: Position): Cu {
    return this.elevationAt(position.x, position.z);
  }

  /** Mean elevation and water coverage over an axis-aligned area, sampled on a fixed grid. */
  survey(originX: Cu, originZ: Cu, spanCu: Cu, samples = 8): TerrainSurvey {
    let sum = 0;
    let underwater = 0;
    let min = MAX_ELEVATION_CU;
    let max = MIN_ELEVATION_CU;
    const step = Math.max(1, Math.trunc(spanCu / samples));
    let count = 0;
    for (let dz = 0; dz < spanCu; dz += step) {
      for (let dx = 0; dx < spanCu; dx += step) {
        const e = this.elevationAt(originX + dx, originZ + dz);
        sum += e;
        if (e < 0) underwater += 1;
        if (e < min) min = e;
        if (e > max) max = e;
        count += 1;
      }
    }
    if (count === 0) return { meanElevationCu: 0, waterCoveragePerMille: 0, minCu: 0, maxCu: 0 };
    return {
      meanElevationCu: Math.trunc(sum / count),
      waterCoveragePerMille: Math.trunc((underwater * 1000) / count),
      minCu: min,
      maxCu: max,
    };
  }
}

export interface TerrainSurvey {
  readonly meanElevationCu: Cu;
  readonly waterCoveragePerMille: number;
  readonly minCu: Cu;
  readonly maxCu: Cu;
}

function sampleOctave(octave: Octave, x: Cu, z: Cu): number {
  const side = octave.divisions + 1;
  const cell = WORLD_SPAN_CU / octave.divisions;
  const wx = ((toInt(x) % WORLD_SPAN_CU) + WORLD_SPAN_CU) % WORLD_SPAN_CU;
  const wz = ((toInt(z) % WORLD_SPAN_CU) + WORLD_SPAN_CU) % WORLD_SPAN_CU;
  const col = Math.min(octave.divisions - 1, Math.floor(wx / cell));
  const row = Math.min(octave.divisions - 1, Math.floor(wz / cell));
  // Fractional position within the cell, expressed in per-mille to stay integral.
  const fx = Math.trunc(((wx - col * cell) * 1000) / cell);
  const fz = Math.trunc(((wz - row * cell) * 1000) / cell);
  const sx = smoothstepPerMille(fx);
  const sz = smoothstepPerMille(fz);

  const v00 = octave.values[row * side + col] ?? 0;
  const v10 = octave.values[row * side + col + 1] ?? 0;
  const v01 = octave.values[(row + 1) * side + col] ?? 0;
  const v11 = octave.values[(row + 1) * side + col + 1] ?? 0;

  const top = v00 + Math.trunc(((v10 - v00) * sx) / 1000);
  const bottom = v01 + Math.trunc(((v11 - v01) * sx) / 1000);
  return top + Math.trunc(((bottom - top) * sz) / 1000);
}

/** Integer smoothstep on the per-mille scale: `3t² − 2t³`. */
function smoothstepPerMille(t: number): number {
  const x = Math.trunc(clamp(t, 0, 1000));
  return Math.trunc((3 * x * x) / 1000 - (2 * x * x * x) / 1_000_000);
}

/** Classify terrain into a biome purely from elevation. */
export function biomeForElevation(elevationCu: Cu): Biome {
  if (elevationCu < -1200) return 'abyss';
  if (elevationCu < -150) return 'shallows';
  if (elevationCu < 150) return 'shore';
  if (elevationCu < 1100) return 'plain';
  if (elevationCu < 2200) return 'highland';
  return 'ridge';
}

/** Elevation band each habitat preference targets, used when placing a founding cell. */
export const HABITAT_ELEVATION_TARGET: Readonly<Record<string, readonly [Cu, Cu]>> = Object.freeze({
  abyss: [MIN_ELEVATION_CU, -1200],
  shallows: [-1200, -150],
  shore: [-150, 150],
  plain: [150, 1100],
  highland: [1100, 2200],
});
