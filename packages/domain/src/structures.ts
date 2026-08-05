import type { AgentId, LineageId, MaterialId, OrganismId, RegionId, StructureId } from './ids.js';
import {
  type MaterialComponent,
  type MaterialDefinition,
  type MaterialProperties,
  blendProperties,
  totalVolume,
} from './materials.js';
import type { Position } from './geometry.js';
import { type Mu, type PerMille, type TickIndex, clampPerMille, toInt } from './units.js';

/**
 * Persistent things agents build.
 *
 * A structure records what it is made of, how it was assembled, who made it, where it is
 * and what condition it is in. What it *does* is never stored as an agent's claim: it is
 * recomputed by {@link deriveStructureFunctions} from measured material properties.
 */
export const STRUCTURE_PATTERNS = [
  'lattice',
  'shell',
  'mesh',
  'conduit',
  'vessel',
  'anchor',
  'beacon',
  'snare',
] as const;

export type StructurePattern = (typeof STRUCTURE_PATTERNS)[number];

export const STRUCTURE_FUNCTIONS = [
  'shelter',
  'barrier',
  'snare',
  'conduit',
  'beacon',
  'reservoir',
  'filter',
  'nursery',
  'toxinWard',
  'anchor',
] as const;

export type StructureFunctionId = (typeof STRUCTURE_FUNCTIONS)[number];

export interface DerivedFunction {
  readonly id: StructureFunctionId;
  /** Strength of the function in per-mille. Zero-magnitude functions are never recorded. */
  readonly magnitude: PerMille;
}

export interface StructureUsage {
  readonly tick: TickIndex;
  readonly organismId: OrganismId;
  readonly lineageId: LineageId;
  readonly kind: 'shelter' | 'inspect' | 'harvest' | 'repair' | 'damage' | 'repurpose';
}

export interface Structure {
  readonly id: StructureId;
  readonly regionId: RegionId;
  readonly position: Position;
  readonly pattern: StructurePattern;
  readonly components: readonly MaterialComponent[];
  /** Recomputed from `components` and `pattern`; never supplied by a model. */
  readonly functions: readonly DerivedFunction[];
  readonly properties: MaterialProperties;
  readonly volume: Mu;
  readonly integrity: PerMille;
  readonly createdByAgentId: AgentId;
  readonly createdByLineageId: LineageId;
  readonly createdByOrganismId: OrganismId;
  readonly createdAtTick: TickIndex;
  readonly lastChangedAtTick: TickIndex;
  /** Bounded ring buffer. Older entries are dropped rather than growing the entity. */
  readonly usage: readonly StructureUsage[];
  readonly label: string;
}

/** Maximum retained usage records per structure. Keeps the stored entity bounded. */
export const MAX_STRUCTURE_USAGE_RECORDS = 12;

/** Minimum material volume before a pile of matter counts as a structure at all. */
export const MIN_STRUCTURE_VOLUME: Mu = 40;

interface FunctionRule {
  readonly id: StructureFunctionId;
  readonly patterns: readonly StructurePattern[];
  /** Returns raw magnitude before clamping, or `0` when the requirements are unmet. */
  readonly evaluate: (p: MaterialProperties, volume: Mu) => number;
}

/**
 * Derivation rules.
 *
 * Each rule states a physical requirement. If the blended properties do not meet it, the
 * function simply does not exist, no matter what the builder intended.
 */
