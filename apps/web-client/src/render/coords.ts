import { REGION_GRID, WORLD_SPAN_CU } from '@autocosm/domain';

/**
 * Shared world↔scene coordinate mapping.
 *
 * The simulation works in integer centi-units on a wrapped square. Babylon works in floats with
 * Y up. Everything that places a mesh goes through here so a change of scale never desynchronises
 * terrain, organisms and structures.
 */

/** Scene units per world centi-unit. The whole world is 96 scene units across. */
export const SCENE_SCALE = 96 / WORLD_SPAN_CU;

/** Vertical exaggeration. Real elevation range is narrow relative to the world's width. */
export const HEIGHT_SCALE = SCENE_SCALE * 1.9;

export const WORLD_SCENE_SPAN = WORLD_SPAN_CU * SCENE_SCALE;
export const REGION_SCENE_SPAN = WORLD_SCENE_SPAN / REGION_GRID;

/** Sea level sits at scene Y = 0 so water can be a flat plane. */
export function sceneX(xCu: number): number {
  return xCu * SCENE_SCALE - WORLD_SCENE_SPAN / 2;
}

export function sceneZ(zCu: number): number {
  return zCu * SCENE_SCALE - WORLD_SCENE_SPAN / 2;
}

export function sceneY(elevationCu: number): number {
  return elevationCu * HEIGHT_SCALE;
}

export function worldXFromScene(x: number): number {
  return (x + WORLD_SCENE_SPAN / 2) / SCENE_SCALE;
}

export function worldZFromScene(z: number): number {
  return (z + WORLD_SCENE_SPAN / 2) / SCENE_SCALE;
}
