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
 *
 * Travel and zoom scale with height above the terrain. The world is only 96 scene units across but
 * spans four orders of magnitude of interest — a whole biosphere down to one organism — so a fixed
 * step is either unusably coarse near the ground or unusably slow from orbit. Both the keyboard
 * speed and one wheel notch are therefore a fraction of the current altitude.
 */

const MIN_HEIGHT_ABOVE_GROUND = 0.6;
const BOUND = WORLD_SCENE_SPAN * 0.85;
const BASE_SPEED = 0.9;

/** Fraction of the height above ground covered by a single wheel notch. */
const DOLLY_PER_NOTCH = 0.3;
const DOLLY_MIN_STEP = 0.3;
const DOLLY_MAX_STEP = WORLD_SCENE_SPAN * 0.2;

/** Follow distance is multiplied per notch, so zoom feels the same at every distance. */
const FOLLOW_ZOOM_FACTOR = 1.18;
const FOLLOW_MIN_DISTANCE = 1.2;
const FOLLOW_MAX_DISTANCE = 42;
const FOLLOW_DEFAULT_DISTANCE = 9;

/** Pixels of pinch separation that count as one wheel notch. */
const PINCH_PIXELS_PER_NOTCH = 60;

const FORWARD = new Vector3(0, 0, 1);

export interface SpectatorCameraHandle {
  readonly camera: UniversalCamera;
  /** Follow a scene position each frame; pass `undefined` to release. */
  setFollowTarget(position: Vector3 | undefined): void;
  /** Called every frame with the current follow position, if any. */
  update(deltaSeconds: number, groundHeightAt: (x: number, z: number) => number): void;
  frameWorld(): void;
  /** Multiplier applied on top of altitude-scaled travel speed. */
  setSpeed(multiplier: number): void;
  /** Move along the view axis. Positive zooms out, matching wheel-down. */
  dolly(notches: number): void;
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
  // Babylon's angular sensibility is inverted: larger means slower. The previous 2600 made looking
  // around roughly two and a half times heavier than the engine default.
  camera.angularSensibility = 1100;
  camera.speed = BASE_SPEED;
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
  let followDistance = FOLLOW_DEFAULT_DISTANCE;
  let speedMultiplier = 1;
  let boost = 1;
  let groundY = 0;
  let attached = true;

  function altitude(): number {
    return Math.max(0.6, camera.position.y - groundY);
  }

  function dolly(notches: number): void {
    if (notches === 0 || !Number.isFinite(notches)) return;
    if (follow) {
      followDistance = clamp(
        followDistance * Math.pow(FOLLOW_ZOOM_FACTOR, notches),
        FOLLOW_MIN_DISTANCE,
        FOLLOW_MAX_DISTANCE,
      );
      return;
    }
    const step = clamp(altitude() * DOLLY_PER_NOTCH, DOLLY_MIN_STEP, DOLLY_MAX_STEP) * -notches;
    camera.position.addInPlace(camera.getDirection(FORWARD).scale(step));
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    dolly(wheelNotches(event));
  }

  // Two-finger pinch. Camera control is detached for the duration so the rotate input does not
  // also spin the view while the observer is only trying to zoom.
  const touches = new Map<number, { x: number; y: number }>();
  let pinchDistance: number | undefined;

  function setAttached(next: boolean): void {
    if (next === attached) return;
    attached = next;
    if (next) camera.attachControl(canvas, true);
    else camera.detachControl();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) {
      setAttached(false);
      pinchDistance = separation(touches);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || !touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size !== 2) return;
    const next = separation(touches);
    if (pinchDistance !== undefined && next !== undefined) {
      dolly(-(next - pinchDistance) / PINCH_PIXELS_PER_NOTCH);
    }
    pinchDistance = next;
  }

  function onPointerUp(event: PointerEvent): void {
    if (!touches.delete(event.pointerId)) return;
    if (touches.size < 2) {
      pinchDistance = undefined;
      setAttached(true);
    }
  }

  // Shift is a travel boost rather than a separate mode, so it composes with altitude scaling.
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Shift') boost = 3;
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Shift') boost = 1;
  }

  function onBlur(): void {
    boost = 1;
  }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  function update(deltaSeconds: number, groundHeightAt: (x: number, z: number) => number): void {
    if (follow) {
      // Ease in over ~0.6s so engaging follow is not a jump cut.
      followBlend = Math.min(1, followBlend + deltaSeconds / 0.6);
      const offset = camera.position.subtract(camera.getTarget());
      const desired = follow.add(offset.normalize().scale(followDistance));
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

    groundY = groundHeightAt(camera.position.x, camera.position.z);
    const floor = groundY + MIN_HEIGHT_ABOVE_GROUND;
    if (camera.position.y < floor) camera.position.y = floor;
    if (camera.position.y > WORLD_SCENE_SPAN) camera.position.y = WORLD_SCENE_SPAN;

    camera.speed = BASE_SPEED * altitudeSpeedScale(altitude()) * speedMultiplier * boost;
  }

  return {
    camera,
    setFollowTarget(position) {
      if (position && !follow) {
        // Adopt whatever distance the observer had already chosen, so engaging follow does not
        // yank the view to a fixed range.
        const offset = camera.position.subtract(camera.getTarget()).length();
        followDistance = clamp(
          Number.isFinite(offset) && offset > 0 ? offset : FOLLOW_DEFAULT_DISTANCE,
          FOLLOW_MIN_DISTANCE,
          FOLLOW_MAX_DISTANCE,
        );
      }
      follow = position;
      if (!position) followBlend = 0;
    },
    update,
    frameWorld() {
      follow = undefined;
      followDistance = FOLLOW_DEFAULT_DISTANCE;
      camera.position = new Vector3(0, WORLD_SCENE_SPAN * 0.28, -WORLD_SCENE_SPAN * 0.42);
      camera.setTarget(new Vector3(0, 0, 0));
    },
    setSpeed(multiplier) {
      speedMultiplier = clamp(multiplier, 0.15, 8);
    },
    dolly,
    dispose() {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (attached) camera.detachControl();
      camera.dispose();
    },
  };
}

/**
 * Travel scale for a height above the terrain.
 *
 * Exported for test: the property that matters is monotonicity plus a floor low enough to move
 * between neighbouring organisms and a ceiling high enough to cross the world from orbit.
 */
export function altitudeSpeedScale(height: number): number {
  return clamp(0.22 + Math.max(0, height) / 14, 0.22, 6);
}

/**
 * Normalise a wheel event to notches, where one detented mouse click is roughly 1.
 *
 * Browsers report three different units and trackpads emit a stream of small pixel deltas, so the
 * raw `deltaY` is not comparable across devices.
 */
export function wheelNotches(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const pixels = event.deltaY * unit;
  if (!Number.isFinite(pixels)) return 0;
  return clamp(pixels / 120, -4, 4);
}

function separation(points: ReadonlyMap<number, { x: number; y: number }>): number | undefined {
  const [a, b] = [...points.values()];
  if (!a || !b) return undefined;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
