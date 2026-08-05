import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { BackgroundMaterial } from '@babylonjs/core/Materials/Background/backgroundMaterial';
import { PBRMetallicRoughnessMaterial } from '@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';
import { WORLD_SCENE_SPAN } from './coords';

/**
 * Sky, sun, water and atmosphere.
 *
 * The day/night cycle is driven entirely by the authoritative `dayPhasePerMille` and
 * `lightPerMille` from the snapshot, so the sky the observer sees is the same daylight the
 * simulation used when it fed photosynthesis this tick. Nothing here runs its own clock.
 */

export interface EnvironmentHandle {
  readonly shadows: ShadowGenerator | undefined;
  readonly water: Mesh;
  /** Apply the newest authoritative light state. */
  setDaylight(dayPhasePerMille: number, lightPerMille: number, pressureKind: string): void;
  /** Advance decorative animation only (water ripple). */
  animate(elapsedSeconds: number): void;
  addShadowCaster(mesh: Mesh): void;
  dispose(): void;
}

export function createEnvironment(scene: Scene, enableShadows: boolean): EnvironmentHandle {
  scene.clearColor = new Color4(0.03, 0.05, 0.09, 1);
  scene.ambientColor = new Color3(0.25, 0.28, 0.34);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0042;
  scene.fogColor = new Color3(0.42, 0.5, 0.6);

  const skyRadius = WORLD_SCENE_SPAN * 3;
  const sky = CreateSphere('sky', { diameter: skyRadius, segments: 16, sideOrientation: 1 }, scene);
  sky.infiniteDistance = true;
  sky.isPickable = false;
  sky.applyFog = false;

  const skyTexture = new DynamicTexture('skyGradient', { width: 4, height: 128 }, scene, false);
  skyTexture.wrapU = 0;
  skyTexture.wrapV = 0;
  const skyMaterial = new BackgroundMaterial('skyMaterial', scene);
  skyMaterial.backFaceCulling = false;
  skyMaterial.useRGBColor = false;
  skyMaterial.diffuseTexture = skyTexture;
  sky.material = skyMaterial;

  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.3), scene);
  sun.intensity = 2.2;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 240;

  const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.45;
  ambient.groundColor = new Color3(0.16, 0.18, 0.2);

  // Shadows are optional: on a weak GPU the map costs more than it adds. The caller decides.
  const shadows = enableShadows ? new ShadowGenerator(1024, sun) : undefined;
  if (shadows) {
    shadows.useExponentialShadowMap = true;
    shadows.darkness = 0.45;
    shadows.bias = 0.0015;
  }

  const water = CreateGround(
    'water',
    { width: WORLD_SCENE_SPAN * 1.6, height: WORLD_SCENE_SPAN * 1.6, subdivisions: 48 },
    scene,
  );
  water.position.y = 0;
  water.isPickable = false;
  const waterMaterial = new PBRMetallicRoughnessMaterial('waterMaterial', scene);
  waterMaterial.baseColor = new Color3(0.06, 0.22, 0.34);
  waterMaterial.metallic = 0.12;
  waterMaterial.roughness = 0.12;
  waterMaterial.alpha = 0.78;
  waterMaterial.transparencyMode = 2;
  waterMaterial.backFaceCulling = false;
  water.material = waterMaterial;

  const basePositions = water.getVerticesData('position');
  const wavePositions = basePositions ? Float32Array.from(basePositions) : undefined;

  function setDaylight(
    dayPhasePerMille: number,
    lightPerMille: number,
    pressureKind: string,
  ): void {
    const phase = (dayPhasePerMille / 1000) * Math.PI * 2;
    const light = lightPerMille / 1000;

    // Sun arcs across the sky; below the horizon it becomes a dim moon rather than vanishing, so
    // night is navigable without being bright.
    const elevation = Math.sin(phase - Math.PI / 2);
    const direction = new Vector3(Math.cos(phase) * 0.7, -Math.max(0.12, elevation), 0.35);
    sun.direction = direction.normalize();
    sun.intensity = 0.35 + light * 2.3;

    const warm = new Color3(1, 0.86, 0.68);
    const cool = new Color3(0.62, 0.72, 1);
    sun.diffuse = Color3.Lerp(cool, warm, Math.min(1, Math.max(0, light)));
    ambient.intensity = 0.16 + light * 0.5;

    const storm = pressureKind === 'storm';
    const drought = pressureKind === 'drought';
    const zenith = new Color3(
      0.02 + light * (storm ? 0.18 : 0.28),
      0.05 + light * (storm ? 0.2 : 0.44),
      0.12 + light * (storm ? 0.28 : 0.72),
    );
    const horizon = new Color3(
      0.05 + light * (drought ? 0.9 : 0.72),
      0.07 + light * (drought ? 0.66 : 0.6),
      0.14 + light * (storm ? 0.5 : 0.55),
    );
    paintSkyGradient(skyTexture, zenith, horizon);

    scene.fogColor = Color3.Lerp(zenith, horizon, 0.65);
    scene.fogDensity = storm ? 0.0085 : 0.0032 + (1 - light) * 0.0022;
    scene.clearColor = new Color4(zenith.r, zenith.g, zenith.b, 1);
    waterMaterial.baseColor = new Color3(
      0.03 + light * 0.08,
      0.12 + light * 0.16,
      0.2 + light * 0.22,
    );
  }

  function animate(elapsedSeconds: number): void {
    if (!wavePositions || !basePositions) return;
    // A cheap two-wave displacement. Purely cosmetic — water level itself never moves.
    for (let i = 0; i < wavePositions.length; i += 3) {
      const x = basePositions[i] ?? 0;
      const z = basePositions[i + 2] ?? 0;
      wavePositions[i + 1] =
        Math.sin(x * 0.16 + elapsedSeconds * 0.9) * 0.16 +
        Math.cos(z * 0.11 - elapsedSeconds * 0.65) * 0.11;
    }
    water.updateVerticesData('position', wavePositions, false, false);
  }

  return {
    shadows,
    water,
    setDaylight,
    animate,
    addShadowCaster(mesh) {
      shadows?.addShadowCaster(mesh, true);
    },
    dispose() {
      shadows?.dispose();
      skyTexture.dispose();
      skyMaterial.dispose();
      sky.dispose(false, false);
      waterMaterial.dispose();
      water.dispose(false, false);
      sun.dispose();
      ambient.dispose();
    },
  };
}

function paintSkyGradient(texture: DynamicTexture, zenith: Color3, horizon: Color3): void {
  const context = texture.getContext() as CanvasRenderingContext2D;
  const size = texture.getSize();
  const gradient = context.createLinearGradient(0, 0, 0, size.height);
  gradient.addColorStop(0, toCss(zenith));
  gradient.addColorStop(0.55, toCss(Color3.Lerp(zenith, horizon, 0.5)));
  gradient.addColorStop(1, toCss(horizon));
  context.fillStyle = gradient;
  context.fillRect(0, 0, size.width, size.height);
  texture.update(false);
}

function toCss(colour: Color3): string {
  const to255 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${to255(colour.r)},${to255(colour.g)},${to255(colour.b)})`;
}
