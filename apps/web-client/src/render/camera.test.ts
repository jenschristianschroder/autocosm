import { describe, expect, it } from 'vitest';
import { altitudeSpeedScale, wheelNotches } from './camera';

/**
 * The camera itself needs a canvas and a GPU, so these cover the two pure functions that decide how
 * it feels. Both were previously absent rather than mistuned: there was no wheel handling at all,
 * and travel speed was a constant on a world that spans a whole biosphere down to one organism.
 */

describe('wheel normalisation', () => {
  it('treats one detented mouse click as roughly one notch regardless of unit', () => {
    // Chrome reports pixels, Firefox reports lines, and a page-mode wheel reports pages. Without
    // normalisation the same physical gesture would zoom by wildly different amounts per browser.
    expect(wheelNotches({ deltaY: 120, deltaMode: 0 })).toBeCloseTo(1, 5);
    expect(wheelNotches({ deltaY: 7.5, deltaMode: 1 })).toBeCloseTo(1, 5);
    expect(wheelNotches({ deltaY: 0.3, deltaMode: 2 })).toBeCloseTo(1, 5);
  });

  it('keeps a trackpad flick smooth and a runaway delta bounded', () => {
    // Trackpads emit a stream of small deltas; each must be a fraction of a notch or zoom becomes
    // a series of jumps.
    const flick = wheelNotches({ deltaY: 8, deltaMode: 0 });
    expect(flick).toBeGreaterThan(0);
    expect(flick).toBeLessThan(0.1);

    expect(wheelNotches({ deltaY: 100_000, deltaMode: 0 })).toBe(4);
    expect(wheelNotches({ deltaY: -100_000, deltaMode: 0 })).toBe(-4);
    expect(wheelNotches({ deltaY: Number.NaN, deltaMode: 0 })).toBe(0);
  });

  it('signs scroll-down as zooming out', () => {
    // Positive `deltaY` is scrolling away from the viewer, which every other application treats as
    // zooming out. The camera negates this when it dollies.
    expect(wheelNotches({ deltaY: 120, deltaMode: 0 })).toBeGreaterThan(0);
    expect(wheelNotches({ deltaY: -120, deltaMode: 0 })).toBeLessThan(0);
  });
});

describe('altitude-scaled travel', () => {
  it('rises with height and stays inside its bounds', () => {
    let previous = -1;
    for (let height = 0; height <= 200; height += 1) {
      const scale = altitudeSpeedScale(height);
      expect(scale).toBeGreaterThanOrEqual(previous);
      expect(scale).toBeGreaterThanOrEqual(0.22);
      expect(scale).toBeLessThanOrEqual(6);
      previous = scale;
    }
  });

  it('is slow enough at ground level to move between neighbours, fast enough from orbit to cross', () => {
    // The world is 96 scene units across. At the camera floor a key press must not throw the
    // observer across a region; from the default overview it must cross the world in seconds.
    const ground = altitudeSpeedScale(0.6);
    const overview = altitudeSpeedScale(96 * 0.28);
    expect(ground).toBeLessThan(0.35);
    expect(overview / ground).toBeGreaterThan(5);
  });

  it('never returns a negative scale for a camera below the terrain', () => {
    expect(altitudeSpeedScale(-100)).toBe(0.22);
  });
});
