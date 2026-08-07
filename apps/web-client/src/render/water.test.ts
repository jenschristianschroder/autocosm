import { describe, expect, it } from 'vitest';
import { MIN_ELEVATION_CU } from '@autocosm/domain';
import { HEIGHT_SCALE } from './coords';
import { FULL_DEPTH_SCENE, waterShade } from './water';

/**
 * The sea surface is the single largest thing an observer looks at, and a uniform sheet over a
 * world that is three quarters submerged is what made everything read as underwater. These pin the
 * properties that fix is built on, none of which need a GPU to check.
 */

describe('waterShade', () => {
  it('draws nothing where the ground is at or above sea level', () => {
    for (const depth of [0, -0.001, -1, -FULL_DEPTH_SCENE]) {
      expect(waterShade(depth).a).toBe(0);
    }
  });

  it('veils the shallows lightly and never occludes the abyss', () => {
    // A shoreline shelf ~200 cu down: the ground below is the interesting thing, so barely veil it.
    const shelf = waterShade(200 * HEIGHT_SCALE);
    expect(shelf.a).toBeLessThan(0.2);

    // The world's deepest point. This asserted `> 0.9` when the sheet was designed to read as
    // opaque ocean. That hid three quarters of the world — every organism and structure rests on
    // the ground — so the intent is now the opposite: deep water must stay a window.
    const abyss = waterShade(FULL_DEPTH_SCENE);
    expect(abyss.a).toBeGreaterThan(0.4);
    expect(abyss.a).toBeLessThan(0.7);
  });

  it('never occludes the seabed at any depth the world can generate', () => {
    for (let i = 0; i <= 64; i += 1) {
      expect(waterShade((FULL_DEPTH_SCENE * i) / 64).a).toBeLessThan(0.7);
    }
  });

  it('carries depth by hue more strongly than by opacity', () => {
    // The property the fix rests on: colour does the work, because colour costs no legibility.
    const shallow = waterShade(FULL_DEPTH_SCENE * 0.05);
    const deep = waterShade(FULL_DEPTH_SCENE);

    const hueTravel =
      Math.abs(deep.r - shallow.r) + Math.abs(deep.g - shallow.g) + Math.abs(deep.b - shallow.b);
    expect(hueTravel).toBeGreaterThan(deep.a - shallow.a);
  });

  it('never becomes fully opaque, so the seabed is always faintly present', () => {
    for (const depth of [FULL_DEPTH_SCENE, FULL_DEPTH_SCENE * 4]) {
      expect(waterShade(depth).a).toBeLessThan(1);
    }
  });

  it('thickens monotonically with depth', () => {
    let previous = -1;
    for (let i = 0; i <= 64; i += 1) {
      const shade = waterShade((FULL_DEPTH_SCENE * i) / 64);
      expect(shade.a).toBeGreaterThanOrEqual(previous);
      previous = shade.a;
    }
  });

  it('saturates past the deepest possible ground rather than running away', () => {
    const floor = waterShade(FULL_DEPTH_SCENE);
    const beyond = waterShade(FULL_DEPTH_SCENE * 10);
    expect(beyond).toEqual(floor);
  });

  it('shifts from coastal teal to open-ocean navy', () => {
    const shallow = waterShade(FULL_DEPTH_SCENE * 0.02);
    const deep = waterShade(FULL_DEPTH_SCENE);

    // Shallow water is dominated by green; deep water by blue.
    expect(shallow.g).toBeGreaterThan(shallow.b);
    expect(deep.b).toBeGreaterThan(deep.g);

    // And it darkens overall, so depth reads even where alpha is clipped by the sun's glint.
    expect(deep.r + deep.g + deep.b).toBeLessThan(shallow.r + shallow.g + shallow.b);
  });

  it('stays inside the unit colour range at every depth', () => {
    for (let i = -8; i <= 72; i += 1) {
      const shade = waterShade((FULL_DEPTH_SCENE * i) / 64);
      for (const channel of [shade.r, shade.g, shade.b, shade.a]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('measures full depth against the world the simulation can actually generate', () => {
    // If the domain ever deepens the world, the ramp must follow it rather than clip early.
    expect(FULL_DEPTH_SCENE).toBeCloseTo(-MIN_ELEVATION_CU * HEIGHT_SCALE, 10);
    expect(FULL_DEPTH_SCENE).toBeGreaterThan(0);
  });
});
