import { describe, expect, it } from 'vitest';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { pushCellIndices } from './terrain';

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
