import type { JSX } from 'react';
import { dayOfTick, describeDayPhase } from '@autocosm/domain';
import type { ConnectionState } from '../state/use-world-feed';
import type { SnapshotResponse, WorldMetaResponse } from '../types';

/**
 * Status bar.
 *
 * States an observer must be able to tell apart at a glance: still starting, live, running behind,
 * offline, or broken. Silently showing a two-hour-old world as if it were live would be a lie
 * about a world whose whole point is that it keeps going without you.
 *
 * The clock reads the snapshot's authoritative `dayPhasePerMille` rather than deriving one from
 * the tick, so the time shown is the same daylight the simulation used when it last fed
 * photosynthesis. Nothing here runs its own clock.
 */

export interface StatusBarProps {
  readonly meta: WorldMetaResponse | undefined;
  readonly snapshot: SnapshotResponse | undefined;
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

/**
 * Weather names an observer can read.
 *
 * Keyed by the pressure enum, so adding a pressure kind fails the build here rather than silently
 * showing an unnamed one.
 */
const PRESSURE: Record<SnapshotResponse['pressure']['kind'], { label: string; hint: string }> = {
  calm: {
    label: 'calm',
    hint: 'No environmental pressure. Upkeep and growth are at their usual rates.',
  },
  heatwave: {
    label: 'heat wave',
    hint: 'Thermal stress raises the energy every organism spends staying alive.',
  },
  coldSnap: { label: 'cold snap', hint: 'Thermal stress raises upkeep and suppresses new growth.' },
  drought: {
    label: 'drought',
    hint: 'Primary production is suppressed, so biomass regrows slowly.',
  },
  bloom: { label: 'bloom', hint: 'Primary production is amplified, so biomass regrows quickly.' },
  storm: {
    label: 'storm',
    hint: 'Upkeep rises and the air thickens. Visibility drops across the world.',
  },
};

export function StatusBar(props: StatusBarProps): JSX.Element {
  const { meta, snapshot, connection } = props;
  const showRetry = connection === 'error' || connection === 'stale' || connection === 'offline';
  const phase =
    snapshot !== undefined && meta !== undefined
      ? {
          ...describeDayPhase(snapshot.dayPhasePerMille),
          day: dayOfTick(snapshot.tick, meta.calendar),
          light: snapshot.lightPerMille,
          pressure: PRESSURE[snapshot.pressure.kind],
          severity: snapshot.pressure.severity,
        }
      : undefined;

  return (
    <footer className="statusbar" aria-label="World status">
      <span className={`statusbar__state statusbar__state--${connection}`} role="status">
        <span className="statusbar__dot" aria-hidden="true" />
        {LABEL[connection]}
      </span>

      {phase && (
        <span
          className={`statusbar__clock statusbar__clock--${phase.name}`}
          title={`Day ${phase.day + 1}, ${phase.clock} — ${phase.name}. Ambient light ${phase.light}‰ of full daylight.`}
        >
          <span className="statusbar__sun" aria-hidden="true" style={sunStyle(phase.light)} />
          <span className="statusbar__time">{phase.clock}</span>
          <span className="statusbar__phase">
            {phase.name} · day {(phase.day + 1).toLocaleString()}
          </span>
        </span>
      )}

      {phase && (
        <span
          className={
            snapshot?.pressure.kind === 'calm'
              ? 'statusbar__item muted'
              : 'statusbar__item statusbar__item--weather'
          }
          title={phase.pressure.hint}
        >
          {phase.pressure.label}
          {snapshot?.pressure.kind !== 'calm' ? ` ${severityWord(phase.severity)}` : ''}
        </span>
      )}

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

/** Brightness and warmth of the dot track ambient light, so night reads as night at a glance. */
function sunStyle(lightPerMille: number): { background: string; boxShadow: string } {
  const light = Math.max(0, Math.min(1000, lightPerMille)) / 1000;
  const lum = Math.round(28 + light * 62);
  const hue = Math.round(212 - light * 168);
  const sat = Math.round(24 + light * 66);
  return {
    background: `hsl(${hue} ${sat}% ${lum}%)`,
    boxShadow: `0 0 ${Math.round(2 + light * 8)}px hsl(${hue} ${sat}% ${lum}% / ${0.25 + light * 0.5})`,
  };
}

function severityWord(severity: number): string {
  if (severity >= 800) return 'severe';
  if (severity >= 500) return 'strong';
  return 'mild';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
