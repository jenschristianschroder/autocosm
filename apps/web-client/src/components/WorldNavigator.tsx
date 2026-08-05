import type { JSX } from 'react';
import type { Selection, WorldMetaResponse } from '../types';

/**
 * Lineage roster and region picker.
 *
 * The navigational spine of the observatory: which lineages exist, and which part of the world the
 * snapshot window is centred on. Choosing a region changes what the observer *sees*; it changes
 * nothing about what the world *is*.
 */

export interface WorldNavigatorProps {
  readonly meta: WorldMetaResponse | undefined;
  readonly selection: Selection;
  readonly regionId: string | undefined;
  readonly onSelect: (selection: Selection) => void;
  readonly onRegion: (regionId: string | undefined) => void;
  readonly onCreateAgent: () => void;
  readonly canCreate: boolean;
}

export function WorldNavigator(props: WorldNavigatorProps): JSX.Element {
  const { meta } = props;
  const active = meta?.agents.filter((a) => a.status === 'active') ?? [];
  const extinct = meta?.agents.filter((a) => a.status === 'extinct') ?? [];

  return (
    <nav className="panel panel--navigator" aria-label="Lineages and regions">
      <header className="panel__header">
        <h2>{meta?.name ?? 'Autocosm'}</h2>
      </header>

      <button
        type="button"
        className="button button--primary button--block"
        onClick={props.onCreateAgent}
        disabled={!props.canCreate}
      >
        Author a lineage
      </button>
      {!props.canCreate && (
        <p className="muted small">
          Authoring needs a creator identity from the world. Reload if this persists.
        </p>
      )}

      <h3>Lineages</h3>
      {!meta && <p className="muted">Loading…</p>}
      {meta && active.length === 0 && extinct.length === 0 && (
        <p className="muted">No lineages yet. This world is empty.</p>
      )}

      <ul className="roster">
        {active.map((agent) => (
          <li key={agent.id}>
            <button
              type="button"
              className={
                props.selection.kind === 'agent' && props.selection.id === agent.id
                  ? 'roster__item roster__item--selected'
                  : 'roster__item'
              }
              aria-current={
                props.selection.kind === 'agent' && props.selection.id === agent.id
                  ? 'true'
                  : undefined
              }
              onClick={() => props.onSelect({ kind: 'agent', id: agent.id })}
            >
              <span className="roster__swatch" style={{ background: hueColour(agent.hue) }} />
              <span className="roster__name">{agent.name}</span>
              <span className="roster__meta">
                {agent.livingOrganisms} · g{agent.generations}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {extinct.length > 0 && (
        <details className="roster__extinct">
          <summary>{extinct.length} extinct</summary>
          <ul className="roster">
            {extinct.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className="roster__item roster__item--extinct"
                  onClick={() => props.onSelect({ kind: 'agent', id: agent.id })}
                >
                  <span className="roster__swatch" style={{ background: hueColour(agent.hue) }} />
                  <span className="roster__name">{agent.name}</span>
                  <span className="roster__meta">g{agent.generations}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <h3>Region in view</h3>
      <label className="field">
        <span className="sr-only">Region</span>
        <select
          value={props.regionId ?? ''}
          onChange={(e) => props.onRegion(e.target.value === '' ? undefined : e.target.value)}
        >
          <option value="">World centre</option>
          {(meta?.regions ?? []).map((region) => (
            <option key={region.id} value={region.id}>
              {region.id} · {region.biome}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        The snapshot covers this region and its neighbours. The rest of the world keeps running
        whether or not you are watching it.
      </p>
    </nav>
  );
}

function hueColour(hue: number): string {
  return `hsl(${Math.round((hue / 1000) * 360)} 62% 55%)`;
}
