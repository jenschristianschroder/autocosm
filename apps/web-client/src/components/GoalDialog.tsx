import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ApiError, newIdempotencyKey, submitGoal } from '../api';
import { Dialog } from './Dialog';

/**
 * Broad-goal submission.
 *
 * The second and last human mutation. The wording matters as much as the code: a goal is offered,
 * not issued, and the agent's own drives decide whether it is ever acted on. Once submitted it is
 * immutable — there is no edit or withdraw, because a creator who could retract a goal would be
 * steering.
 */

export interface GoalDialogProps {
  readonly agentId: string;
  readonly agentName: string;
  readonly onClose: () => void;
  readonly onSubmitted: (message: string, remainingToday: number) => void;
}

const SUGGESTIONS = [
  'Seek the ocean',
  'Protect your descendants',
  'Learn what the bright stone does',
  'Do not go into the dark alone',
  'Build something that outlasts you',
];

export function GoalDialog(props: GoalDialogProps): JSX.Element {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  useEffect(() => {
    idempotencyKeyRef.current = newIdempotencyKey();
  }, [props.agentId]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await submitGoal(props.agentId, text.trim(), idempotencyKeyRef.current);
      props.onSubmitted(response.message, response.remainingToday);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'The world could not be reached.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog title={`Offer a goal to ${props.agentName}`} onClose={props.onClose}>
      <p className="muted">
        Say what you hope for, broadly. {props.agentName} may adopt it, put it off, or decide it
        wants no part of it. You cannot take it back.
      </p>

      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>Goal</span>
          <textarea
            value={text}
            required
            minLength={4}
            maxLength={160}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            placeholder="Seek the ocean"
          />
          <span className="field__hint">{text.trim().length} / 160 characters</span>
        </label>

        <div className="suggestions">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="chip chip--button"
              onClick={() => setText(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>

        {error !== undefined && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog__actions">
          <button type="button" className="button button--ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={submitting || text.trim().length < 4}>
            {submitting ? 'Offering…' : 'Offer this goal'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
