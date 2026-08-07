import { describe, expect, it } from 'vitest';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import {
  DETAIL_OCTAVES,
  MIN_SAMPLES_PER_NOISE_CELL,
  TERRAIN_GRID,
  pushCellIndices,
  valueNoise,
} from './terrain';

/**
 * The terrain grid was wound backwards for the life of the project, so `ComputeNormals` pointed
 * every normal below the horizon and the sun contributed nothing to the largest surface in the
 * scene. Everything read as a flat pale wash — the "it all looks underwater" complaint — and no
 * amount of tuning the water, the fog or the shadows could have fixed it, because none of them can
 * show on a surface that receives no directional light.
 *
 * Nothing in the suite could have caught that: the mesh had the right vertices, the right colours
 * and the right material, and it rendered without error. Only the direction of its normals was
 * wrong. These tests run Babylon's real `ComputeNormals` over plain arrays, so the invariant is
 * checked against the same code the renderer uses, with no GPU and no scene.
 */

/** A heightfield with a bump in the middle, so normals must genuinely vary rather than be flat. */
function buildGrid(grid: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      const dx = col / (grid - 1) - 0.5;
      const dz = row / (grid - 1) - 0.5;
      positions.push(dx * 10, Math.exp(-(dx * dx + dz * dz) * 12) * 3, dz * 10);
    }
  }

  const indices: number[] = [];
  for (let row = 0; row < grid - 1; row += 1) {
    for (let col = 0; col < grid - 1; col += 1) {
      pushCellIndices(indices, row, col, grid);
    }
  }
  return { positions, indices };
}

function normalsOf(grid: number): Float32Array {
  const { positions, indices } = buildGrid(grid);
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals as unknown as number[]);
  return normals;
}

describe('terrain winding', () => {
  it('points every normal above the horizon so the sun can reach the surface', () => {
    const normals = normalsOf(16);

    let below = 0;
    for (let i = 1; i < normals.length; i += 3) {
      if ((normals[i] as number) <= 0) below += 1;
    }

    // A single normal below the horizon means that patch of ground is lit by ambient fill only.
    expect(below).toBe(0);
  });

  it('produces slope variation rather than a uniformly flat surface', () => {
    const normals = normalsOf(16);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 1; i < normals.length; i += 3) {
      const y = normals[i] as number;
      min = Math.min(min, y);
      max = Math.max(max, y);
    }

    // Directional light shades by N.L, so without a spread of normal.y there is no relief to see
    // however dramatic the underlying elevation is.
    expect(max).toBeGreaterThan(0.99);
    expect(min).toBeLessThan(0.9);
  });

  it('winds each cell into two triangles covering its four corners', () => {
    const indices: number[] = [];
    pushCellIndices(indices, 0, 0, 2);

    expect(indices).toHaveLength(6);
    expect(new Set(indices)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('reverses the surface when wound the other way, which is the bug this pins', () => {
    // Guards the test itself: if `ComputeNormals` were insensitive to winding, the assertions
    // above would pass no matter what `pushCellIndices` did.
    const { positions, indices } = buildGrid(16);
    const reversed: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      reversed.push(indices[i + 2] as number, indices[i + 1] as number, indices[i] as number);
    }

    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, reversed, normals as unknown as number[]);

    let below = 0;
    for (let i = 1; i < normals.length; i += 3) {
      if ((normals[i] as number) < 0) below += 1;
    }
    expect(below).toBeGreaterThan(0);
  });
});

/**
 * Detail was being chased in the wrong currency.
 *
 * The terrain surface is a sum of value-noise octaves sampled on a fixed vertex grid. Value noise
 * has features one lattice cell across, so an octave of frequency `f` on a `GRID`-vertex axis is
 * sampled `GRID / f` times per feature. Under two, it is past Nyquist — the octave is not rendered
 * finer, it is folded down into a coarse pattern that is not in the function at all.
 *
 * At the shipped `GRID = 128` the second octave (`f = 71`) had 1.80 samples per cell and lost 14% of
 * itself to that folding. The natural response to a surface that looks blobby — add a third, finer
 * octave — would have made it worse: `f = 140` gets 0.91 samples per cell and is 41% alias. The
 * roadmap proposed exactly that. Vertices have to come first; the noise function was never the
 * limit.
 *
 * These tests measure the real `valueNoise` against a dense ground truth rather than restating the
 * arithmetic, so `MIN_SAMPLES_PER_NOISE_CELL` is a threshold with a meaning rather than a number
 * someone picked. The tripwire is the first test: any future octave added below the bound fails
 * here instead of quietly turning relief into mush.
 */