const FUNCTION_RULES: readonly FunctionRule[] = [
  {
    id: 'shelter',
    patterns: ['shell', 'lattice'],
    evaluate: (p, v) =>
      p.hardness >= 420 && v >= 120 ? Math.trunc((p.hardness * 2) / 3) + Math.min(200, v) : 0,
  },
  {
    id: 'barrier',
    patterns: ['lattice', 'shell', 'anchor'],
    evaluate: (p, v) =>
      p.hardness >= 600 && v >= 200 ? p.hardness - 200 + Math.min(150, v / 4) : 0,
  },
  {
    id: 'snare',
    patterns: ['snare', 'mesh'],
    evaluate: (p) => (p.adhesion >= 600 ? p.adhesion - 300 + Math.trunc(p.flexibility / 4) : 0),
  },
  {
    id: 'conduit',
    patterns: ['conduit', 'lattice'],
    evaluate: (p) => (p.conductivity >= 500 ? p.conductivity - 250 : 0),
  },
  {
    id: 'beacon',
    patterns: ['beacon', 'lattice', 'shell'],
    evaluate: (p) => (p.photosensitivity >= 500 ? p.photosensitivity - 200 : 0),
  },
  {
    id: 'reservoir',
    patterns: ['vessel', 'shell'],
    evaluate: (p, v) =>
      p.porosity <= 250 && v >= 100 ? 600 - p.porosity + Math.min(200, v / 3) : 0,
  },
  {
    id: 'filter',
    patterns: ['mesh', 'lattice'],
    evaluate: (p) =>
      p.porosity >= 350 && p.porosity <= 750 ? 400 + (750 - Math.abs(550 - p.porosity)) / 2 : 0,
  },
  {
    id: 'nursery',
    patterns: ['shell', 'vessel'],
    evaluate: (p, v) =>
      p.hardness >= 300 && p.flexibility >= 300 && v >= 150
        ? Math.trunc((p.hardness + p.flexibility) / 3)
        : 0,
  },
  {
    id: 'toxinWard',
    patterns: [...STRUCTURE_PATTERNS],
    evaluate: (p) => (p.toxicity >= 500 ? p.toxicity - 250 : 0),
  },
  {
    id: 'anchor',
    patterns: ['anchor', 'lattice'],
    evaluate: (p) =>
      p.adhesion >= 400 && p.density >= 500 ? Math.trunc((p.adhesion + p.density) / 4) : 0,
  },
];

/**
 * Derive what a construction can do.
 *
 * Pure function of `(components, pattern)`. This is the guard that stops a model from
 * asserting that a handful of sand is a working reservoir.
 */
export function deriveStructureFunctions(
  components: readonly MaterialComponent[],
  pattern: StructurePattern,
  catalogue: ReadonlyMap<MaterialId, MaterialDefinition>,
): readonly DerivedFunction[] {
  const volume = totalVolume(components);
  if (volume < MIN_STRUCTURE_VOLUME) return [];
  const properties = blendProperties(components, catalogue);
  const out: DerivedFunction[] = [];
  for (const rule of FUNCTION_RULES) {
    if (!rule.patterns.includes(pattern)) continue;
    const raw = rule.evaluate(properties, volume);
    const magnitude = clampPerMille(Math.trunc(raw));
    if (magnitude > 0) out.push({ id: rule.id, magnitude });
  }
  // Stable ordering keeps event payloads and snapshots byte-identical on replay.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Starting integrity of a fresh construction, derived from its own material properties. */
export function initialIntegrity(properties: MaterialProperties): PerMille {
  return clampPerMille(
    400 + Math.trunc(properties.hardness / 3) + Math.trunc(properties.flexibility / 5),
  );
}

/**
 * Integrity lost per tick.
 *
 * Porous, soft constructions crumble; dense hard ones persist. Always at least 1 so that
 * abandoned structures eventually disappear and storage stays bounded.
 */
export function decayPerTick(properties: MaterialProperties): number {
  const resistance = Math.trunc((properties.hardness + (1000 - properties.porosity)) / 2);
  return Math.max(1, 6 - Math.trunc(resistance / 250));
}

/** Effective magnitude of a function after integrity damage is taken into account. */
export function functionMagnitude(structure: Structure, id: StructureFunctionId): PerMille {
  const found = structure.functions.find((f) => f.id === id);
  if (!found) return 0;
  return clampPerMille(Math.trunc((found.magnitude * structure.integrity) / 1000));
}

/** Append a usage record, dropping the oldest entry once the bound is reached. */
export function recordUsage(
  usage: readonly StructureUsage[],
  entry: StructureUsage,
): readonly StructureUsage[] {
  const next = [...usage, entry];
  return next.length <= MAX_STRUCTURE_USAGE_RECORDS
    ? next
    : next.slice(next.length - MAX_STRUCTURE_USAGE_RECORDS);
}

/** Human-readable label generated from the derived functions, never from a model claim. */
export function describeStructure(
  pattern: StructurePattern,
  functions: readonly DerivedFunction[],
): string {
  if (functions.length === 0) return `inert ${pattern}`;
  const strongest = functions.reduce((best, f) => (f.magnitude > best.magnitude ? f : best));
  return `${strongest.id} ${pattern}`;
}

/** Total material volume a structure holds, in `mu`. */
export function structureVolume(structure: Structure): Mu {
  return Math.max(0, toInt(structure.volume));
}
