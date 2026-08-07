import { MIN_ELEVATION_CU } from '@autocosm/domain';
import { HEIGHT_SCALE } from './coords';

/**
 * Depth shading for the sea surface.
 *
 * The world is mostly submerged — roughly three quarters of its regions sit below sea level — so a
 * single uniformly translucent sheet stretched over all of it made every biome read the same, as
 * though the whole world were underwater. Terrain already desaturates with depth
 * (`terrain.ts`); a uniform sheet flattened that gradient back out again.
 *
 * This restores it. Depth is carried almost entirely by *hue* — coastal teal shifting to open-ocean
 * navy — and only weakly by opacity, because opacity hides and hue does not. The result is baked
 * into the water mesh's vertex colours, so it costs one buffer upload when the terrain changes and
 * nothing per frame.
 *
 * The first version of this shaded the abyss to `alpha 0.94`, on the reasoning that over deep ocean
 * "it is the water itself that should be read". Measured against the deployment, that was wrong in
 * a way worth recording: 48 of 64 regions sit below sea level and 24 of those are abyss, so an
 * opaque sheet was covering three quarters of the world with a surface carrying no information at
 * all. A spectator's whole purpose is to look *at* things, and every one of them rests on the
 * ground. Water is never allowed to occlude the seabed now — see `MAX_ALPHA`.
 *
 * Pure and deterministic: the same depth always yields the same shade, which is what makes it
 * testable without a GPU.
 */

export interface WaterShade {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Scene-space depth at which water reads as full open ocean. The world's deepest possible point. */
export const FULL_DEPTH_SCENE = -MIN_ELEVATION_CU * HEIGHT_SCALE;

/**
 * The seabed must stay legible everywhere, because everything a spectator can look at rests on the
 * ground and three quarters of the ground is submerged. Depth is expressed as colour, not as
 * occlusion, so this stays low enough that relief and biome read through even the deepest water.
 */
const MAX_ALPHA = 0.62;

/** Sunlit coastal water. */
const SHALLOW: readonly [number, number, number] = [0.16, 0.46, 0.44];

/** Open ocean. */
const DEEP: readonly [number, number, number] = [0.01, 0.05, 0.16];

/**
 * Opacity rises sub-linearly so the shallows stay genuinely see-through instead of hazing over
 * within a few metres of shore.
 */
const ALPHA_CURVE = 0.7;

/** Hue shifts faster than opacity, so colour carries depth before transparency has to. */
const COLOUR_CURVE = 0.5;

/**
 * @param depthScene how far the ground lies below sea level, in scene units. Zero or negative
 * means the ground is at or above the surface, where there is no water to draw.
 */
export function waterShade(depthScene: number): WaterShade {
  if (!(depthScene > 0)) return { r: SHALLOW[0], g: SHALLOW[1], b: SHALLOW[2], a: 0 };

  const t = Math.min(1, depthScene / FULL_DEPTH_SCENE);
  const hue = Math.pow(t, COLOUR_CURVE);
  return {
    r: lerp(SHALLOW[0], DEEP[0], hue),
    g: lerp(SHALLOW[1], DEEP[1], hue),
    b: lerp(SHALLOW[2], DEEP[2], hue),
    a: MAX_ALPHA * Math.pow(t, ALPHA_CURVE),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
