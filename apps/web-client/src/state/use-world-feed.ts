import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchIdentity, fetchSnapshot, fetchWorldMeta, type Cached } from '../api';
import type { CreatorIdentityResponse, SnapshotResponse, WorldMetaResponse } from '../types';

/**
 * Snapshot polling.
 *
 * Polling with an ETag is deliberate. The alternative — a persistent socket — would keep a replica
 * warm around the clock for a world that only changes once a minute, which is exactly the fixed
 * cost this deployment is built to avoid. Between ticks the browser gets a 304 and no body.
 *
 * Backoff exists because the web app scales to zero: the first request after an idle period pays a
 * cold start, and a failing world must not be hammered while it recovers.
 */

/** Ticks advance once a minute; polling twice that rate keeps latency low without waste. */
const BASE_INTERVAL_MS = 20_000;
const MAX_INTERVAL_MS = 120_000;
/** After this long without a fresh tick the view is labelled stale rather than silently old. */
export const STALE_AFTER_MS = 180_000;

export type ConnectionState = 'initialising' | 'coldStart' | 'live' | 'stale' | 'offline' | 'error';

export interface WorldFeed {
  readonly meta: WorldMetaResponse | undefined;
  readonly snapshot: SnapshotResponse | undefined;
  readonly identity: CreatorIdentityResponse | undefined;
  readonly connection: ConnectionState;
  readonly errorMessage: string | undefined;
  readonly lastChangeAt: number | undefined;
  readonly pollIntervalMs: number;
  /** Recentre the snapshot window on a region; `undefined` means the world centre. */
  setRegion(regionId: string | undefined): void;
  readonly regionId: string | undefined;
  refresh(): void;
  refreshIdentity(): void;
}

export function useWorldFeed(): WorldFeed {
  const [meta, setMeta] = useState<WorldMetaResponse>();
  const [snapshot, setSnapshot] = useState<SnapshotResponse>();
  const [identity, setIdentity] = useState<CreatorIdentityResponse>();
  const [connection, setConnection] = useState<ConnectionState>('initialising');
  const [errorMessage, setErrorMessage] = useState<string>();
  const [lastChangeAt, setLastChangeAt] = useState<number>();
  const [regionId, setRegionIdState] = useState<string>();
  const [intervalMs, setIntervalMs] = useState(BASE_INTERVAL_MS);
  const [nonce, setNonce] = useState(0);

  const etagRef = useRef<string | undefined>(undefined);
  const snapshotRef = useRef<SnapshotResponse | undefined>(undefined);
  const failuresRef = useRef(0);
  const startedRef = useRef(false);

  const setRegion = useCallback((next: string | undefined) => {
    // A different window is a different resource: the old ETag would produce a bogus 304.
    etagRef.current = undefined;
    setRegionIdState(next);
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const refreshIdentity = useCallback(() => {
    void fetchIdentity()
      .then(setIdentity)
      .catch(() => {
        // Identity is best-effort: without it the authoring UI is disabled, but the world still
        // renders, and an observer with no identity has lost nothing they could have done.
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll(): Promise<void> {
      if (cancelled) return;

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setConnection('offline');
        schedule(BASE_INTERVAL_MS);
        return;
      }

      if (!startedRef.current) setConnection('coldStart');

      try {
        const [nextMeta, cached] = await Promise.all([
          fetchWorldMeta(),
          fetchSnapshot({
            ...(regionId === undefined ? {} : { regionId }),
            radius: 1,
            ...(etagRef.current === undefined ? {} : { etag: etagRef.current }),
            ...(snapshotRef.current === undefined ? {} : { previous: snapshotRef.current }),
          }) as Promise<Cached<SnapshotResponse>>,
        ]);
        if (cancelled) return;

        failuresRef.current = 0;
        startedRef.current = true;
        etagRef.current = cached.etag;
        setMeta(nextMeta);
        setErrorMessage(undefined);

        if (!cached.unchanged) {
          snapshotRef.current = cached.value;
          setSnapshot(cached.value);
          setLastChangeAt(Date.now());
          setConnection('live');
        } else {
          setConnection((current) => (current === 'coldStart' ? 'live' : current));
        }

        setIntervalMs(BASE_INTERVAL_MS);
        schedule(BASE_INTERVAL_MS);
      } catch (error) {
        if (cancelled) return;
        failuresRef.current += 1;
        const message =
          error instanceof ApiError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : 'unknown error';
        setErrorMessage(message);
        setConnection(snapshotRef.current === undefined ? 'error' : 'stale');

        // Exponential backoff with a hard ceiling: a world that is down stays pollable, but a
        // scaled-to-zero deployment is not kept awake by a browser left open on a dead tab.
        const delay = Math.min(
          MAX_INTERVAL_MS,
          BASE_INTERVAL_MS * Math.pow(2, Math.min(4, failuresRef.current)),
        );
        setIntervalMs(delay);
        schedule(delay);
      }
    }

    function schedule(delay: number): void {
      if (cancelled) return;
      timer = window.setTimeout(() => void poll(), delay);
    }

    void poll();
    refreshIdentity();

    const onOnline = (): void => void poll();
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void poll();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [regionId, nonce, refreshIdentity]);

  // Staleness is a wall-clock property, so it needs its own timer rather than being derived at
  // render time — otherwise a quiet tab would never notice that it had gone stale.
  useEffect(() => {
    const handle = window.setInterval(() => {
      setConnection((current) => {
        if (current !== 'live' || lastChangeAt === undefined) return current;
        return Date.now() - lastChangeAt > STALE_AFTER_MS ? 'stale' : current;
      });
    }, 15_000);
    return () => window.clearInterval(handle);
  }, [lastChangeAt]);

  return {
    meta,
    snapshot,
    identity,
    connection,
    errorMessage,
    lastChangeAt,
    pollIntervalMs: intervalMs,
    setRegion,
    regionId,
    refresh,
    refreshIdentity,
  };
}
