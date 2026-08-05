import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Selection, SnapshotResponse } from '../types';
import { createWorldScene, type WorldSceneHandle } from '../render/world-scene';

/**
 * The 3D viewport.
 *
 * React owns nothing inside the canvas: the scene is created once, fed snapshots, and disposed on
 * unmount. Doing it the other way round — re-rendering Babylon from React state — would rebuild
 * meshes on every poll.
 *
 * Callbacks and the poll interval are held in refs rather than effect dependencies. They change
 * whenever backoff adjusts or the parent re-renders, and rebuilding the whole scene for that would
 * flash the world and throw away every GPU buffer.
 */

export interface ViewportProps {
  readonly snapshot: SnapshotResponse | undefined;
  readonly selection: Selection;
  readonly following: boolean;
  readonly reducedMotion: boolean;
  readonly pollIntervalMs: number;
  readonly onBackend: (backend: string) => void;
  readonly onFps: (fps: number) => void;
}

export function Viewport(props: ViewportProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<WorldSceneHandle | undefined>(undefined);
  const [failure, setFailure] = useState<string>();
  const [ready, setReady] = useState(false);

  const { reducedMotion } = props;

  const intervalRef = useRef(props.pollIntervalMs);
  const backendRef = useRef(props.onBackend);
  const fpsRef = useRef(props.onFps);
  intervalRef.current = props.pollIntervalMs;
  backendRef.current = props.onBackend;
  fpsRef.current = props.onFps;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    void createWorldScene({
      canvas,
      reducedMotion,
      snapshotIntervalMs: () => intervalRef.current,
      onFps: (fps) => fpsRef.current(fps),
    })
      .then((handle) => {
        if (disposed) {
          handle.dispose();
          return;
        }
        sceneRef.current = handle;
        backendRef.current(handle.backend);
        setReady(true);
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof Error ? error.message : 'The renderer could not start on this device.',
        );
      });

    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = undefined;
      setReady(false);
    };
  }, [reducedMotion]);

  useEffect(() => {
    if (ready && props.snapshot) sceneRef.current?.applySnapshot(props.snapshot);
  }, [ready, props.snapshot]);

  useEffect(() => {
    sceneRef.current?.setSelection(props.selection);
  }, [props.selection]);

  useEffect(() => {
    sceneRef.current?.setFollowing(props.following);
  }, [props.following]);

  return (
    <div className="viewport">
      <canvas
        ref={canvasRef}
        className="viewport__canvas"
        aria-label="Three-dimensional view of the Autocosm world. Use W, A, S and D to move, Q and E to change altitude, and drag to look."
        tabIndex={0}
      />
      {failure !== undefined && (
        <div className="viewport__overlay" role="alert">
          <h2>The world could not be drawn</h2>
          <p>{failure}</p>
          <p className="muted">
            Autocosm needs WebGPU or WebGL2. The inspector, lineage tree and timeline still work.
          </p>
        </div>
      )}
      {failure === undefined && !ready && (
        <div className="viewport__overlay" role="status">
          <div className="spinner" aria-hidden="true" />
          <p>Starting the renderer…</p>
        </div>
      )}
    </div>
  );
}
