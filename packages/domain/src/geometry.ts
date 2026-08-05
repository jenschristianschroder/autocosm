import { type Cu, CU_PER_UNIT, isqrt, toInt } from './units.js';
import { type RegionId, asRegionId } from './ids.js';

/**
 * World geometry.
 *
 * Horizontal position is a signed integer pair on the `xz` plane in centi-units.
 * Elevation (`y`) is measured from sea level, positive upward. All arithmetic is integral
 * so that positions replay exactly.
 */
export interface Position {
  readonly x: Cu;
  readonly z: Cu;
}

/** Size of the world along each horizontal axis, in world units. */
export const WORLD_UNITS = 480;
/** Size of the world along each horizontal axis, in centi-units. */
export const WORLD_SPAN_CU: Cu = WORLD_UNITS * CU_PER_UNIT;
/** Number of regions along each axis. The world is a `REGION_GRID x REGION_GRID` lattice. */
export const REGION_GRID = 8;
/** Size of one region along each axis, in centi-units. */
export const REGION_SPAN_CU: Cu = WORLD_SPAN_CU / REGION_GRID;

/** Lowest and highest terrain elevation, in centi-units relative to sea level. */
export const MIN_ELEVATION_CU: Cu = -2400;
export const MAX_ELEVATION_CU: Cu = 3200;

export function makePosition(x: number, z: number): Position {
  return { x: wrapAxis(x), z: wrapAxis(z) };
}

/**
 * Wrap a coordinate onto the toroidal world.
 *
 * The biosphere is bounded but seamless: leaving one edge re-enters the opposite edge.
 * Wrapping (rather than clamping) avoids artificial population pile-ups at the borders.
 */
export function wrapAxis(value: number): Cu {
  const v = toInt(value);
  const m = v % WORLD_SPAN_CU;
  return m < 0 ? m + WORLD_SPAN_CU : m;
}

/** Shortest signed displacement from `a` to `b` along one wrapped axis. */
export function axisDelta(a: Cu, b: Cu): Cu {
  const raw = wrapAxis(b) - wrapAxis(a);
  if (raw > WORLD_SPAN_CU / 2) return raw - WORLD_SPAN_CU;
  if (raw < -WORLD_SPAN_CU / 2) return raw + WORLD_SPAN_CU;
  return raw;
}

/** Squared toroidal distance, in cu². Preferred for comparisons: no square root needed. */
export function distanceSquared(a: Position, b: Position): number {
  const dx = axisDelta(a.x, b.x);
  const dz = axisDelta(a.z, b.z);
  return dx * dx + dz * dz;
}

/** Toroidal distance in centi-units, truncated to an integer. */
export function distance(a: Position, b: Position): Cu {
  return isqrt(distanceSquared(a, b));
}

/** True when `b` lies within `radius` centi-units of `a`. */
export function withinRadius(a: Position, b: Position, radius: Cu): boolean {
  const r = Math.max(0, toInt(radius));
  return distanceSquared(a, b) <= r * r;
}

/**
 * Move from `origin` toward `target` by at most `maxStep` centi-units.
 *
 * Integer division keeps the step deterministic; the residual is discarded rather than
 * accumulated, which caps drift at one centi-unit per axis per tick.
 */
export function stepToward(origin: Position, target: Position, maxStep: Cu): Position {
  const step = Math.max(0, toInt(maxStep));
  if (step === 0) return origin;
  const dx = axisDelta(origin.x, target.x);
  const dz = axisDelta(origin.z, target.z);
  const dist = isqrt(dx * dx + dz * dz);
  if (dist === 0) return origin;
  if (dist <= step) return makePosition(target.x, target.z);
  return makePosition(
    origin.x + Math.trunc((dx * step) / dist),
    origin.z + Math.trunc((dz * step) / dist),
  );
}

/** Region column/row for a position. */
export interface RegionCoord {
  readonly col: number;
  readonly row: number;
}

export function regionCoordOf(position: Position): RegionCoord {
  return {
    col: Math.min(REGION_GRID - 1, Math.floor(wrapAxis(position.x) / REGION_SPAN_CU)),
    row: Math.min(REGION_GRID - 1, Math.floor(wrapAxis(position.z) / REGION_SPAN_CU)),
  };
}

export function regionIdOf(position: Position): RegionId {
  const { col, row } = regionCoordOf(position);
  return regionIdAt(col, row);
}

export function regionIdAt(col: number, row: number): RegionId {
  const c = ((toInt(col) % REGION_GRID) + REGION_GRID) % REGION_GRID;
  const r = ((toInt(row) % REGION_GRID) + REGION_GRID) % REGION_GRID;
  return asRegionId(`r${c}x${r}`);
}

/** Parse a region identifier back into grid coordinates. Returns `null` when malformed. */
export function regionCoordFromId(id: string): RegionCoord | null {
  const match = /^r(\d+)x(\d+)$/.exec(id);
  if (!match) return null;
  const col = Number(match[1]);
  const row = Number(match[2]);
  if (col >= REGION_GRID || row >= REGION_GRID) return null;
  return { col, row };
}

/** Centre position of a region, used to anchor snapshots and region-level effects. */
export function regionCentre(coord: RegionCoord): Position {
  return makePosition(
    coord.col * REGION_SPAN_CU + REGION_SPAN_CU / 2,
    coord.row * REGION_SPAN_CU + REGION_SPAN_CU / 2,
  );
}

/** All region ids in stable row-major order. Ordering matters for tick determinism. */
export function allRegionIds(): readonly RegionId[] {
  const ids: RegionId[] = [];
  for (let row = 0; row < REGION_GRID; row += 1) {
    for (let col = 0; col < REGION_GRID; col += 1) {
      ids.push(regionIdAt(col, row));
    }
  }
  return ids;
}

/** The region and its eight wrapped neighbours, in stable order. */
export function regionNeighbourhood(id: RegionId): readonly RegionId[] {
  const coord = regionCoordFromId(id);
  if (!coord) return [id];
  const ids: RegionId[] = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      ids.push(regionIdAt(coord.col + dc, coord.row + dr));
    }
  }
  return ids;
}
