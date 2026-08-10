import { describe, expect, it } from 'vitest';
import { DECISION_REASONS } from './observation.js';
import { REJECTION_REASONS } from './actions.js';
import { DEATH_CAUSES, SIGNAL_CHANNELS } from './entities.js';
import { MATERIAL_PROPERTY_IDS, REACTION_IDS } from './materials.js';
import { STRUCTURE_FUNCTIONS, STRUCTURE_PATTERNS } from './structures.js';
import { TRAIT_IDS } from './traits.js';
import { buildGlossary, structureFunctionEntry, type GlossaryEntry } from './glossary.js';

/**
 * The glossary is the deterministic answer to "what does this thing actually do".
 *
 * Its failure mode is silent and slow: someone adds a structure function or a rejection reason, the
 * product ships, and a spectator sees a bare identifier with no explanation anywhere. The typed
 * `Record<EnumId, GlossaryEntry>` in the module makes an omission a compile error; these tests cover
 * what the type system cannot — that entries are ordered like the domain, non-empty, and that the
 * prose is genuinely explanatory rather than the identifier echoed back.
 */

const glossary = buildGlossary();

const SECTIONS: readonly {
  readonly name: string;
  readonly entries: readonly GlossaryEntry[];
  readonly ids: readonly string[];
}[] = [
  {
    name: 'structureFunctions',
    entries: glossary.structureFunctions,
    ids: STRUCTURE_FUNCTIONS,
  },
  { name: 'structurePatterns', entries: glossary.structurePatterns, ids: STRUCTURE_PATTERNS },
  { name: 'materialProperties', entries: glossary.materialProperties, ids: MATERIAL_PROPERTY_IDS },
  { name: 'materialReactions', entries: glossary.materialReactions, ids: REACTION_IDS },
  { name: 'traits', entries: glossary.traits, ids: TRAIT_IDS },
  { name: 'signalChannels', entries: glossary.signalChannels, ids: SIGNAL_CHANNELS },
  { name: 'deathCauses', entries: glossary.deathCauses, ids: DEATH_CAUSES },
  { name: 'rejectionReasons', entries: glossary.rejectionReasons, ids: REJECTION_REASONS },
  { name: 'decisionReasons', entries: glossary.decisionReasons, ids: DECISION_REASONS },
];

describe('glossary completeness', () => {
  it.each(SECTIONS)('$name explains every member of its enum', ({ entries, ids }) => {
    // Order matters: the UI renders these lists as-is, and the domain's own ordering is the one
    // that groups related concepts together.
    expect(entries.map((e) => e.id)).toEqual([...ids]);
  });

  it.each(SECTIONS)('$name entries carry a label and a summary', ({ entries }) => {
    for (const entry of entries) {
      expect(entry.label.length, `${entry.id} label`).toBeGreaterThan(0);
      expect(entry.summary.length, `${entry.id} summary`).toBeGreaterThan(10);
      // An entry whose "explanation" is the identifier again teaches nothing.
      expect(entry.summary, `${entry.id} summary`).not.toBe(entry.id);
      expect(entry.label, `${entry.id} label`).not.toBe(entry.summary);
    }
  });

  it('covers every enum the product renders, not just the ones that were easy', () => {
    expect(SECTIONS).toHaveLength(9);
    for (const section of SECTIONS) {
      expect(section.ids.length, section.name).toBeGreaterThan(0);
    }
  });
});

describe('structure function lookup', () => {
  it('resolves every function id', () => {
    for (const id of STRUCTURE_FUNCTIONS) {
      expect(structureFunctionEntry(id)?.id).toBe(id);
    }
  });

  it('states the physical requirement, so a builder can be understood not just described', () => {
    for (const id of STRUCTURE_FUNCTIONS) {
      // The detail line carries the threshold that produced the function plus the patterns it can
      // appear on. Without it, "shelter: 640‰" is a number with no explanation of where it came from.
      expect(structureFunctionEntry(id)?.detail ?? '', id).toMatch(/Available to: /);
    }
  });
});
