import type { MaterialId } from './ids.js';
import type { MaterialOrigin, MaterialPropertyId } from './materials.js';

/**
 * Deterministic material naming.
 *
 * Composites are produced by agents, but their names are not. A name is a pure function of what the
 * material measurably *is* — its dominant properties, its origin and its identity — so the same
 * material is called the same thing in every process, on every replay, forever. No PRNG, no model,
 * no agent-supplied text.
 *
 * This exists because agent-supplied labels compounded across generations into unreadable strings:
 * `clay-resin` begat `mx1a2b3c-fibre` begat `mxf9e8d7-mx4d5e6f`. Names are the spectator's only
 * handle on the world, so they are derived from physics rather than accepted as input.
 *
 * Names are decoration and are never matched on. Recipes are content-addressed by
 * {@link deriveRecipeKey}, which is what makes it safe to rewrite every label in the world.
 *
 * This module deliberately imports only *types* from `./materials.js`. `combineMaterials` calls
 * into here, so a value import would close a runtime cycle between the two modules.
 */

/**
 * Bumped when the word tables below change.
 *
 * Because labels are derived rather than authoritative, bumping this renames existing materials the
 * next time they are read. That is a display change only — no identity, recipe or event id moves.
 */
export const NAMING_VERSION = 2;

export interface DerivedName {
  /** Short display name, e.g. `Pliant Resinweave`. Bounded well under the 64-char record limit. */
  readonly label: string;
  /** One-line plain-language description of what the material is actually good for. */
  readonly subtitle: string;
}

/** The parts of a material that determine its name. A `MaterialDefinition` satisfies this. */
export interface NameableMaterial {
  readonly id: MaterialId;
  readonly origin: MaterialOrigin;
  /**
   * Per-mille property vector. Typed as plain numbers rather than `MaterialProperties` so the
   * persistence layer can re-derive a name from a decoded record without re-branding first.
   */
  readonly properties: Readonly<Record<MaterialPropertyId, number>>;
  readonly nutritionPerUnit: number;
}

/** A property at or above this reads as a genuine strength. */
const STRONG = 600;
/** A property at or above this earns the `Very` intensifier. */
const VERY_STRONG = 850;
/** A property at or below this is worth calling out as low. */
const LOW = 200;
/** Below this the material has no character worth naming after. */
const FEATURELESS = 100;
/** A second property must reach this before it earns the adjective slot. */
const SECONDARY = 150;
/** Hard bound on generated prose. */
const MAX_SUBTITLE_CHARS = 200;

/** Non-empty by construction, so a modulo index always has something to fall back to. */
type Words = readonly [string, ...string[]];

interface PropertyWords {
  /** Noun stem used when this property dominates, e.g. `resin` → `Resinweave`. */
  readonly stems: Words;
  /** Adjective used when this property is the runner-up, e.g. `pliant`. */
  readonly adjectives: Words;
  /** Adjective form for the subtitle, e.g. "Very *adhesive*". */
  readonly strong: string;
  /** Noun form for the subtitle, e.g. "Low *adhesion*". */
  readonly noun: string;
}

/**
 * Canonical property order, used to break ties so that two materials with identical property
 * vectors can never disagree about which property dominates.
 *
 * Pinned to `MATERIAL_PROPERTY_IDS` by test rather than by import, to keep this module free of a
 * runtime dependency on `materials.ts`.
 */
export const NAMING_PROPERTY_ORDER: readonly MaterialPropertyId[] = [
  'hardness',
  'flexibility',
  'adhesion',
  'conductivity',
  'toxicity',
  'photosensitivity',
  'porosity',
  'density',
];

