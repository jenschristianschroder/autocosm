import { Scene } from '@babylonjs/core/scene';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import '@babylonjs/core/Rendering/prePassRendererSceneComponent';
import '@babylonjs/core/Culling/ray';
import type { SnapshotResponse, Selection } from '../types';
import { createEngine, type RendererBackend } from './engine';
import { createEnvironment, type EnvironmentHandle } from './environment';
import { buildTerrain, type TerrainHandle } from './terrain';
import { createOrganismRenderer, type OrganismRendererHandle } from './organisms';
import {
  createResourceRenderer,
  createStructureRenderer,
  type ResourceRendererHandle,
  type StructureRendererHandle,
} from './props';
import { createSpectatorCamera } from './camera';

/**
 * The observatory scene.
 *
 * Owns the Babylon lifetime and is the only place that mutates rendering state. React tells it
 * about new authoritative snapshots and about what the observer has selected; it never tells React
 * what happened in the world. The render loop interpolates between the last two snapshots and
 * stops at the newest one — it never extrapolates, because a guessed position that the simulation
 * then contradicts would be the renderer inventing an outcome.
 */

export interface WorldSceneOptions {
  readonly canvas: HTMLCanvasElement;
  readonly reducedMotion: boolean;
  /**
   * Expected wall-clock milliseconds between snapshots, read fresh each frame. It is a function
   * because polling backs off when the world is unreachable, and interpolation should stretch to
   * match rather than finish early and then sit still.
   */
  readonly snapshotIntervalMs: () => number;
  readonly onFps: (fps: number) => void;
}

export interface WorldSceneHandle {
  readonly backend: RendererBackend;
  applySnapshot(snapshot: SnapshotResponse): void;
  setSelection(selection: Selection): void;
  setFollowing(following: boolean): void;
  frameWorld(): void;
  resize(): void;
  dispose(): void;
}

export async function createWorldScene(options: WorldSceneOptions): Promise<WorldSceneHandle> {
  const { engine, backend } = await createEngine(options.canvas);
  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;
  scene.autoClear = true;
  scene.blockMaterialDirtyMechanism = true;

  const camera = createSpectatorCamera(scene, options.canvas);
  // WebGL2 on integrated GPUs is where shadow maps hurt most; keep them for WebGPU only.
  const environment: EnvironmentHandle = createEnvironment(scene, backend === 'webgpu');
  const organisms: OrganismRendererHandle = createOrganismRenderer(scene);
  const structures: StructureRendererHandle = createStructureRenderer(scene);
  const resources: ResourceRendererHandle = createResourceRenderer(scene);

  const pipeline = new DefaultRenderingPipeline('autocosm', true, scene, [camera.camera]);
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.86;
  pipeline.bloomWeight = 0.22;
  pipeline.bloomKernel = 32;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.contrast = 1.12;
  pipeline.imageProcessing.exposure = 1.05;

  let terrain: TerrainHandle | undefined;
  let terrainSeed: number | undefined;
  let latest: SnapshotResponse | undefined;
  let receivedAt = 0;
  let selection: Selection = { kind: 'none' };
  let following = false;
  let elapsed = 0;
  let fpsAccumulator = 0;
  let fpsFrames = 0;

  const groundHeight = (x: number, z: number): number => terrain?.heightAt(x, z) ?? 0;

  engine.runRenderLoop(() => {
    const deltaSeconds = Math.min(0.25, engine.getDeltaTime() / 1000);
    // Reduced motion still renders, it just stops decorative animation and snaps interpolation.
    if (!options.reducedMotion) elapsed += deltaSeconds;

    const alpha = options.reducedMotion
      ? 1
      : Math.min(1, (performance.now() - receivedAt) / Math.max(1, options.snapshotIntervalMs()));

    if (!options.reducedMotion) environment.animate(elapsed);
    organisms.render(alpha, elapsed, camera.camera.position);

    if (following) camera.setFollowTarget(followTarget(alpha));
    else camera.setFollowTarget(undefined);
    camera.update(deltaSeconds, groundHeight);

    scene.render();

    fpsAccumulator += engine.getFps();
    fpsFrames += 1;
    if (fpsFrames >= 30) {
      options.onFps(Math.round(fpsAccumulator / fpsFrames));
      fpsAccumulator = 0;
      fpsFrames = 0;
    }
  });

  function followTarget(alpha: number): Vector3 | undefined {
    if (selection.kind === 'organism') return organisms.positionOf(selection.id, alpha);
    if (selection.kind === 'structure') return structures.positionOf(selection.id);
    if (selection.kind === 'agent') {
      const agentId = selection.id;
      const member = latest?.organisms.find((o) => o.agentId === agentId);
      return member ? organisms.positionOf(member.id, alpha) : undefined;
    }
    return undefined;
  }

  function applySnapshot(snapshot: SnapshotResponse): void {
    // Terrain is a function of the world seed and the regional field; both are stable for a world,
    // so it is built once and never rebuilt on every poll.
    if (terrainSeed !== snapshot.seed) {
      terrain?.dispose();
      terrain = buildTerrain(scene, snapshot.regions, snapshot.seed);
      terrainSeed = snapshot.seed;
      environment.addShadowCaster(terrain.mesh);
    }

    environment.setDaylight(
      snapshot.dayPhasePerMille,
      snapshot.lightPerMille,
      snapshot.pressure.kind,
    );
    organisms.update(snapshot.organisms);
    structures.update(snapshot.structures);
    resources.update(snapshot.resources);

    latest = snapshot;
    receivedAt = performance.now();
  }

  const handleResize = (): void => engine.resize();
  window.addEventListener('resize', handleResize);

  return {
    backend,
    applySnapshot,
    setSelection(next) {
      selection = next;
      if (next.kind === 'none') following = false;
    },
    setFollowing(next) {
      following = next;
      if (!next) camera.setFollowTarget(undefined);
    },
    frameWorld() {
      following = false;
      camera.frameWorld();
    },
    resize: handleResize,
    dispose() {
      window.removeEventListener('resize', handleResize);
      engine.stopRenderLoop();
      pipeline.dispose();
      organisms.dispose();
      structures.dispose();
      resources.dispose();
      terrain?.dispose();
      environment.dispose();
      camera.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

export type { AbstractEngine };
