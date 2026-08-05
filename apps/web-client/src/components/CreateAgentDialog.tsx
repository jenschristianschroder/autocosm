import { useEffect, useId, useRef, useState } from 'react';
import type { JSX } from 'react';
import { DRIVE_IDS, HABITAT_PREFERENCES, SENSORY_BIASES, TEMPERAMENTS } from '@autocosm/domain';
import { ApiError, createAgent, newIdempotencyKey } from '../api';
import type { CreateAgentRequest, CreateAgentResponse } from '../types';
import { Dialog } from './Dialog';

/**
 * Agent authoring.
 *
 * This is one of the only two ways a human touches the world, and it is deliberately an act of
 * authorship rather than control: the creator chooses a starting nature and a habitat, and the
 * simulation decides everything after that. The copy says so plainly, because a creator who
 * expects to be able to save their agent later will be disappointed by design.
 */

const DEFAULT_DRIVES: CreateAgentRequest['drives'] = {
  survive: 700,
  forage: 600,
  reproduce: 450,
  explore: 400,
  cooperate: 300,
  build: 250,
};

const MAX_TOTAL_DRIVE = 3000;

const HABITAT_BLURB: Record<string, string> = {
  abyss: 'Cold, dark, mineral-rich. Almost no light to eat by.',
  shallows: 'Bright water. Plentiful light, plentiful predators.',
  shore: 'The boundary. Volatile temperature, rich in materials.',
  plain: 'Open ground. Steady biomass, little cover.',
  highland: 'Thin and cold, but exposed to the strongest light.',
};

export interface CreateAgentDialogProps {
  readonly open: boolean;
  readonly agentsRemainingToday: number | undefined;
  readonly onClose: () => void;
  readonly onCreated: (response: CreateAgentResponse) => void;
}

export function CreateAgentDialog(props: CreateAgentDialogProps): JSX.Element | null {
  const formId = useId();
  const [name, setName] = useState('');
  const [aspiration, setAspiration] = useState('');
  const [habitat, setHabitat] = useState<CreateAgentRequest['habitat']>('shallows');
  const [temperament, setTemperament] = useState<CreateAgentRequest['temperament']>('balanced');
  const [sensoryBias, setSensoryBias] = useState<CreateAgentRequest['sensoryBias']>('balanced');
  const [visualSeed, setVisualSeed] = useState(() => Math.floor(Date.now() % 65_536));
  const [drives, setDrives] = useState(DEFAULT_DRIVES);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [details, setDetails] = useState<readonly string[]>([]);

  // A stable key per dialog opening: retrying after a network wobble must not author two lineages.
  const idempotencyKeyRef = useRef<string>('');
  useEffect(() => {
    if (props.open) {
      idempotencyKeyRef.current = newIdempotencyKey();
      setError(undefined);
      setDetails([]);
    }
  }, [props.open]);

  if (!props.open) return null;

  const total = DRIVE_IDS.reduce((sum, id) => sum + drives[id], 0);
  const overBudget = total > MAX_TOTAL_DRIVE;
  const exhausted = props.agentsRemainingToday === 0;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (overBudget || submitting) return;
    setSubmitting(true);
    setError(undefined);
    setDetails([]);
    try {
      const response = await createAgent(
        { name, aspiration, habitat, temperament, sensoryBias, visualSeed, drives },
        idempotencyKeyRef.current,
      );
      props.onCreated(response);
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        setDetails(cause.details);
      } else {
        setError(cause instanceof Error ? cause.message : 'The world could not be reached.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Author a new lineage" onClose={props.onClose}>
      <p className="muted">
        Your agent enters the world as a single viable cell. You choose what it starts as and where
        it starts. You cannot feed it, move it, or save it. It may not survive the first day.
      </p>

      <form id={formId} className="form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            required
            minLength={2}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            placeholder="Verdant Drift"
          />
        </label>

        <label className="field">
          <span>Broad aspiration</span>
          <input
            type="text"
            value={aspiration}
            required
            minLength={4}
            maxLength={160}
            onChange={(e) => setAspiration(e.target.value)}
            placeholder="Endure the dark and remember the way back"
          />
          <span className="field__hint">
            A disposition it carries from birth. It is not a command.
          </span>
        </label>

        <fieldset className="field">
          <legend>Starting habitat</legend>
          <div className="choices">
            {HABITAT_PREFERENCES.map((option) => (
              <label key={option} className="choice">
                <input
                  type="radio"
                  name="habitat"
                  value={option}
                  checked={habitat === option}
                  onChange={() => setHabitat(option)}
                />
                <span className="choice__label">{option}</span>
                <span className="choice__blurb">{HABITAT_BLURB[option]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field-row">
          <label className="field">
            <span>Temperament</span>
            <select
              value={temperament}
              onChange={(e) => setTemperament(e.target.value as typeof temperament)}
            >
              {TEMPERAMENTS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Sensory bias</span>
            <select
              value={sensoryBias}
              onChange={(e) => setSensoryBias(e.target.value as typeof sensoryBias)}
            >
              {SENSORY_BIASES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Visual seed</span>
            <input
              type="number"
              min={0}
              max={65535}
              value={visualSeed}
              onChange={(e) => setVisualSeed(clampSeed(e.target.value))}
            />
          </label>
        </div>

        <fieldset className="field">
          <legend>
            Starting drives{' '}
            <span className={overBudget ? 'error' : 'muted'}>
              {total} / {MAX_TOTAL_DRIVE}
            </span>
          </legend>
          <p className="field__hint">
            Drives compete for the same attention. Raising one meaningfully means lowering another.
          </p>
          {DRIVE_IDS.map((id) => (
            <label key={id} className="slider">
              <span className="slider__label">{id}</span>
              <input
                type="range"
                min={0}
                max={1000}
                step={10}
                value={drives[id]}
                onChange={(e) => setDrives({ ...drives, [id]: Number(e.target.value) })}
              />
              <span className="slider__value">{drives[id]}</span>
            </label>
          ))}
          {overBudget && (
            <p className="error" role="alert">
              Total drive weight may not exceed {MAX_TOTAL_DRIVE}.
            </p>
          )}
        </fieldset>

        {exhausted && (
          <p className="error" role="alert">
            You have used today's allowance of new lineages. Try again tomorrow.
          </p>
        )}
        {error !== undefined && (
          <div className="error" role="alert">
            <p>{error}</p>
            {details.length > 0 && (
              <ul>
                {details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>

      <div className="dialog__actions">
        <button type="button" className="button button--ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="submit"
          form={formId}
          className="button"
          disabled={submitting || overBudget || exhausted}
        >
          {submitting ? 'Releasing into the world…' : 'Release into the world'}
        </button>
      </div>
      {props.agentsRemainingToday !== undefined && !exhausted && (
        <p className="muted small">
          {props.agentsRemainingToday} more lineage{props.agentsRemainingToday === 1 ? '' : 's'}{' '}
          available to you today.
        </p>
      )}
    </Dialog>
  );
}

function clampSeed(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(65_535, Math.max(0, parsed));
}
