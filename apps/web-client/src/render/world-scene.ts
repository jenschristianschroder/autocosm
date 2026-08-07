import { Scene } from '@babylonjs/core/scene';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import type { PickingInfo } from '@babylonjs/core/Collisions/pickingInfo';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import '@babylonjs/core/Rendering/prePassRendererSceneComponent';
import '@babylonjs/core/Culling/ray';
import type { SnapshotResponse, RegionDto, Selection, PickHit } from '../types';
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
import { pickKindOf } from './picking';

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
  /**
   * Called when the observer clicks something in the world. This is inspection only — the scene
   * reports what was clicked and never acts on it.
   */
  readonly onPick: (hit: PickHit | undefined) => void;
}

export interface WorldSceneHandle {
  readonly backend: RendererBackend;
  applySnapshot(snapshot: SnapshotResponse): void;
  /**
   * The full regional field from `/world`. Terrain drawn from a snapshot alone would be mostly
   * invented, so this is what the mesh is really built from once it arrives.
   */
  setWorldRegions(regions: readonly RegionDto[]): void;
  setSelection(selection: Selection): void;
  setFollowing(following: boolean): void;
  frameWorld(): void;
  resize(): void;
  dispose(): void;
}

/** Hover picking exists only to show that something is clickable; 10 Hz is plenty for a cursor. */
const HOVER_INTERVAL_MS = 100;

export async function createWorldScene(options: WorldSceneOptions): Promise<WorldSceneHandle> {
  const { engine, backend } = await createEngine(options.canvas);
  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;
  scene.autoClear = true;
  scene.blockMaterialDirtyMechanism = true;
  options.canvas.style.cursor = 'crosshair';

  const camera = createSpectatorCamera(scene, options.canvas);
  // Shadows are what make the terrain read as solid ground rather than a painted sheet, so both
  // backends get them; WebGL2 pays a smaller map instead of going without.
  const environment: EnvironmentHandle = createEnvironment(scene, backend);
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
  let terrainKey: string | undefined;
  let worldRegions: readonly RegionDto[] | undefined;
  let latest: SnapshotResponse | undefined;
  let receivedAt = 0;
  let selection: Selection = { kind: 'none' };
  let following = false;
  let elapsed = 0;
  let fpsAccumulator = 0;
  let fpsFrames = 0;

  const groundHeight = (x: number, z: number): number => terrain?.heightAt(x, z) ?? 0;

  /**
   * Resolve a pick to a world entity.
   *
   * One traversal over everything pickable, so occlusion is respected: an organism standing behind
   * a ridge cannot be clicked through it. The mesh tag says what kind of thing was drawn and the
   * thin-instance index says which one, because every entity type is instanced.
   */
  function resolve(pick: PickingInfo | null): PickHit | undefined {
    const mesh = pick?.pickedMesh;
    if (!pick?.hit || !mesh) return undefined;
    const kind = pickKindOf(mesh.metadata);
    const index = pick.thinInstanceIndex;

    if (kind === 'organism') {
      const id = organisms.organismAt(mesh.name, index);
      return id === undefined ? undefined : { kind: 'organism', id };
    }
    if (kind === 'structure') {
      const id = structures.structureAt(mesh.name, index);
      return id === undefined ? undefined : { kind: 'structure', id };
    }
    if (kind === 'resource') {
      const id = resources.resourceAt(mesh.name, index);
      return id === undefined ? undefined : { kind: 'resource', id };
    }
    if (kind === 'terrain' && pick.pickedPoint) {
      const region = terrain?.regionAt(pick.pickedPoint.x, pick.pickedPoint.z);
      return region ? { kind: 'region', id: region.id } : undefined;
    }
    return undefined;
  }

  const isEntity = (mesh: AbstractMesh): boolean => {
    const kind = pickKindOf(mesh.metadata);
    return kind !== undefined && kind !== 'terrain';
  };

  let lastHoverAt = 0;

  scene.onPointerObservable.add((info) => {
    // POINTERTAP rather than POINTERUP: Babylon suppresses it when the pointer was dragged, so
    // looking around with the mouse never selects whatever happened to be under the cursor.
    if (info.type === PointerEventTypes.POINTERTAP) {
      options.onPick(resolve(scene.pick(scene.pointerX, scene.pointerY)));
      return;
    }
    if (info.type !== PointerEventTypes.POINTERMOVE) return;

    // Hover only exists to show that the world is clickable, so it is throttled and skips the
    // terrain mesh — 32k triangles is far too much to ray-test at pointer rate for a cursor.
    const now = performance.now();
    if (now - lastHoverAt < HOVER_INTERVAL_MS) return;
    lastHoverAt = now;
    const hover = scene.pick(scene.pointerX, scene.pointerY, isEntity);
    options.canvas.style.cursor = hover?.hit ? 'pointer' : 'crosshair';
  });

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

  /**
   * Builds or rebuilds the terrain mesh. Keyed on the seed *and* the regional coverage, because
   * `/world` and `/snapshot` arrive independently: whichever lands first draws the ground, and the
   * arrival of the full field upgrades it exactly once.
   */
  function ensureTerrain(regions: readonly RegionDto[], seed: number): void {
    const key = `${seed}:${regions.length}`;
    if (terrainKey === key) return;
    terrain?.dispose();
    terrain = buildTerrain(scene, regions, seed);
    terrainKey = key;
    environment.addShadowCaster(terrain.mesh);
    // Water is graded against the ground beneath it, so it follows every terrain rebuild.
    const ground = terrain;
    environment.setDepthField((x, z) => ground.heightAt(x, z));
  }

  function setWorldRegions(regions: readonly RegionDto[]): void {
    worldRegions = regions;
    if (latest) ensureTerrain(regions, latest.seed);
  }

  function applySnapshot(snapshot: SnapshotResponse): void {
    // Prefer the full regional field. A snapshot carries only the observed neighbourhood — 9 of 64
    // regions — and the missing 86% would be filled with a flat constant, drawing most of the world
    // as featureless plate. Snapshot regions are the fallback for the window before `/world` lands
    // or if it fails outright.
    ensureTerrain(worldRegions ?? snapshot.regions, snapshot.seed);
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
    setWorldRegions,
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
