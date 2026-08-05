import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Cameras/Inputs/freeCameraKeyboardMoveInput';
import '@babylonjs/core/Cameras/Inputs/freeCameraMouseInput';
import { WORLD_SCENE_SPAN } from './coords';

/**
 * Spectator camera.
 *
 * The observer is incorporeal: this camera has no collision, no gravity, no ellipsoid, and no
 * presence in the simulation. It is never persisted, never sent to the server, and no organism can
 * perceive it. Follow mode eases the camera toward a moving target without ever moving the target.
 */

const MIN_HEIGHT_ABOVE_GROUND = 1.2;
const BOUND = WORLD_SCENE_SPAN * 0.85;

export interface SpectatorCameraHandle {
  readonly camera: UniversalCamera;
  /** Follow a scene position each frame; pass `undefined` to release. */
  setFollowTarget(position: Vector3 | undefined): void;
  /** Called every frame with the current follow position, if any. */
  update(deltaSeconds: number, groundHeightAt: (x: number, z: number) => number): void;
  frameWorld(): void;
  setSpeed(multiplier: number): void;
  dispose(): void;
}

export function createSpectatorCamera(
  scene: Scene,
  canvas: HTMLCanvasElement,
): SpectatorCameraHandle {
  const camera = new UniversalCamera(
    'spectator',
    new Vector3(0, WORLD_SCENE_SPAN * 0.28, -WORLD_SCENE_SPAN * 0.42),
    scene,
  );
  camera.setTarget(new Vector3(0, 0, 0));
  camera.minZ = 0.15;
  camera.maxZ = WORLD_SCENE_SPAN * 4;
  camera.fov = 0.9;
  camera.inertia = 0.82;
  camera.angularSensibility = 2600;
  camera.speed = 0.9;
  // No collisions, no gravity: the observer passes through everything, including terrain.
  camera.checkCollisions = false;
  camera.applyGravity = false;

  camera.keysUp = [87, 38];
  camera.keysDown = [83, 40];
  camera.keysLeft = [65, 37];
  camera.keysRight = [68, 39];
  camera.keysUpward = [69, 33];
  camera.keysDownward = [81, 34];

  camera.attachControl(canvas, true);

  let follow: Vector3 | undefined;
  let followBlend = 0;

  function update(deltaSeconds: number, groundHeightAt: (x: number, z: number) => number): void {
    if (follow) {
      // Ease in over ~0.6s so engaging follow is not a jump cut.
      followBlend = Math.min(1, followBlend + deltaSeconds / 0.6);
      const offset = camera.position.subtract(camera.getTarget());
      const distance = Math.min(14, Math.max(4, offset.length()));
      const desired = follow.add(offset.normalize().scale(distance));
      const ease = 1 - Math.pow(0.0015, deltaSeconds);
      camera.position = Vector3.Lerp(camera.position, desired, ease * followBlend);
      camera.setTarget(Vector3.Lerp(camera.getTarget(), follow, ease));
    } else {
      followBlend = 0;
    }

    // Soft bounds keep the observer near the biosphere without a wall: position is clamped, not
    // blocked, so no collision behaviour leaks into the camera.
    camera.position.x = clamp(camera.position.x, -BOUND, BOUND);
    camera.position.z = clamp(camera.position.z, -BOUND, BOUND);

    const floor = groundHeightAt(camera.position.x, camera.position.z) + MIN_HEIGHT_ABOVE_GROUND;
    if (camera.position.y < floor) camera.position.y = floor;
    if (camera.position.y > WORLD_SCENE_SPAN) camera.position.y = WORLD_SCENE_SPAN;
  }

  return {
    camera,
    setFollowTarget(position) {
      follow = position;
      if (!position) followBlend = 0;
    },
    update,
    frameWorld() {
      follow = undefined;
      camera.position = new Vector3(0, WORLD_SCENE_SPAN * 0.28, -WORLD_SCENE_SPAN * 0.42);
      camera.setTarget(new Vector3(0, 0, 0));
    },
    setSpeed(multiplier) {
      camera.speed = 0.9 * clamp(multiplier, 0.15, 8);
    },
    dispose() {
      camera.detachControl();
      camera.dispose();
    },
  };
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
