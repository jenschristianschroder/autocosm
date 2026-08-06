import { REJECTION_REASONS, type RejectionReason } from './actions.js';
import { DEATH_CAUSES, type DeathCause, SIGNAL_CHANNELS, type SignalChannel } from './entities.js';
import { MATERIAL_PROPERTY_IDS, type MaterialPropertyId } from './materials.js';
import { DECISION_REASONS, type DecisionReason } from './observation.js';
import {
  STRUCTURE_FUNCTION_RULES,
  STRUCTURE_PATTERNS,
  type StructureFunctionId,
  type StructurePattern,
} from './structures.js';
import { TRAIT_CATALOGUE, TRAIT_IDS } from './traits.js';

/**
 * The world, explained in its own terms.
 *
 * A spectator can see that a construction has the `reservoir` function at 640‰ but has no way to
 * learn what that means or why it earned it. This module answers those questions from the same
 * constants the simulation runs on, so the explanation cannot describe a world other than the one
 * that exists.
 *
 * Everything here is static and pure: no world state, no model, no cost. It is safe to cache for a
 * long time and is the deterministic floor beneath any later generated prose.
 */

/**
 * Bumped whenever an entry's meaning changes, so a client can discard a cached copy.
 *
 * Adding a new entry does not require a bump — clients treat an unknown id as "no entry yet" and
 * the completeness test catches the omission at build time instead.
 */
export const GLOSSARY_VERSION = 1;

export interface GlossaryEntry {
  readonly id: string;
  readonly label: string;
  /** One sentence, plain language, no identifiers. */
  readonly summary: string;
  /** Optional second line: the concrete rule, threshold or trade-off behind the summary. */
  readonly detail?: string;
}

export interface Glossary {
  readonly version: number;
  readonly structureFunctions: readonly GlossaryEntry[];
  readonly structurePatterns: readonly GlossaryEntry[];
  readonly materialProperties: readonly GlossaryEntry[];
  readonly traits: readonly GlossaryEntry[];
  readonly signalChannels: readonly GlossaryEntry[];
  readonly deathCauses: readonly GlossaryEntry[];
  readonly rejectionReasons: readonly GlossaryEntry[];
  readonly decisionReasons: readonly GlossaryEntry[];
}

