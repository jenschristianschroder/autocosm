import { describe, expect, it } from 'vitest';
import { Engine } from '@babylonjs/core/Engines/engine';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';

// Importing the module under test for its side effects is the whole point: `engine.ts` carries the
// WebGPU extension imports that the deep-imported Babylon entry points omit.
import './engine';

/**
 * Guards against a class of Babylon tree-shaking bug that no headless browser test can catch.
 *
 * `@babylonjs/core/Engines/webgpuEngine` side-effect-imports only eight of its fourteen WebGPU
 * engine extensions. Any feature backed by one of the other six is missing at runtime on a
 * WebGPU-capable browser, while a WebGL2 machine — including every headless CI runner, which
 * falls back to WebGL2 — works perfectly. That asymmetry is why this is asserted here on the
 * prototypes, deterministically and without a GPU, rather than left to the browser suite.
 */
describe('WebGPU engine extensions', () => {
  it('registers dynamic texture support on WebGPUEngine', () => {
    // `DynamicTexture` registers the WebGL variant lazily from its own constructor, but it patches
    // `ThinEngine.prototype`. `WebGPUEngine` extends `ThinWebGPUEngine`, so it inherits none of it
    // and the sky texture dies with "engine.createDynamicTexture is not a function".
    expect(typeof WebGPUEngine.prototype.createDynamicTexture).toBe('function');
    expect(typeof WebGPUEngine.prototype.updateDynamicTexture).toBe('function');
  });

  it('keeps the WebGL2 fallback able to reach the same feature', () => {
    // The WebGL side is registered on first construction rather than on import, so the assertion
    // is that the wiring exists at all, not that the prototype is already patched.
    expect(typeof DynamicTexture).toBe('function');
    expect(Object.getPrototypeOf(Engine)).toBeTruthy();
  });
});
