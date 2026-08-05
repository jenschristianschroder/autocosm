import { Engine } from '@babylonjs/core/Engines/engine';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';

// `Engines/webgpuEngine` side-effect-imports only eight of its fourteen WebGPU extensions;
// `dynamicTexture` is not one of them. The WebGL equivalent is registered automatically because
// `Materials/Textures/dynamicTexture` patches `ThinEngine.prototype` itself, but `WebGPUEngine`
// extends `ThinWebGPUEngine`, not `ThinEngine`, so it inherits nothing from that. Without this
// import the sky texture throws "engine.createDynamicTexture is not a function" on every
// WebGPU-capable browser while WebGL2 fallbacks (including headless CI) work fine.
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture';

/**
 * Engine selection.
 *
 * WebGPU when the browser really supports it, WebGL2 otherwise. The probe is a genuine
 * support check plus a real initialisation attempt, because a browser can advertise
 * `navigator.gpu` and still fail to create a device (headless CI, blocklisted drivers). A
 * half-initialised WebGPU engine is worse than no WebGPU at all, so any failure falls back.
 */

export type RendererBackend = 'webgpu' | 'webgl2';

export interface CreatedEngine {
  readonly engine: AbstractEngine;
  readonly backend: RendererBackend;
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<CreatedEngine> {
  if (await webGpuLooksUsable()) {
    try {
      const engine = new WebGPUEngine(canvas, { antialias: true, stencil: true });
      await engine.initAsync();
      return { engine, backend: 'webgpu' };
    } catch {
      // Fall through to WebGL2 rather than leaving the observer with a black canvas.
    }
  }

  const engine = new Engine(canvas, true, {
    antialias: true,
    stencil: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  });
  return { engine, backend: 'webgl2' };
}

async function webGpuLooksUsable(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
  try {
    return await WebGPUEngine.IsSupportedAsync;
  } catch {
    return false;
  }
}
