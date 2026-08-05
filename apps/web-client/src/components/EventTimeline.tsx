import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { fetchEvents } from '../api';
import type { EventDto, Selection } from '../types';

/**
 * Event timeline.
 *
 * The world's own account of what happened, newest first. Every entry is an append-only event the
 * simulation wrote when it resolved a tick, so this is a history, not a log of intentions.
 */

export interface EventTimelineProps {
  readonly tick: number;
  readonly regionId: string | undefined;
  readonly onSelect: (selection: Selection) => void;
}

const KIND_CLASS: Record<string, string> = {
  birth: 'event--birth',
  death: 'event--death',
  predation: 'event--conflict',
  attack: 'event--conflict',
  construction: 'event--build',
  discovery: 'event--discovery',
  signal: 'event--social',
  share: 'event--social',
  goalSubmitted: 'event--goal',
  goalResolved: 'event--goal',
  pressure: 'event--pressure',
};

export function EventTimeline(props: EventTimelineProps): JSX.Element {
  const [events, setEvents] = useState<readonly EventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const { tick, regionId } = props;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchEvents({ ...(regionId === undefined ? {} : { regionId }), limit: 60 })
      .then((page) => {
        if (!cancelled) {
          setEvents(page.events);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load world events.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Refetch whenever the world advances or the observer changes the region they are watching.
  }, [tick, regionId]);

  return (
    <section className="panel panel--timeline" aria-label="World events">
      <h2>World events</h2>

      {loading && events.length === 0 && (
        <p className="muted" role="status">
          Reading the world's history…
        </p>
      )}
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loading && events.length === 0 && error === undefined && (
        <p className="muted">Nothing has happened here yet. The world is still very young.</p>
      )}

      <ol className="events">
        {events.map((event) => (
          <li key={event.id} className={`event ${KIND_CLASS[event.kind] ?? ''}`}>
            <span className="event__tick">t{event.tick}</span>
            <span className="event__body">
              <span className="event__kind">{event.kind}</span>
              <span className="event__summary">{event.summary}</span>
            </span>
            {event.agentId !== undefined && (
              <button
                type="button"
                className="link"
                onClick={() => props.onSelect({ kind: 'agent', id: event.agentId as string })}
              >
                inspect
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