const PROPERTY_WORDS: Record<MaterialPropertyId, PropertyWords> = {
  hardness: {
    stems: ['flint', 'stone', 'shell', 'anvil', 'granite', 'chitin', 'quartz', 'scale'],
    adjectives: [
      'hardened',
      'rigid',
      'unyielding',
      'armoured',
      'adamant',
      'tempered',
      'obdurate',
      'steeled',
    ],
    strong: 'hard',
    noun: 'hardness',
  },
  flexibility: {
    stems: ['willow', 'sinew', 'ribbon', 'coil', 'tendril', 'whip', 'reed', 'lash'],
    adjectives: [
      'pliant',
      'supple',
      'springy',
      'yielding',
      'lithe',
      'bending',
      'elastic',
      'limber',
    ],
    strong: 'flexible',
    noun: 'flexibility',
  },
  adhesion: {
    stems: ['resin', 'pitch', 'gum', 'bond', 'tar', 'sap', 'mastic', 'clasp'],
    adjectives: [
      'clinging',
      'tacky',
      'bonded',
      'gripping',
      'sticky',
      'adherent',
      'clutching',
      'fastened',
    ],
    strong: 'adhesive',
    noun: 'adhesion',
  },
  conductivity: {
    stems: ['spark', 'vein', 'filament', 'current', 'arc', 'circuit', 'wire', 'surge'],
    adjectives: [
      'charged',
      'conductive',
      'live',
      'humming',
      'galvanic',
      'crackling',
      'electric',
      'energised',
    ],
    strong: 'conductive',
    noun: 'conductivity',
  },
  toxicity: {
    stems: ['venom', 'bile', 'blight', 'canker', 'miasma', 'rot', 'plague', 'sting'],
    adjectives: [
      'acrid',
      'caustic',
      'noxious',
      'tainted',
      'virulent',
      'poisonous',
      'blighted',
      'corrosive',
    ],
    strong: 'toxic',
    noun: 'toxicity',
  },
  photosensitivity: {
    stems: ['glimmer', 'lumen', 'prism', 'dawn', 'gleam', 'halo', 'beacon', 'flare'],
    adjectives: [
      'luminous',
      'sunlit',
      'glinting',
      'radiant',
      'shining',
      'gleaming',
      'lucent',
      'dazzling',
    ],
    strong: 'light-sensitive',
    noun: 'light sensitivity',
  },
  porosity: {
    stems: ['sponge', 'honeycomb', 'foam', 'sieve', 'pumice', 'froth', 'cavern', 'lattice'],
    adjectives: ['open', 'airy', 'riddled', 'vented', 'perforated', 'hollow', 'spongy', 'cellular'],
    strong: 'porous',
    noun: 'porosity',
  },
  density: {
    stems: ['ballast', 'core', 'ingot', 'cairn', 'slab', 'mass', 'bullion', 'keel'],
    adjectives: [
      'leaden',
      'packed',
      'weighted',
      'solid',
      'heavy',
      'compacted',
      'ponderous',
      'massive',
    ],
    strong: 'dense',
    noun: 'density',
  },
};

/**
 * Noun suffix carrying the material's provenance, e.g. organic → `weave`.
 *
 * Deliberately disjoint from every stem in {@link PROPERTY_WORDS}, so a name can never read
 * `Stonestone`.
 */
const ORIGIN_SUFFIXES: Record<MaterialOrigin, Words> = {
  mineral: ['form', 'grit', 'bed', 'crust', 'shard', 'slag', 'seam', 'rock'],
  organic: ['weave', 'husk', 'pith', 'fibre', 'bark', 'rind', 'bloom', 'thatch'],
  fluid: ['brine', 'wash', 'flux', 'slick', 'tide', 'sluice', 'rill', 'seep'],
  composite: ['ply', 'mesh', 'alloy', 'matrix', 'weld', 'braid', 'amalgam', 'knit'],
};

/** Used when nothing about the material stands out. */
const FEATURELESS_ADJECTIVES: Words = [
  'dull',
  'inert',
  'plain',
  'muted',
  'drab',
  'blank',
  'listless',
  'nondescript',
];

/** FNV-1a, the same hash the world uses for content addressing. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Avalanche finaliser (Murmur3's `fmix32`).
 *
 * FNV-1a's low bits are weakly distributed: its final step is a multiply by an odd constant, so the
 * bottom bits of the result depend on very little of the input. Indexing a short word list with
 * `hash % length` therefore reads almost none of the hash and collapses the space of names —
 * measured at 23% distinct labels across 82 composites before this was added. Mixing the high bits
 * down first makes every bit of the index depend on the whole id.
 */
