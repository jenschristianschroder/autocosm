import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { PBRMetallicRoughnessMaterial } from '@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial';
import type { Scene } from '@babylonjs/core/scene';
import { REGION_GRID } from '@autocosm/domain';
import type { RegionDto } from '../types';
import { HEIGHT_SCALE, WORLD_SCENE_SPAN } from './coords';
import { markPickable } from './picking';

/**
 * Terrain surface.
 *
 * The API publishes each region's *mean* elevation, not a heightfield — a full heightfield would
 * be a large payload for something the observer only looks at. So the mesh is a smooth bicubic-ish
 * interpolation of authoritative regional means, roughened by a deterministic value-noise function
 * seeded from the world seed.
 *
 * This is presentation, not simulation: organisms and structures carry their own authoritative
 * elevation and are placed at it, so nothing an observer sees about *where things are* depends on
 * this interpolation. It only makes the ground look like ground.
 */

/** Vertices per axis. 128² keeps the mesh under ~33k verts: one draw call, no LOD needed. */
const GRID = 128;

/**
 * Emit the two triangles of one heightfield cell into `indices`.
 *
 * Winding is load-bearing, not cosmetic: `VertexData.ComputeNormals` derives each normal from the
 * order its triangles are wound, so reversing this reverses the entire surface. The grid was wound
 * the other way round for the life of the project, which put every normal below the horizon —
 * measured at a median of 163 degrees from vertical. A surface facing away from the sun takes no
 * directional light at all, so the terrain was lit by the flat ambient fill alone. That is why
 * relief, shadows and depth-graded water all rendered as one uniform pale wash however they were
 * tuned: none of them can show on a surface the sun never reaches.
 *
 * Exported so the invariant can be tested against Babylon's real normal computation without a GPU.
 */
export function pushCellIndices(indices: number[], row: number, col: number, grid: number): void {
  const a = row * grid + col;
  const b = a + 1;
  const c = a + grid;
  const d = c + 1;
  indices.push(a, b, c, b, d, c);
}

export interface TerrainHandle {
  readonly mesh: Mesh;
  /** Interpolated scene-space height, used to keep the camera above ground. */
  heightAt(sceneXValue: number, sceneZValue: number): number;
  /** Which region a point on the surface belongs to, for click-to-inspect. */
  regionAt(sceneXValue: number, sceneZValue: number): RegionDto | undefined;
  dispose(): void;
}

const BIOME_COLOURS: Record<string, [number, number, number]> = {
  // `abyss` covers 24 of 64 regions — more of the world than any other biome — so it cannot be
  // near-black without the map losing a third of its readable area. Dark enough to read as deep,
  // light enough to show relief through the water above it.
  abyss: [0.1, 0.15, 0.23],
  shallows: [0.18, 0.32, 0.36],
  shore: [0.55, 0.5, 0.36],
  plain: [0.24, 0.38, 0.2],
  highland: [0.3, 0.33, 0.24],
  ridge: [0.42, 0.41, 0.4],
};

