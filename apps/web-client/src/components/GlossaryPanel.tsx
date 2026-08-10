import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { fetchGlossary } from '../api';
import type { GlossaryEntryDto, GlossaryResponse } from '../types';

/**
 * Field guide to the world's vocabulary.
 *
 * Every term a spectator can see on a structure, an organism or a rejected action is defined here,
 * along with the actual thresholds the simulation uses. The content is derived from the domain's
 * own rule tables rather than written by hand, so an explanation cannot drift away from the
 * behaviour it describes, and it costs nothing to serve — no model is involved in answering "what
 * does this building do".
 */

export interface GlossaryPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

type SectionKey = Exclude<keyof GlossaryResponse, 'version'>;

/**
 * Typed as a total record so adding a section to `GlossaryResponse` without giving it a heading is
 * a compile error rather than a section that silently never renders. Declaration order is render
 * order.
 */
const SECTION_TITLES: Readonly<Record<SectionKey, string>> = {
  structureFunctions: 'What buildings do',
  structurePatterns: 'Building patterns',
  materialProperties: 'Material properties',
  materialReactions: 'How crafting transforms matter',
  traits: 'Heritable traits',
  signalChannels: 'Signal channels',
  deathCauses: 'Causes of death',
  rejectionReasons: 'Why an action is refused',
  decisionReasons: 'Why an agent was asked to think',
};

const SECTION_KEYS = Object.keys(SECTION_TITLES) as readonly SectionKey[];

export function GlossaryPanel(props: GlossaryPanelProps): JSX.Element | null {
  const [glossary, setGlossary] = useState<GlossaryResponse>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const { open } = props;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(undefined);
    void fetchGlossary()
      .then((value) => {
        if (!cancelled) setGlossary(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load the glossary.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const sections = useMemo(() => {
    if (glossary === undefined) return [];
    const needle = query.trim().toLowerCase();
    return SECTION_KEYS.map((key) => {
      const entries: readonly GlossaryEntryDto[] = glossary[key];
      return {
        key,
        title: SECTION_TITLES[key],
        entries:
          needle === ''
            ? entries
            : entries.filter(
                (entry) =>
                  entry.label.toLowerCase().includes(needle) ||
                  entry.summary.toLowerCase().includes(needle),
              ),
      };
    }).filter((section) => section.entries.length > 0);
  }, [glossary, query]);

  if (!open) return null;

  return (
    <section className="panel panel--glossary" aria-label="Glossary">
      <header className="panel__header">
        <h2>Field guide</h2>
        <button type="button" className="button button--ghost" onClick={props.onClose}>
          Close
        </button>
      </header>

      {error !== undefined && <p className="error">{error}</p>}
      {glossary === undefined && error === undefined && (
        <p className="muted" role="status">
          Loading…
        </p>
      )}

      {glossary !== undefined && (
        <>
          <label className="field">
            <span className="sr-only">Search the glossary</span>
            <input
              type="search"
              value={query}
              placeholder="Search terms…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          {sections.length === 0 && <p className="muted">Nothing matches “{query}”.</p>}

          {sections.map((section) => (
            <section key={section.key}>
              <h3>{section.title}</h3>
              <ul className="definitions">
                {section.entries.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.label}</strong>
                    <p className="small">{entry.summary}</p>
                    {entry.detail !== undefined && <p className="muted small">{entry.detail}</p>}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className="muted small">
            These definitions come from the simulation's own rules, not from a description of them.
          </p>
        </>
      )}
    </section>
  );
}