function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Choose one word deterministically from a list.
 *
 * The salt separates the slots, so the adjective, the stem and the suffix vary independently rather
 * than moving together and collapsing the space of possible names.
 */
function pick(words: Words, id: string, salt: string): string {
  return words[mix32(hash32(`${salt}:${id}`)) % words.length] ?? words[0];
}

function capitalise(word: string): string {
  return word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1);
}

/** `a`, `a and b`, `a, b and c`. */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

/** Properties strongest first, ties broken by canonical order so the result is total. */
function ranked(
  properties: Readonly<Record<MaterialPropertyId, number>>,
): readonly MaterialPropertyId[] {
  return [...NAMING_PROPERTY_ORDER].sort((a, b) => {
    const byValue = properties[b] - properties[a];
    if (byValue !== 0) return byValue;
    return NAMING_PROPERTY_ORDER.indexOf(a) - NAMING_PROPERTY_ORDER.indexOf(b);
  });
}

/** Describes how purely the dominant property expresses, when no runner-up qualifies. */
function intensity(value: number): string {
  if (value >= VERY_STRONG) return 'pure';
  if (value >= STRONG) return 'rich';
  return 'faint';
}

/**
 * Derive a stable, human-readable name and description for a material.
 *
 * The noun encodes what the material is mostly made of doing — its dominant property — plus its
 * origin. The adjective encodes its runner-up property, so the name carries two real facts rather
 * than being flavour text.
 */
export function deriveMaterialName(material: NameableMaterial): DerivedName {
  const { properties, origin, nutritionPerUnit } = material;
  const order = ranked(properties);
  const [dominant = 'hardness', secondary] = order;
  const dominantValue = properties[dominant];
  const suffix = pick(ORIGIN_SUFFIXES[origin], material.id, 'suffix');

  let label: string;
  if (dominantValue < FEATURELESS) {
    label = `${capitalise(pick(FEATURELESS_ADJECTIVES, material.id, 'adjective'))} ${capitalise(suffix)}`;
  } else {
    const stem = pick(PROPERTY_WORDS[dominant].stems, material.id, 'stem');
    const secondaryValue = secondary === undefined ? 0 : properties[secondary];
    const adjective =
      secondary !== undefined && secondaryValue >= SECONDARY
        ? pick(PROPERTY_WORDS[secondary].adjectives, material.id, 'adjective')
        : intensity(dominantValue);
    label = `${capitalise(adjective)} ${capitalise(stem + suffix)}`;
  }

  return { label, subtitle: describe(order, properties, origin, nutritionPerUnit) };
}

/**
 * Plain-language description built from the actual thresholds, not from vibes.
 *
 * A spectator asking "what is this good for" gets an answer they can check against the property
 * bars, because both come from the same numbers.
 */
function describe(
  order: readonly MaterialPropertyId[],
  properties: Readonly<Record<MaterialPropertyId, number>>,
  origin: MaterialOrigin,
  nutritionPerUnit: number,
): string {
  const strengths = order.filter((id) => properties[id] >= STRONG).slice(0, 3);
  const top = order[0];
  const intensifier = top !== undefined && properties[top] >= VERY_STRONG ? 'very ' : '';

  const lead =
    strengths.length > 0
      ? `${intensifier}${joinWords(strengths.map((id) => PROPERTY_WORDS[id].strong))} ${origin} material.`
      : `unremarkable ${origin} material.`;

  // Kept in the same descending-by-value sweep as the strengths, so the whole sentence reads as
  // one continuous descent from what the material is best at to what it is worst at.
  const lows = order.filter((id) => properties[id] <= LOW).slice(-2);
  const lowClause =
    lows.length > 0 ? `Low ${joinWords(lows.map((id) => PROPERTY_WORDS[id].noun))}.` : '';

  const edibility = nutritionPerUnit > 0 ? `Edible (${nutritionPerUnit}eu per mu).` : 'Not edible.';

  return [capitalise(lead), lowClause, edibility]
    .filter((part) => part.length > 0)
    .join(' ')
    .slice(0, MAX_SUBTITLE_CHARS);
}