export function buildTerrain(
  scene: Scene,
  regions: readonly RegionDto[],
  seed: number,
): TerrainHandle {
  const elevation = regionField(regions, (r) => r.meanElevationCu, 0);
  const colours = regionColourField(regions);
  const noise = valueNoise(seed);

  const positions = new Float32Array(GRID * GRID * 3);
  const normals = new Float32Array(GRID * GRID * 3);
  const uvs = new Float32Array(GRID * GRID * 2);
  const colors = new Float32Array(GRID * GRID * 4);
  const heights = new Float32Array(GRID * GRID);
  const indices: number[] = [];

  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < GRID; col += 1) {
      const i = row * GRID + col;
      const u = col / (GRID - 1);
      const v = row / (GRID - 1);

      // Region-space sample coordinates, offset by half a region so a sample at u=0 reads the
      // centre of region 0 rather than its corner.
      const rx = u * REGION_GRID - 0.5;
      const rz = v * REGION_GRID - 0.5;

      const base = bilinear(elevation, rx, rz);
      const detail = (noise(u * 26, v * 26) - 0.5) * 260 + (noise(u * 71, v * 71) - 0.5) * 90;
      const elevationCu = base + detail;
      const y = elevationCu * HEIGHT_SCALE;

      heights[i] = y;
      positions[i * 3] = (u - 0.5) * WORLD_SCENE_SPAN;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = (v - 0.5) * WORLD_SCENE_SPAN;
      uvs[i * 2] = u * REGION_GRID;
      uvs[i * 2 + 1] = v * REGION_GRID;

      const [r, g, b] = sampleColour(colours, rx, rz);
      // Depth is cued by the water sheet above (`water.ts`), which tints from coastal teal to navy.
      // Applying the full cue here as well double-counted it: submerged ground was desaturated to
      // near-black and then covered by dark blue water, so the abyss lost all structure. Keep only
      // a light touch, enough that a seabed does not read as dry land seen through glass.
      const submerged = elevationCu < 0 ? Math.min(1, -elevationCu / 1800) : 0;
      colors[i * 4] = r * (1 - submerged * 0.3);
      colors[i * 4 + 1] = g * (1 - submerged * 0.2);
      colors[i * 4 + 2] = b * (1 - submerged * 0.05) + submerged * 0.05;
      colors[i * 4 + 3] = 1;
    }
  }

  for (let row = 0; row < GRID - 1; row += 1) {
    for (let col = 0; col < GRID - 1; col += 1) {
      pushCellIndices(indices, row, col, GRID);
    }
  }

  VertexData.ComputeNormals(positions, indices, normals);

  const mesh = new Mesh('terrain', scene);
  const data = new VertexData();
  data.positions = positions as unknown as number[];
  data.indices = indices;
  data.normals = normals as unknown as number[];
  data.uvs = uvs as unknown as number[];
  data.colors = colors as unknown as number[];
  data.applyToMesh(mesh, false);
  mesh.receiveShadows = true;
  mesh.freezeWorldMatrix();
  markPickable(mesh, 'terrain', false);

  const material = new PBRMetallicRoughnessMaterial('terrainMaterial', scene);
  material.baseColor = new Color3(1, 1, 1);
  material.metallic = 0.02;
  material.roughness = 0.92;
  mesh.material = material;

  const cell = WORLD_SCENE_SPAN / (GRID - 1);
  const byCell = new Map<string, RegionDto>();
  for (const region of regions) byCell.set(`${region.col}:${region.row}`, region);

  return {
    mesh,
    heightAt(x, z) {
      const col = clamp((x + WORLD_SCENE_SPAN / 2) / cell, 0, GRID - 1.001);
      const row = clamp((z + WORLD_SCENE_SPAN / 2) / cell, 0, GRID - 1.001);
      const c0 = Math.floor(col);
      const r0 = Math.floor(row);
      const fx = col - c0;
      const fz = row - r0;
      const h00 = heights[r0 * GRID + c0] ?? 0;
      const h10 = heights[r0 * GRID + c0 + 1] ?? h00;
      const h01 = heights[(r0 + 1) * GRID + c0] ?? h00;
      const h11 = heights[(r0 + 1) * GRID + c0 + 1] ?? h00;
      return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
    },
    regionAt(x, z) {
      // The surface is a smoothed interpolation of regional means, so a point on it belongs to
      // whichever region grid cell it falls in — not to whichever vertex happened to be picked.
      const u = (x + WORLD_SCENE_SPAN / 2) / WORLD_SCENE_SPAN;
      const v = (z + WORLD_SCENE_SPAN / 2) / WORLD_SCENE_SPAN;
      const col = clampInt(Math.floor(u * REGION_GRID), 0, REGION_GRID - 1);
      const row = clampInt(Math.floor(v * REGION_GRID), 0, REGION_GRID - 1);
      return byCell.get(`${col}:${row}`);
    },
    dispose() {
      material.dispose();
      mesh.dispose(false, true);
      byCell.clear();
    },
  };
}

