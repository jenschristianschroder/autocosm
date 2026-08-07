import { describe, expect, it } from 'vitest';

import { lineageTint, structureTint } from './props';
import type { StructureDto } from '../types';

/**
 * `createdByLineageHue` was served by the API and never consumed by the renderer, so "who built
 * this" was only answerable by clicking. These pin the conversion that closes that gap.
 *
 * The properties that matter are that distinct lineages get distinguishable colours and that no
 * hue produces something out of gamut — a structure tinted outside [0,1] renders as a clipped
 * flat patch, which reads as a rendering fault rather than as a lineage.
 */
describe('lineageTint', () => {
  it('stays in gamut for every hue on the circle', () => {
    for (let hue = 0; hue <= 360; hue += 1) {
      for (const channel of lineageTint(hue)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('separates hues that are far apart on the circle', () => {
    // Six lineages evenly spread must not collapse onto each other, or the tint carries no signal.
    const spread = [0, 60, 120, 180, 240, 300].map((h) => lineageTint(h));
    for (let i = 0; i < spread.length; i += 1) {
      for (let j = i + 1; j < spread.length; j += 1) {
        const a = spread[i]!;
        const b = spread[j]!;
        const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        expect(distance).toBeGreaterThan(0.15);
      }
    }
  });

  it('wraps the circle so 0 and 360 are the same lineage colour', () => {
    expect(lineageTint(360)).toEqual(lineageTint(0));
    expect(lineageTint(-60)).toEqual(lineageTint(300));
  });

  it('holds saturation below full so a structure still reads as built, not painted', () => {
    // Every hue keeps a floor of grey. A fully saturated wheel reads as decoration, not data.
    for (let hue = 0; hue < 360; hue += 15) {
      const [r, g, b] = lineageTint(hue);
      expect(Math.min(r, g, b)).toBeGreaterThan(0.35);
      expect(Math.max(r, g, b)).toBeGreaterThan(0.9);
    }
  });

  it('is a pure function of the hue', () => {
    expect(lineageTint(137)).toEqual(lineageTint(137));
  });
});

/**
 * The tests above prove the colour conversion; these prove what the renderer actually draws.
 *
 * `createdByLineageHue` shipped in the API and sat unconsumed, which no test could have caught
 * because the code that reads it did not exist. These pin the three signals the tint must carry
 * simultaneously, so a future change cannot quietly drop one and still look plausible.
 */
describe('structureTint', () => {
  function structure(hue: number | undefined, integrity = 1000): StructureDto {
    return {
      id: 'st-1',
      regionId: 'rg-0',
      x: 0,
      z: 0,
      elevation: 0,
      pattern: 'lattice',
      label: 'st-1',
      integrity,
      volume: 100,
      functions: [],
      createdByAgentId: 'ag-1',
      createdByLineageId: 'ln-1',
      createdAtTick: 0,
      ...(hue === undefined ? {} : { createdByLineageHue: hue }),
    } as StructureDto;
  }

  function distance(a: readonly number[], b: readonly number[]): number {
    return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  }

  it('gives two lineages visibly different colours on the same pattern', () => {
    expect(distance(structureTint(structure(0)), structureTint(structure(180)))).toBeGreaterThan(
      0.2,
    );
  });

  it('separates six lineages building the same pattern', () => {
    const tints = [0, 60, 120, 180, 240, 300].map((h) => structureTint(structure(h)));
    for (let i = 0; i < tints.length; i += 1) {
      for (let j = i + 1; j < tints.length; j += 1) {
        expect(distance(tints[i]!, tints[j]!)).toBeGreaterThan(0.08);
      }
    }
  });

  it('falls back to the pattern colour when the builder lineage is unknown', () => {
    // A reaped lineage omits the field; the structure must still render in a sane colour rather
    // than black, which reads as a rendering fault instead of as an unknown builder.
    const [r, g, b] = structureTint(structure(undefined));
    expect(Math.max(r, g, b)).toBeGreaterThan(0.2);
  });

  it('still darkens a ruin, so condition survives the tint', () => {
    const sound = structureTint(structure(200, 1000));
    const ruin = structureTint(structure(200, 0));
    const sum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!;
    expect(sum(ruin)).toBeLessThan(sum(sound) * 0.75);
  });

  it('keeps a minority pattern term so one lineage building twice is not uniform', () => {
    const lattice = structureTint(structure(200));
    const snare = structureTint({ ...structure(200), pattern: 'snare' } as StructureDto);
    expect(distance(lattice, snare)).toBeGreaterThan(0.02);
  });

  it('stays in gamut for every hue and condition', () => {
    for (let hue = 0; hue < 360; hue += 15) {
      for (const integrity of [0, 500, 1000]) {
        for (const channel of structureTint(structure(hue, integrity))) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