describe('terrain detail resolves on the grid that draws it', () => {
  it('samples every octave often enough to reconstruct it', () => {
    const starved = DETAIL_OCTAVES.filter(
      (octave) => TERRAIN_GRID / octave.frequency < MIN_SAMPLES_PER_NOISE_CELL,
    ).map(
      (octave) =>
        `f=${octave.frequency}: ${(TERRAIN_GRID / octave.frequency).toFixed(2)} samples/cell`,
    );
    expect(starved).toEqual([]);
  });

  it('orders octaves coarse to fine with falling amplitude', () => {
    // A finer octave contributing more relief than a coarser one is not detail, it is a second
    // base layer, and it would dominate the silhouette it was meant to decorate.
    for (let i = 1; i < DETAIL_OCTAVES.length; i += 1) {
      const previous = DETAIL_OCTAVES[i - 1];
      const current = DETAIL_OCTAVES[i];
      if (!previous || !current) throw new Error('octave table is not dense');
      expect(current.frequency).toBeGreaterThan(previous.frequency);
      expect(current.amplitudeCu).toBeLessThan(previous.amplitudeCu);
    }
  });

  it('loses more of an octave the more sparsely it is sampled', () => {
    // Guards the threshold. If fidelity did not actually track sampling rate, the bound above
    // would be an arbitrary number that could be lowered to admit any octave at all.
    const curve = [2.5, 2.0, 1.28, 1.0].map((perCell) => ({
      perCell,
      loss: reconstructionLoss(Math.round(TERRAIN_GRID / perCell)),
    }));

    for (let i = 1; i < curve.length; i += 1) {
      const finer = curve[i];
      const coarser = curve[i - 1];
      if (!finer || !coarser) throw new Error('curve is not dense');
      expect(finer.loss).toBeGreaterThan(coarser.loss);
    }

    const atBound = curve[0];
    const atNyquistFloor = curve[curve.length - 1];
    if (!atBound || !atNyquistFloor) throw new Error('curve is not dense');

    // 7.8% at the bound against 37.7% at one sample per cell, measured.
    expect(atBound.loss).toBeLessThan(0.1);
    expect(atNyquistFloor.loss).toBeGreaterThan(atBound.loss * 3);
  });

  it('reconstructs every shipped octave within the loss the bound promises', () => {
    const lossy = DETAIL_OCTAVES.map((octave) => ({
      octave,
      loss: reconstructionLoss(octave.frequency),
    }))
      .filter((entry) => entry.loss >= 0.1)
      .map((entry) => `f=${entry.octave.frequency}: ${(entry.loss * 100).toFixed(1)}%`);
    expect(lossy).toEqual([]);
  });
});

/**
 * Fraction of an octave's amplitude lost when sampled on the terrain grid and reconstructed by the
 * same linear interpolation the mesh performs between its vertices.
 *
 * Measured along grid rows rather than over the whole surface. Nyquist is a per-axis property, and
 * on a row the bilinear filter collapses to the linear one, so this isolates exactly the quantity
 * in question while costing a few thousand evaluations instead of a million. The dense sample rate
 * must be far above `TERRAIN_GRID` and share no common factor with it — a first attempt compared
 * the grid against a "ground truth" sampled at 256, the grid's own resolution, which reported a
 * 0.01% loss for an octave that is entirely alias.
 */
function reconstructionLoss(frequency: number): number {
  const noise = valueNoise(4_242_424);
  const dense = 4_099;
  const rows = [17, 61, 103, 149, 197, 241];

  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  let squaredError = 0;
  let squaredSignal = 0;

  for (const row of rows) {
    const v = row / (TERRAIN_GRID - 1);
    const sampled = new Float64Array(TERRAIN_GRID);
    for (let col = 0; col < TERRAIN_GRID; col += 1) {
      sampled[col] = noise((col / (TERRAIN_GRID - 1)) * frequency, v * frequency) - 0.5;
    }

    for (let i = 0; i < dense; i += 1) {
      const u = i / (dense - 1);
      const truth = noise(u * frequency, v * frequency) - 0.5;
      const x = Math.min(u * (TERRAIN_GRID - 1), TERRAIN_GRID - 1.001);
      const col = Math.floor(x);
      const reconstructed = lerp(sampled[col] ?? 0, sampled[col + 1] ?? 0, x - col);
      squaredError += (truth - reconstructed) ** 2;
      squaredSignal += truth ** 2;
    }
  }

  return Math.sqrt(squaredError / Math.max(squaredSignal, Number.EPSILON));
}
