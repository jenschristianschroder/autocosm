import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { fetchAgent, fetchOrganism } from '../api';
import type {
  AgentDetailResponse,
  OrganismDetailResponse,
  Selection,
  SnapshotResponse,
} from '../types';

/**
 * Inspection panel.
 *
 * Read-only by construction: it renders detail responses and offers exactly one action that
 * touches the world — submitting a broad goal — which is delegated upward. There is no control
 * here that moves, feeds, heals or edits anything, and there is no hidden one either.
 */

export interface InspectorPanelProps {
  readonly selection: Selection;
  readonly snapshot: SnapshotResponse | undefined;
  readonly following: boolean;
  readonly onToggleFollow: () => void;
  readonly onSelect: (selection: Selection) => void;
  readonly onRequestGoal: (agentId: string, agentName: string) => void;
  readonly onShowLineage: (lineageId: string) => void;
}

export function InspectorPanel(props: InspectorPanelProps): JSX.Element {
  const { selection } = props;
  const [agent, setAgent] = useState<AgentDetailResponse>();
  const [organism, setOrganism] = useState<OrganismDetailResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setError(undefined);

    if (selection.kind === 'none') {
      setAgent(undefined);
      setOrganism(undefined);
      return;
    }

    setLoading(true);
    const work =
      selection.kind === 'organism'
        ? fetchOrganism(selection.id).then(async (detail) => {
            if (cancelled) return;
            setOrganism(detail);
            const owner = await fetchAgent(detail.agentId);
            if (!cancelled) setAgent(owner);
          })
        : selection.kind === 'agent'
          ? fetchAgent(selection.id).then((detail) => {
              if (cancelled) return;
              setAgent(detail);
              setOrganism(undefined);
            })
          : Promise.resolve();

    void work
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load details.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selection]);

  if (selection.kind === 'none') {
    return (
      <aside className="panel panel--inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="muted">
          Select a lineage or an organism to inspect it. You are an observer: you can look at
          anything and change nothing.
        </p>
      </aside>
    );
  }

  if (selection.kind === 'structure') {
    const structure = props.snapshot?.structures.find((s) => s.id === selection.id);
    return (
      <aside className="panel panel--inspector" aria-label="Inspector">
        <header className="panel__header">
          <h2>{structure?.label ?? 'Structure'}</h2>
          <FollowButton following={props.following} onToggle={props.onToggleFollow} />
        </header>
        {!structure && <p className="muted">This structure is outside the current view.</p>}
        {structure && (
          <>
            <dl className="facts">
              <Fact label="Pattern" value={structure.pattern} />
              <Fact label="Integrity" value={perMille(structure.integrity)} />
              <Fact label="Volume" value={`${structure.volume} cm³`} />
              <Fact label="Built at tick" value={String(structure.createdAtTick)} />
            </dl>
            <h3>Derived functions</h3>
            {structure.functions.length === 0 ? (
              <p className="muted">
                Its materials do not combine into any working function. It is inert.
              </p>
            ) : (
              <ul className="chips">
                {structure.functions.map((fn) => (
                  <li key={fn.id} className="chip">
                    {fn.id} · {perMille(fn.magnitude)}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">
              Functions are computed by the simulation from measured material properties. No agent
              can declare that a thing works.
            </p>
            <button
              type="button"
              className="link"
              onClick={() => props.onSelect({ kind: 'agent', id: structure.createdByAgentId })}
            >
              Inspect its builder
            </button>
          </>
        )}
      </aside>
    );
  }

  return (
    <aside className="panel panel--inspector" aria-label="Inspector">
      <header className="panel__header">
        <h2>{agent?.name ?? 'Loading…'}</h2>
        <FollowButton following={props.following} onToggle={props.onToggleFollow} />
      </header>

      {loading && (
        <p className="muted" role="status">
          Loading details…
        </p>
      )}
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {agent && (
        <>
          <p className="aspiration">“{agent.aspiration}”</p>
          <dl className="facts">
            <Fact label="Status" value={agent.status} />
            <Fact label="Temperament" value={agent.temperament} />
            <Fact label="Living organisms" value={String(agent.livingOrganisms)} />
            <Fact label="Generations" value={String(agent.generations)} />
            <Fact label="Births / deaths" value={`${agent.births} / ${agent.deaths}`} />
            <Fact label="AI decisions" value={String(agent.decisionCount)} />
          </dl>

          {organism && (
            <>
              <h3>Selected organism</h3>
              <dl className="facts">
                <Fact
                  label="Energy"
                  value={`${organism.energy} / ${organism.maxEnergy} J`}
                  bar={ratio(organism.energy, organism.maxEnergy)}
                />
                <Fact
                  label="Health"
                  value={`${organism.health} / ${organism.maxHealth}`}
                  bar={ratio(organism.health, organism.maxHealth)}
                />
                <Fact
                  label="Age"
                  value={`${organism.ageTicks} / ${organism.maxAgeTicks} ticks`}
                  bar={ratio(organism.ageTicks, organism.maxAgeTicks)}
                />
                <Fact label="Generation" value={String(organism.generation)} />
                {organism.causeOfDeath !== undefined && (
                  <Fact label="Cause of death" value={organism.causeOfDeath} />
                )}
              </dl>
              {organism.inventory.length > 0 && (
                <>
                  <h3>Carrying</h3>
                  <ul className="chips">
                    {organism.inventory.map((item) => (
                      <li key={item.materialId} className="chip">
                        {item.materialId} × {item.quantity}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          <h3>Heritable traits</h3>
          <ul className="traits">
            {(organism?.traits ?? agent.meanTraits).map((trait) => (
              <li key={trait.id}>
                <span className="traits__name">{humanise(trait.id)}</span>
                <span
                  className="traits__bar"
                  role="img"
                  aria-label={`${humanise(trait.id)}: ${perMille(trait.value)}`}
                >
                  <span className="traits__fill" style={{ width: `${trait.value / 10}%` }} />
                  {trait.effective !== trait.value && (
                    <span
                      className="traits__effective"
                      style={{ left: `${trait.effective / 10}%` }}
                      title={`Currently expressed: ${perMille(trait.effective)}`}
                    />
                  )}
                </span>
                <span className="traits__value">{perMille(trait.value)}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Every trait costs something. The tick marks where the trait is currently expressed after
            environmental and energetic pressure.
          </p>

          {agent.knownMaterials.length > 0 && (
            <>
              <h3>Known materials</h3>
              <ul className="chips">
                {agent.knownMaterials.map((id) => (
                  <li key={id} className="chip">
                    {id}
                  </li>
                ))}
              </ul>
            </>
          )}

          {agent.knownRecipes.length > 0 && (
            <>
              <h3>Learned designs</h3>
              <ul className="chips">
                {agent.knownRecipes.map((recipe) => (
                  <li key={recipe.label} className="chip">
                    {recipe.label} · tick {recipe.learnedAtTick}
                  </li>
                ))}
              </ul>
            </>
          )}

          {agent.recentMemories.length > 0 && (
            <>
              <h3>Recent memories</h3>
              <ul className="memories">
                {agent.recentMemories.map((memory, index) => (
                  <li key={`${memory.kind}-${memory.createdAtTick}-${index}`}>
                    <span className="memories__kind">{memory.kind}</span>
                    <span>{memory.note}</span>
                    <span className="muted small">tick {memory.createdAtTick}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Goals you have offered</h3>
          {agent.goals.length === 0 ? (
            <p className="muted">No goals yet.</p>
          ) : (
            <ul className="goals">
              {agent.goals.map((goal) => (
                <li key={goal.id} data-status={goal.status}>
                  <span className="goals__status">{goal.status}</span>
                  <span>“{goal.text}”</span>
                  {goal.resolutionNote !== undefined && (
                    <span className="muted small">{goal.resolutionNote}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="panel__actions">
            <button
              type="button"
              className="button"
              onClick={() => props.onRequestGoal(agent.id, agent.name)}
              disabled={agent.status === 'extinct'}
            >
              Offer a broad goal
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => props.onShowLineage(agent.lineageId)}
            >
              View lineage
            </button>
          </div>
          <p className="muted small">
            A goal is a motivation, not an instruction. This lineage may adopt it, defer it, or
            reject it outright.
          </p>
        </>
      )}
    </aside>
  );
}

function FollowButton(props: { following: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="button button--ghost"
      aria-pressed={props.following}
      onClick={props.onToggle}
    >
      {props.following ? 'Stop following' : 'Follow'}
    </button>
  );
}

function Fact(props: { label: string; value: string; bar?: number }): JSX.Element {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>
        {props.value}
        {props.bar !== undefined && (
          <span className="meter" aria-hidden="true">
            <span className="meter__fill" style={{ width: `${Math.round(props.bar * 100)}%` }} />
          </span>
        )}
      </dd>
    </>
  );
}

const ratio = (value: number, max: number): number =>
  max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;

const perMille = (value: number): string => `${(value / 10).toFixed(0)}%`;

export function humanise(id: string): string {
  return id.replace(/([A-Z])/gu, ' $1').replace(/^./u, (c) => c.toUpperCase());
}