/** Turns a camelCase identifier into a readable label, so no label is ever hand-duplicated. */
function humanise(id: string): string {
  const spaced = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const STRUCTURE_PATTERN_TEXT: Readonly<Record<StructurePattern, GlossaryEntry>> = Object.freeze({
  lattice: {
    id: 'lattice',
    label: 'Lattice',
    summary: 'An open framework of struts — the most versatile assembly.',
    detail:
      'Can yield shelter, barrier, conduit, beacon, filter or anchor, given the right matter.',
  },
  shell: {
    id: 'shell',
    label: 'Shell',
    summary: 'A closed enclosure around a space.',
    detail: 'Suited to shelter, barrier, beacon, reservoir and nursery.',
  },
  mesh: {
    id: 'mesh',
    label: 'Mesh',
    summary: 'A woven surface that lets some things through and stops others.',
    detail: 'Suited to snare and filter.',
  },
  conduit: {
    id: 'conduit',
    label: 'Conduit',
    summary: 'A channel built to carry something along its length.',
    detail: 'Yields the conduit function when the material conducts well enough.',
  },
  vessel: {
    id: 'vessel',
    label: 'Vessel',
    summary: 'A container built to hold contents without losing them.',
    detail: 'Suited to reservoir and nursery.',
  },
  anchor: {
    id: 'anchor',
    label: 'Anchor',
    summary: 'A mass fixed to the terrain.',
    detail: 'Suited to anchor and barrier.',
  },
  beacon: {
    id: 'beacon',
    label: 'Beacon',
    summary: 'A structure raised to be seen from a distance.',
    detail: 'Yields the beacon function when the material is photosensitive enough.',
  },
  snare: {
    id: 'snare',
    label: 'Snare',
    summary: 'A trap laid to catch what moves past it.',
    detail: 'Yields the snare function when the material is adhesive enough.',
  },
});

const MATERIAL_PROPERTY_TEXT: Readonly<Record<MaterialPropertyId, GlossaryEntry>> = Object.freeze({
  hardness: {
    id: 'hardness',
    label: 'Hardness',
    summary: 'Resistance to being crushed or broken.',
    detail: 'Drives shelter and barrier, raises starting integrity, and slows decay.',
  },
  flexibility: {
    id: 'flexibility',
    label: 'Flexibility',
    summary: 'How far the material bends before it fails.',
    detail: 'Adds to nursery and snare, and raises starting integrity.',
  },
  adhesion: {
    id: 'adhesion',
    label: 'Adhesion',
    summary: 'How strongly the material sticks to what touches it.',
    detail: 'Required for snare, and combines with density for anchor.',
  },
  conductivity: {
    id: 'conductivity',
    label: 'Conductivity',
    summary: 'How readily energy travels through the material.',
    detail: 'The sole requirement for the conduit function.',
  },
  toxicity: {
    id: 'toxicity',
    label: 'Toxicity',
    summary: 'How poisonous the material is to an organism that touches or eats it.',
    detail: 'Enables the toxin ward, but harms anything feeding on it without toxin resistance.',
  },
  photosensitivity: {
    id: 'photosensitivity',
    label: 'Photosensitivity',
    summary: 'How strongly the material responds to light.',
    detail: 'The sole requirement for the beacon function.',
  },
  porosity: {
    id: 'porosity',
    label: 'Porosity',
    summary: 'How much of the material is empty space.',
    detail: 'Low porosity holds contents (reservoir); middling porosity sieves them (filter).',
  },
  density: {
    id: 'density',
    label: 'Density',
    summary: 'Mass packed into a given volume.',
    detail: 'Combines with adhesion for anchor. Heavy matter is costly to carry.',
  },
});

const SIGNAL_CHANNEL_TEXT: Readonly<Record<SignalChannel, GlossaryEntry>> = Object.freeze({
  alarm: {
    id: 'alarm',
    label: 'Alarm',
    summary: 'Warns nearby organisms of a threat.',
  },
  food: {
    id: 'food',
    label: 'Food',
    summary: 'Advertises a resource worth travelling to.',
  },
  mate: {
    id: 'mate',
    label: 'Mate',
    summary: 'Announces readiness to reproduce.',
  },
  teach: {
    id: 'teach',
    label: 'Teach',
    summary: 'Offers a known recipe to whoever can hear it.',
    detail: 'The only way knowledge crosses between organisms; range depends on signal strength.',
  },
  claim: {
    id: 'claim',
    label: 'Claim',
    summary: 'Asserts ownership of a place or a construction.',
  },
});

const DEATH_CAUSE_TEXT: Readonly<Record<DeathCause, GlossaryEntry>> = Object.freeze({
  starvation: {
    id: 'starvation',
    label: 'Starvation',
    summary: 'Ran out of energy.',
    detail: 'The dominant cause of death: upkeep is paid every tick whether or not food is found.',
  },
  age: {
    id: 'age',
    label: 'Old age',
    summary: 'Reached the maximum lifespan its genome allows.',
    detail: 'Longevity extends it, at the cost of higher upkeep and later maturity.',
  },
  predation: {
    id: 'predation',
    label: 'Predation',
    summary: 'Killed by another organism.',
  },
  environment: {
    id: 'environment',
    label: 'Environment',
    summary: 'Killed by weather or terrain it could not tolerate.',
    detail: 'Thermal tolerance blunts heat waves and cold snaps.',
  },
  toxicity: {
    id: 'toxicity',
    label: 'Toxicity',
    summary: 'Poisoned by material it consumed or touched.',
    detail: 'Toxin resistance allows feeding on matter that would otherwise be lethal.',
  },
});

const REJECTION_REASON_TEXT: Readonly<Record<RejectionReason, GlossaryEntry>> = Object.freeze({
  unknownTarget: {
    id: 'unknownTarget',
    label: 'Unknown target',
    summary: 'The thing it tried to act on does not exist.',
  },
  outOfRange: {
    id: 'outOfRange',
    label: 'Out of range',
    summary: 'The target was too far away to reach.',
  },
  notVisible: {
    id: 'notVisible',
    label: 'Not visible',
    summary: 'The target exists but this organism cannot perceive it.',
    detail: 'Observations are local: an agent may only act on what its senses actually reached.',
  },
  insufficientEnergy: {
    id: 'insufficientEnergy',
    label: 'Not enough energy',
    summary: 'The action costs more energy than the organism had.',
  },
  insufficientMaterial: {
    id: 'insufficientMaterial',
    label: 'Not enough material',
    summary: 'The organism was not carrying enough of what the action consumes.',
  },
  capabilityNotEvolved: {
    id: 'capabilityNotEvolved',
    label: 'Capability not evolved',
    summary: 'The genome does not yet support this behaviour.',
    detail: 'Actions unlock through evolved traits, never by being requested.',
  },
  onCooldown: {
    id: 'onCooldown',
    label: 'On cooldown',
    summary: 'The action was taken too recently to repeat.',
  },
  notMature: {
    id: 'notMature',
    label: 'Not mature',
    summary: 'The organism is too young for this action.',
  },
  targetDead: {
    id: 'targetDead',
    label: 'Target dead',
    summary: 'The target died before the action resolved.',
  },
  selfTarget: {
    id: 'selfTarget',
    label: 'Targeted itself',
    summary: 'The action requires a target other than the actor.',
  },
  staleWorldVersion: {
    id: 'staleWorldVersion',
    label: 'Stale view',
    summary: 'The world moved on between observing and acting.',
    detail: 'Thinking takes time; a decision made against an old world is discarded, not applied.',
  },
  inventoryFull: {
    id: 'inventoryFull',
    label: 'Inventory full',
    summary: 'The organism cannot carry any more.',
  },
  notOwner: {
    id: 'notOwner',
    label: 'Not the owner',
    summary: 'Only whoever made or claimed it may act on it this way.',
  },
  malformed: {
    id: 'malformed',
    label: 'Malformed',
    summary: 'The proposed action did not parse into anything the world accepts.',
    detail: 'Model output is untrusted input: it is validated before it is ever applied.',
  },
  rateLimited: {
    id: 'rateLimited',
    label: 'Rate limited',
    summary: 'Too many actions were attempted at once.',
  },
  actionUnavailable: {
    id: 'actionUnavailable',
    label: 'Action unavailable',
    summary: 'The action cannot be taken in this situation at all.',
  },
});

const DECISION_REASON_TEXT: Readonly<Record<DecisionReason, GlossaryEntry>> = Object.freeze({
  novelDiscovery: {
    id: 'novelDiscovery',
    label: 'Novel discovery',
    summary: 'Something never seen before appeared within reach.',
  },
  newCreatorGoal: {
    id: 'newCreatorGoal',
    label: 'New creator goal',
    summary: 'A spectator submitted a broad motivation for this lineage to weigh.',
    detail: 'A goal is motivational only. It never moves an organism or changes the world.',
  },
  reproductionStrategy: {
    id: 'reproductionStrategy',
    label: 'Reproduction strategy',
    summary: 'The lineage has enough surplus to decide how to invest in offspring.',
  },
  constructionOpportunity: {
    id: 'constructionOpportunity',
    label: 'Construction opportunity',
    summary: 'The materials on hand could be assembled into something useful.',
  },
  socialConflict: {
    id: 'socialConflict',
    label: 'Social conflict',
    summary: 'Another lineage is competing for the same place or resource.',
  },
  cooperationOpportunity: {
    id: 'cooperationOpportunity',
    label: 'Cooperation opportunity',
    summary: 'Another organism is close enough to share with or teach.',
  },
  environmentalShift: {
    id: 'environmentalShift',
    label: 'Environmental shift',
    summary: 'The weather or the terrain changed enough to matter.',
  },
  starvationRisk: {
    id: 'starvationRisk',
    label: 'Starvation risk',
    summary: 'Energy is falling fast enough that the usual routine will not save it.',
  },
});

/**
 * Build the whole glossary.
 *
 * Iterating the canonical id arrays rather than the text records is deliberate: it fixes the
 * ordering to the domain's own, and it means a missing entry is a type error at compile time
 * rather than a silently short list at runtime.
 */
export function buildGlossary(): Glossary {
  return {
    version: GLOSSARY_VERSION,
    structureFunctions: STRUCTURE_FUNCTION_RULES.map((rule): GlossaryEntry => ({
      id: rule.id,
      label: humanise(rule.id),
      summary: rule.summary,
      detail: `${rule.requirement} Available to: ${rule.patterns.join(', ')}.`,
    })),
    structurePatterns: STRUCTURE_PATTERNS.map((id) => STRUCTURE_PATTERN_TEXT[id]),
    materialProperties: MATERIAL_PROPERTY_IDS.map((id) => MATERIAL_PROPERTY_TEXT[id]),
    traits: TRAIT_IDS.map((id): GlossaryEntry => {
      const trait = TRAIT_CATALOGUE[id];
      return {
        id,
        label: trait.label,
        summary: trait.benefit,
        detail: `Cost: ${trait.cost}`,
      };
    }),
    signalChannels: SIGNAL_CHANNELS.map((id) => SIGNAL_CHANNEL_TEXT[id]),
    deathCauses: DEATH_CAUSES.map((id) => DEATH_CAUSE_TEXT[id]),
    rejectionReasons: REJECTION_REASONS.map((id) => REJECTION_REASON_TEXT[id]),
    decisionReasons: DECISION_REASONS.map((id) => DECISION_REASON_TEXT[id]),
  };
}

/** Narrow helper for call sites that want one entry rather than the whole document. */
const FUNCTION_ENTRIES: ReadonlyMap<string, GlossaryEntry> = new Map(
  buildGlossary().structureFunctions.map((entry) => [entry.id, entry]),
);

export function structureFunctionEntry(id: StructureFunctionId): GlossaryEntry | undefined {
  return FUNCTION_ENTRIES.get(id);
}
