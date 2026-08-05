import type { JSX } from 'react';
import type { ConnectionState } from '../state/use-world-feed';
import type { WorldMetaResponse } from '../types';

/**
 * Status bar.
 *
 * States an observer must be able to tell apart at a glance: still starting, live, running behind,
 * offline, or broken. Silently showing a two-hour-old world as if it were live would be a lie
 * about a world whose whole point is that it keeps going without you.
 */

export interface StatusBarProps {
  readonly meta: WorldMetaResponse | undefined;
  readonly connection: ConnectionState;
  readonly errorMessage: string | undefined;
  readonly lastChangeAt: number | undefined;
  readonly backend: string | undefined;
  readonly fps: number | undefined;
  readonly onRetry: () => void;
}

const LABEL: Record<ConnectionState, string> = {
  initialising: 'Connecting',
  coldStart: 'Waking the world',
  live: 'Live',
  stale: 'Running behind',
  offline: 'Offline',
  error: 'Unavailable',
};

export function StatusBar(props: StatusBarProps): JSX.Element {
  const { meta, connection } = props;
  const showRetry = connection === 'error' || connection === 'stale' || connection === 'offline';

  return (
    <footer className="statusbar" aria-label="World status">
      <span className={`statusbar__state statusbar__state--${connection}`} role="status">
        <span className="statusbar__dot" aria-hidden="true" />
        {LABEL[connection]}
      </span>

      {meta && (
        <>
          <span className="statusbar__item">
            <abbr title="Logical simulation tick">tick</abbr> {meta.tick.toLocaleString()}
          </span>
          <span className="statusbar__item">{meta.stats.livingOrganisms} living</span>
          <span className="statusbar__item">{meta.stats.activeLineages} lineages</span>
          <span className="statusbar__item">{meta.stats.structures} structures</span>
          <span className="statusbar__item">{meta.stats.discoveredMaterials} materials known</span>
        </>
      )}

      {props.lastChangeAt !== undefined && (
        <span className="statusbar__item muted">updated {relative(props.lastChangeAt)}</span>
      )}

      {props.backend !== undefined && (
        <span className="statusbar__item muted">
          {props.backend}
          {props.fps !== undefined ? ` · ${props.fps} fps` : ''}
        </span>
      )}

      {meta?.heuristicOnly === true && (
        <span
          className="statusbar__badge"
          title="No AI provider is configured for this deployment."
        >
          heuristic minds
        </span>
      )}
      {meta?.aiDegraded === true && (
        <span
          className="statusbar__badge statusbar__badge--warn"
          title="An AI provider is configured but failing. Agents are falling back to deterministic behaviour."
        >
          AI degraded
        </span>
      )}

      {props.errorMessage !== undefined && connection !== 'live' && (
        <span className="statusbar__item error" title={props.errorMessage}>
          {truncate(props.errorMessage, 80)}
        </span>
      )}

      {showRetry && (
        <button type="button" className="button button--ghost button--tiny" onClick={props.onRetry}>
          Retry now
        </button>
      )}
    </footer>
  );
}

function relative(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
