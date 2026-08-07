import { describe, expect, it } from 'vitest';
import { REGION_GRID, WORLD_SPAN_CU, makePosition, regionCoordOf } from '@autocosm/domain';
import { regionCellOf } from './region';

/**
 * The client re-derives region membership for resource nodes, which publish only a position. That
 * is a duplicate of world logic, so it is pinned to the world rather than trusted.
 */

describe('regionCellOf', () => {
  it('agrees with the simulation across the whole world', () => {
    const step = 137; // Deliberately coprime with the region span, so bin edges are not skipped.
    for (let coordinate = 0; coordinate < WORLD_SPAN_CU; coordinate += step) {
      const expected = regionCoordOf(makePosition(coordinate, coordinate));
      expect(regionCellOf(coordinate)).toBe(expected.col);
      expect(regionCellOf(coordinate)).toBe(expected.row);
    }
  });

  it('agrees with the simulation on every region boundary', () => {
    const span = WORLD_SPAN_CU / REGION_GRID;
    for (let cell = 0; cell < REGION_GRID; cell += 1) {
      for (const offset of [0, 1, span - 1]) {
        const coordinate = cell * span + offset;
        expect(regionCellOf(coordinate)).toBe(regionCoordOf(makePosition(coordinate, 0)).col);
      }
    }
  });

  it('stays inside the grid for coordinates outside the world', () => {
    expect(regionCellOf(-1)).toBe(0);
    expect(regionCellOf(-WORLD_SPAN_CU)).toBe(0);
    expect(regionCellOf(WORLD_SPAN_CU)).toBe(REGION_GRID - 1);
    expect(regionCellOf(WORLD_SPAN_CU * 4)).toBe(REGION_GRID - 1);
  });
});
