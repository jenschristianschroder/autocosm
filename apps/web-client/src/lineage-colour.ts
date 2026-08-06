/**
 * A lineage's colour is derived from its mean genotype by `deriveVisual`, which returns `hue` in
 * **degrees** (0-359), not per-mille like every other field on `VisualPhenotype`. Converting it
 * here, once, is what keeps the lineage list, the inspector and the 3D scene agreeing on what
 * colour a given lineage is; a second, slightly different conversion elsewhere would silently show
 * the same lineage as two different colours in two panels.
 */
export function lineageColour(hueDegrees: number): string {
  const hue = ((Math.round(hueDegrees) % 360) + 360) % 360;
  return `hsl(${hue} 62% 55%)`;
}
