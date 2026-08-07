import { REGION_GRID, WORLD_SPAN_CU } from '@autocosm/domain';

/**
 * Which region column or row a world coordinate falls in.
 *
 * `RegionDto` publishes `col`/`row`, but a resource node publishes only `x`/`z`, so membership has
 * to be recomputed on the client to answer "what is in this region". This duplicates the
 * simulation's own binning, so `region.test.ts` pins it against `regionCoordOf` — if the world ever
 * changes how it divides itself, the duplicate fails rather than quietly disagreeing.
 */
export function regionCellOf(coordinateCu: number): number {
  const span = WORLD_SPAN_CU / REGION_GRID;
  const cell = Math.floor(coordinateCu / span);
  return Math.min(REGION_GRID - 1, Math.max(0, cell));
}
