import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useWorldFeed } from './state/use-world-feed';
import { usePrefersReducedMotion } from './state/use-reduced-motion';
import { Viewport } from './components/Viewport';
import { InspectorPanel } from './components/InspectorPanel';
import { LineageTree } from './components/LineageTree';
import { EventTimeline } from './components/EventTimeline';
import { CreateAgentDialog } from './components/CreateAgentDialog';
import { GoalDialog } from './components/GoalDialog';
import { StatusBar } from './components/StatusBar';
import { WorldNavigator } from './components/WorldNavigator';
import type { Selection } from './types';

/**
 * Observatory shell.
 *
 * Holds selection, dialog and layout state. Everything authoritative comes from `useWorldFeed`;
 * this component never derives a world fact of its own.
 */

export function App(): JSX.Element {
  const feed = useWorldFeed();
  const reducedMotion = usePrefersReducedMotion();

  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [following, setFollowing] = useState(false);
  const [lineageId, setLineageId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [goalTarget, setGoalTarget] = useState<{ id: string; name: string }>();
  const [toast, setToast] = useState<string>();
  const [backend, setBackend] = useState<string>();
  const [fps, setFps] = useState<number>();
  const [panelsOpen, setPanelsOpen] = useState(true);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (next.kind === 'none') setFollowing(false);
  }, []);

  useEffect(() => {
    if (toast === undefined) return;
    const handle = window.setTimeout(() => setToast(undefined), 9000);
    return () => window.clearTimeout(handle);
  }, [toast]);

  // Keyboard shortcuts stay off single letters that a form field would swallow.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (event.key === 'Escape') {
        select({ kind: 'none' });
        setLineageId(undefined);
      } else if (event.key === 'f' && selection.kind !== 'none') {
        setFollowing((value) => !value);
      } else if (event.key === 'h') {
        setPanelsOpen((value) => !value);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [select, selection.kind]);

  const canCreate = feed.identity !== undefined;
  const tick = feed.snapshot?.tick ?? feed.meta?.tick ?? 0;

  const emptyWorld = useMemo(
    () => feed.meta !== undefined && feed.meta.stats.livingOrganisms === 0,
    [feed.meta],
  );

  return (
    <div className={panelsOpen ? 'app' : 'app app--immersive'}>
      <a className="skip-link" href="#inspector">
        Skip to inspector
      </a>

      <header className="topbar">
        <h1 className="topbar__title">
          Autocosm
          <span className="topbar__subtitle">
            a world that keeps going whether or not you are watching
          </span>
        </h1>
        <div className="topbar__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setPanelsOpen((value) => !value)}
            aria-pressed={!panelsOpen}
          >
            {panelsOpen ? 'Hide panels (H)' : 'Show panels (H)'}
          </button>
        </div>
      </header>

      <main className="layout">
        <WorldNavigator
          meta={feed.meta}
          selection={selection}
          regionId={feed.regionId}
          onSelect={select}
          onRegion={feed.setRegion}
          onCreateAgent={() => setCreateOpen(true)}
          canCreate={canCreate}
        />

        <div className="stage">
          <Viewport
            snapshot={feed.snapshot}
            selection={selection}
            following={following}
            reducedMotion={reducedMotion}
            pollIntervalMs={feed.pollIntervalMs}
            onBackend={setBackend}
            onFps={setFps}
          />

          {feed.connection === 'coldStart' && feed.snapshot === undefined && (
            <div className="stage__overlay" role="status">
              <div className="spinner" aria-hidden="true" />
              <p>Waking the world. The first request after an idle period takes a few seconds.</p>
            </div>
          )}

          {feed.connection === 'error' && feed.snapshot === undefined && (
            <div className="stage__overlay" role="alert">
              <h2>The world is not reachable</h2>
              <p>{feed.errorMessage ?? 'The API did not respond.'}</p>
              <button type="button" className="button" onClick={feed.refresh}>
                Try again
              </button>
            </div>
          )}

          {feed.connection === 'offline' && (
            <div className="stage__overlay" role="alert">
              <h2>You are offline</h2>
              <p>
                The world is still running. This view will resume when your connection comes back.
              </p>
            </div>
          )}

          {emptyWorld && feed.connection === 'live' && (
            <div className="stage__overlay stage__overlay--soft" role="status">
              <h2>Nothing is alive here</h2>
              <p>Every lineage has died out. Author a new one to start the world again.</p>
              <button type="button" className="button" onClick={() => setCreateOpen(true)}>
                Author a lineage
              </button>
            </div>
          )}

          {feed.connection === 'stale' && feed.snapshot !== undefined && (
            <div className="stage__banner" role="status">
              This view is behind the world. The simulation is still advancing.
              <button type="button" className="link" onClick={feed.refresh}>
                refresh
              </button>
            </div>
          )}
        </div>

        <div className="sidebar" id="inspector">
          <InspectorPanel
            selection={selection}
            snapshot={feed.snapshot}
            following={following}
            onToggleFollow={() => setFollowing((value) => !value)}
            onSelect={select}
            onRequestGoal={(id, name) => setGoalTarget({ id, name })}
            onShowLineage={setLineageId}
          />
          <EventTimeline tick={tick} regionId={feed.regionId} onSelect={select} />
        </div>
      </main>

      {lineageId !== undefined && (
        <div className="floating">
          <LineageTree
            lineageId={lineageId}
            onSelectOrganism={(organismId) => select({ kind: 'organism', id: organismId })}
            onClose={() => setLineageId(undefined)}
          />
        </div>
      )}

      <StatusBar
        meta={feed.meta}
        connection={feed.connection}
        errorMessage={feed.errorMessage}
        lastChangeAt={feed.lastChangeAt}
        backend={backend}
        fps={fps}
        onRetry={feed.refresh}
      />

      <CreateAgentDialog
        open={createOpen}
        agentsRemainingToday={feed.identity?.agentsRemainingToday}
        onClose={() => setCreateOpen(false)}
        onCreated={(response) => {
          setCreateOpen(false);
          setToast(response.message);
          select({ kind: 'agent', id: response.agentId });
          feed.refresh();
          feed.refreshIdentity();
        }}
      />

      {goalTarget !== undefined && (
        <GoalDialog
          agentId={goalTarget.id}
          agentName={goalTarget.name}
          onClose={() => setGoalTarget(undefined)}
          onSubmitted={(message) => {
            setGoalTarget(undefined);
            setToast(message);
          }}
        />
      )}

      {toast !== undefined && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