/**
 * Extract a REGION_GRID² scalar field.
 *
 * Missing cells are filled with the mean of those present. That is a degraded-mode fallback for a
 * partial field, not the normal path: callers pass the world's full regional field from `/world`,
 * because a snapshot carries only the observed neighbourhood and filling the other 86% with a
 * constant draws most of the world as a featureless plate.
 */
function regionField(
  regions: readonly RegionDto[],
  pick: (r: RegionDto) => number,
  fallback: number,
): Float32Array {
  const field = new Float32Array(REGION_GRID * REGION_GRID).fill(Number.NaN);
  for (const region of regions) field[region.row * REGION_GRID + region.col] = pick(region);

  let sum = 0;
  let count = 0;
  for (const value of field) {
    if (!Number.isNaN(value)) {
      sum += value;
      count += 1;
    }
  }
  const mean = count > 0 ? sum / count : fallback;
  for (let i = 0; i < field.length; i += 1) {
    if (Number.isNaN(field[i] ?? Number.NaN)) field[i] = mean;
  }
  return field;
}

function regionColourField(regions: readonly RegionDto[]): Float32Array {
  const field = new Float32Array(REGION_GRID * REGION_GRID * 3).fill(0.3);
  for (const region of regions) {
    const rgb = BIOME_COLOURS[region.biome] ?? [0.3, 0.3, 0.3];
    const i = (region.row * REGION_GRID + region.col) * 3;
    // Mineral-rich ground reads warmer; this is a legible cue, not a simulated property.
    const warm = region.mineralRichness / 1000;
    field[i] = rgb[0] * (0.85 + warm * 0.4);
    field[i + 1] = rgb[1] * (0.9 + warm * 0.1);
    field[i + 2] = rgb[2] * (0.95 - warm * 0.2);
  }
  return field;
}

function bilinear(field: Float32Array, x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const at = (c: number, r: number): number => {
    const cc = clampInt(c, 0, REGION_GRID - 1);
    const rr = clampInt(r, 0, REGION_GRID - 1);
    return field[rr * REGION_GRID + cc] ?? 0;
  };
  return lerp(
    lerp(at(x0, z0), at(x0 + 1, z0), smooth(fx)),
    lerp(at(x0, z0 + 1), at(x0 + 1, z0 + 1), smooth(fx)),
    smooth(fz),
  );
}

/**
 * Sample the regional colour field with the same smoothed bilinear filter used for height.
 *
 * Nearest-neighbour sampling here would draw the world as an 8x8 grid of flat tiles with hard
 * seams, while the ground beneath them curved smoothly — biomes blend into one another instead.
 */
function sampleColour(field: Float32Array, x: number, z: number): [number, number, number] {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fz = smooth(z - z0);
  const at = (c: number, r: number, channel: number): number => {
    const cc = clampInt(c, 0, REGION_GRID - 1);
    const rr = clampInt(r, 0, REGION_GRID - 1);
    return field[(rr * REGION_GRID + cc) * 3 + channel] ?? 0.3;
  };
  const channel = (i: number): number =>
    lerp(
      lerp(at(x0, z0, i), at(x0 + 1, z0, i), fx),
      lerp(at(x0, z0 + 1, i), at(x0 + 1, z0 + 1, i), fx),
      fz,
    );
  return [channel(0), channel(1), channel(2)];
}

/** Deterministic value noise. No `Math.random`: the same world always looks the same. */
function valueNoise(seed: number): (x: number, z: number) => number {
  const hash = (x: number, z: number): number => {
    let h = (Math.imul(x | 0, 374_761_393) ^ Math.imul(z | 0, 668_265_263) ^ seed) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295;
  };
  return (x, z) => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = smooth(x - x0);
    const fz = smooth(z - z0);
    return lerp(
      lerp(hash(x0, z0), hash(x0 + 1, z0), fx),
      lerp(hash(x0, z0 + 1), hash(x0 + 1, z0 + 1), fx),
      fz,
    );
  };
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const clampInt = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
