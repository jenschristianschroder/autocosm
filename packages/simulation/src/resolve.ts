import {
  MAX_INVENTORY_ENTRIES,
  MAX_KNOWN_MATERIALS,
  MAX_KNOWN_RECIPES,
  MAX_KNOWN_STRUCTURES,
  MAX_MEMORY_NOTE_LENGTH,
  MAX_STRUCTURE_USAGE_RECORDS,
  MAX_TRAIT_EMPHASIS,
  MIN_STRUCTURE_VOLUME,
  PER_MILLE,
  SIGNAL_LIFETIME_TICKS,
  asMaterialId,
  asMemoryId,
  asOrganismId,
  asResourceNodeId,
  asStructureId,
  blendProperties,
  clampPerMille,
  combineMaterials,
  derivePhenotype,
  deriveRecipeKey,
  deriveStructureFunctions,
  describeStructure,
  distance,
  initialIntegrity,
  makePosition,
  normaliseComponents,
  recordUsage,
  regionIdOf,
  repairYield,
  scaleByPerMille,
  stepToward,
  totalVolume,
  type AgentAction,
  type DerivedFunction,
  type InventoryEntry,
  type LineageId,
  type MaterialComponent,
  type MaterialId,
  type Organism,
  type Phenotype,
  type RejectionReason,
  type Structure,
} from '@autocosm/domain';
import { meetsRequirement } from './capabilities.js';
import { structureVisibilityRadiusCu } from './observe.js';
import type { SimulationConfig } from './config.js';
import type { WorldDraft } from './state.js';
import type { EventSink } from './events.js';

/**
 * Authoritative action resolution.
 *
 * Every proposal — heuristic or model-generated — passes through {@link resolveAction}.
 * Validation is re-done here from scratch: shape parsing upstream proves nothing about
 * range, ownership, cost, cooldown, evolved capability or target existence.
 */
export interface ResolutionContext {
  readonly draft: WorldDraft;
  readonly config: SimulationConfig;
  readonly events: EventSink;
  /** Records energy entering and leaving the world so conservation can be asserted. */
  readonly ledger: EnergyLedger;
}

/**
 * Energy bookkeeping.
 *
 * Internal transfers (sharing, predation, reproduction endowment) must not touch these
 * counters. Only genuinely new energy (photosynthesis, grazing) and genuinely destroyed
 * energy (upkeep, decay, waste) are recorded, which lets a test assert that
 * `Σafter === Σbefore + inflow − outflow` exactly.
 */
export class EnergyLedger {
  #inflow = 0;
  #outflow = 0;

  credit(amount: number): void {
    if (amount > 0) this.#inflow += Math.trunc(amount);
  }

  debit(amount: number): void {
    if (amount > 0) this.#outflow += Math.trunc(amount);
  }

  get inflow(): number {
    return this.#inflow;
  }

  get outflow(): number {
    return this.#outflow;
  }
}

export interface Resolution {
  readonly accepted: boolean;
  readonly reason?: RejectionReason;
}

export const ACCEPTED: Resolution = Object.freeze({ accepted: true });
const reject = (reason: RejectionReason): Resolution => ({ accepted: false, reason });

/**
 * Add energy to an organism, honouring its storage ceiling.
 *
 * Returns the amount actually absorbed. Energy above `maxEnergy` is *not* stored and is
 * never credited to the ledger, so the invariant
 * `Σenergy_after === Σenergy_before + inflow − outflow` holds exactly.
 */
export function absorbEnergy(current: number, amount: number, maxEnergy: number): number {
  if (amount <= 0) return 0;
  return Math.max(0, Math.min(maxEnergy, current + amount) - current);
}

export function resolveAction(
  ctx: ResolutionContext,
  organismId: Organism['id'],
  action: AgentAction,
): Resolution {
  const organism = ctx.draft.organisms.get(organismId);
  if (!organism || !organism.alive) return reject('targetDead');
  const phenotype = derivePhenotype(organism.genotype);
  const mature = organism.ageTicks >= phenotype.maturityAgeTicks;

  // Capability gate. Re-checked here so a model that ignores `availableActions` still fails.
  if (!meetsRequirement(action.type, phenotype, mature)) {
    return reject(action.type === 'reproduce' && !mature ? 'notMature' : 'capabilityNotEvolved');
  }

  switch (action.type) {
    case 'move':
      return applyMove(ctx, organism, phenotype, action.target);
    case 'consume':
      return applyConsume(ctx, organism, phenotype, action);
    case 'attack':
      return applyAttack(ctx, organism, phenotype, action.targetOrganismId);
    case 'signal':
      return applySignal(ctx, organism, phenotype, action);
    case 'attach':
      return applyAttach(ctx, organism, phenotype, action.structureId);
    case 'share':
      return applyShare(ctx, organism, action);
    case 'reproduce':
      return reject('actionUnavailable');
    case 'expressTrait':
      return applyExpressTrait(ctx, organism, action.traitId);
    case 'collect':
      return applyCollect(ctx, organism, phenotype, action);
    case 'combine':
      return applyCombine(ctx, organism, action);
    case 'build':
      return applyBuild(ctx, organism, action);
    case 'inspect':
      return applyInspect(ctx, organism, phenotype, action);
    case 'repurpose':
      return applyRepurpose(ctx, organism, phenotype, action);
    case 'repair':
      return applyRepair(ctx, organism, action);
    case 'rest':
      return ACCEPTED;
    default:
      return reject('malformed');
  }
}

/* -------------------------------------------------------------------------- */
/* Movement                                                                    */
/* -------------------------------------------------------------------------- */

function applyMove(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  target: { readonly x: number; readonly z: number },
): Resolution {
  if (phenotype.speedCuPerTick <= 20 && phenotype.moveCostPer100Cu > organism.energy) {
    return reject('insufficientEnergy');
  }
  const desired = makePosition(target.x, target.z);
  const next = stepToward(organism.position, desired, phenotype.speedCuPerTick);
  const travelled = distance(organism.position, next);
  if (travelled === 0) return ACCEPTED;
  const cost = Math.max(1, Math.trunc((travelled * phenotype.moveCostPer100Cu) / 100));
  if (organism.energy < cost) return reject('insufficientEnergy');

  const nextRegion = regionIdOf(next);
  ctx.ledger.debit(cost);
  // Moving detaches from any structure: `attachedStructureId` is removed rather than set to
  // undefined, because `exactOptionalPropertyTypes` distinguishes the two.
  const { attachedStructureId: _detached, ...rest } = organism;
  void _detached;
  ctx.draft.organisms.set(organism.id, {
    ...rest,
    position: next,
    regionId: nextRegion,
    energy: organism.energy - cost,
  });
  if (nextRegion !== organism.regionId) {
    ctx.events.emit('organismMigrated', organism.regionId, {
      summary: `${organism.id} moved to ${nextRegion}`,
      organismId: organism.id,
      agentId: organism.agentId,
      lineageId: organism.lineageId,
      payload: { fromRegionId: organism.regionId, toRegionId: nextRegion },
    });
  }
  return ACCEPTED;
}

/* -------------------------------------------------------------------------- */
/* Feeding                                                                     */
/* -------------------------------------------------------------------------- */

function applyConsume(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  action: Extract<AgentAction, { type: 'consume' }>,
): Resolution {
  if (action.targetKind === 'biomass') {
    const region = ctx.draft.regions.get(organism.regionId);
    if (!region) return reject('unknownTarget');
    const appetite = Math.max(
      1,
      Math.trunc(phenotype.mass / 25) + scaleByPerMille(24, organism.genotype.metabolicRate),
    );
    const taken = Math.min(region.biomass, appetite);
    if (taken <= 0) return reject('unknownTarget');
    const gained = taken * ctx.config.energyPerBiomassUnit;
    const absorbed = absorbEnergy(organism.energy, gained, phenotype.maxEnergy);
    ctx.draft.regions.set(region.id, { ...region, biomass: region.biomass - taken });
    // Grazing converts stored regional biomass into organism energy: net world inflow.
    ctx.ledger.credit(absorbed);
    ctx.draft.organisms.set(organism.id, {
      ...organism,
      energy: organism.energy + absorbed,
    });
    ctx.events.emit('organismFed', organism.regionId, {
      summary: `${organism.id} grazed ${taken}mu of biomass`,
      organismId: organism.id,
      agentId: organism.agentId,
      lineageId: organism.lineageId,
      payload: { energyGained: absorbed },
    });
    return ACCEPTED;
  }

  if (action.targetKind === 'resourceNode') {
    if (action.targetId === undefined) return reject('unknownTarget');
    const node = ctx.draft.resources.get(asResourceNode(action.targetId));
    if (!node || node.quantity <= 0) return reject('unknownTarget');
    if (distance(organism.position, node.position) > ctx.config.interactionRadiusCu) {
      return reject('outOfRange');
    }
    const definition = ctx.draft.materials.get(node.materialId);
    if (!definition || definition.nutritionPerUnit <= 0) return reject('actionUnavailable');
    const appetite = Math.max(
      1,
      Math.trunc(phenotype.mass / 25) + scaleByPerMille(24, organism.genotype.metabolicRate),
    );
    const taken = Math.min(node.quantity, appetite);
    const toxicity = definition.properties.toxicity;
    const resistance = organism.genotype.toxinResistance;
    const gained = taken * definition.nutritionPerUnit;
    const harm =
      toxicity > resistance ? Math.max(1, Math.trunc(((toxicity - resistance) * taken) / 200)) : 0;

    ctx.draft.resources.set(node.id, { ...node, quantity: node.quantity - taken });
    const absorbed = absorbEnergy(organism.energy, gained, phenotype.maxEnergy);
    ctx.ledger.credit(absorbed);
    const nextHealth = Math.max(0, organism.health - harm);
    const survives = nextHealth > 0;
    ctx.draft.organisms.set(organism.id, {
      ...organism,
      energy: organism.energy + absorbed,
      health: nextHealth,
      alive: survives,
      ...(survives ? {} : { diedAtTick: ctx.draft.world.tick, causeOfDeath: 'toxicity' as const }),
    });
    learnMaterial(ctx, organism.agentId, node.materialId);
    ctx.events.emit('organismFed', organism.regionId, {
      summary: `${organism.id} fed on ${definition.label}`,
      organismId: organism.id,
      agentId: organism.agentId,
      lineageId: organism.lineageId,
      payload: { materialId: node.materialId, energyGained: absorbed },
    });
    return ACCEPTED;
  }

  return reject('actionUnavailable');
}

/* -------------------------------------------------------------------------- */
/* Conflict and cooperation                                                    */
/* -------------------------------------------------------------------------- */

function applyAttack(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  targetId: string,
): Resolution {
  const target = ctx.draft.organisms.get(asOrganism(targetId));
  if (!target) return reject('unknownTarget');
  if (target.id === organism.id) return reject('selfTarget');
  if (!target.alive) return reject('targetDead');
  if (distance(organism.position, target.position) > ctx.config.interactionRadiusCu) {
    return reject('outOfRange');
  }
  const cost = Math.max(1, Math.trunc(phenotype.attackPower / 3));
  if (organism.energy < cost) return reject('insufficientEnergy');

  const targetPhenotype = derivePhenotype(target.genotype);
  const damage = Math.max(0, phenotype.attackPower - targetPhenotype.defence);
  const nextHealth = Math.max(0, target.health - damage);
  const lethal = nextHealth === 0;

  ctx.ledger.debit(cost);
  let attackerEnergy = organism.energy - cost;
  if (lethal) {
    // Predation transfers energy between organisms: a pure internal transfer. Whatever the
    // attacker cannot store stays in the corpse and is accounted for by the death sweep.
    const offered = scaleByPerMille(target.energy, ctx.config.predationEfficiency);
    const absorbed = absorbEnergy(attackerEnergy, offered, phenotype.maxEnergy);
    attackerEnergy += absorbed;
    ctx.draft.organisms.set(target.id, {
      ...target,
      health: 0,
      energy: target.energy - absorbed,
      alive: false,
      diedAtTick: ctx.draft.world.tick,
      causeOfDeath: 'predation',
    });
  } else {
    ctx.draft.organisms.set(target.id, { ...target, health: nextHealth });
  }
  ctx.draft.organisms.set(organism.id, { ...organism, energy: attackerEnergy });

  ctx.events.emit('organismAttacked', organism.regionId, {
    summary: `${organism.id} attacked ${target.id}`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: { targetOrganismId: target.id, damage, lethal },
  });
  return ACCEPTED;
}

function applyShare(
  ctx: ResolutionContext,
  organism: Organism,
  action: Extract<AgentAction, { type: 'share' }>,
): Resolution {
  const target = ctx.draft.organisms.get(asOrganism(action.targetOrganismId));
  if (!target || !target.alive) return reject('unknownTarget');
  if (target.id === organism.id) return reject('selfTarget');
  if (distance(organism.position, target.position) > ctx.config.interactionRadiusCu) {
    return reject('outOfRange');
  }
  const amount = Math.min(action.energy, organism.energy);
  if (amount <= 0) return reject('insufficientEnergy');
  const targetPhenotype = derivePhenotype(target.genotype);
  const accepted = Math.min(amount, targetPhenotype.maxEnergy - target.energy);
  if (accepted <= 0) return reject('actionUnavailable');

  // Pure internal transfer: the ledger is untouched.
  ctx.draft.organisms.set(organism.id, { ...organism, energy: organism.energy - accepted });
  ctx.draft.organisms.set(target.id, { ...target, energy: target.energy + accepted });
  ctx.events.emit('energyShared', organism.regionId, {
    summary: `${organism.id} shared ${accepted}eu`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: { targetOrganismId: target.id, energy: accepted },
  });
  return ACCEPTED;
}

function applySignal(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  action: Extract<AgentAction, { type: 'signal' }>,
): Resolution {
  const cost = Math.max(1, scaleByPerMille(6, action.intensity));
  if (organism.energy < cost) return reject('insufficientEnergy');
  const radius = scaleByPerMille(phenotype.signalRadiusCu, action.intensity);
  if (radius <= 0) return reject('capabilityNotEvolved');

  const agent = ctx.draft.agents.get(organism.agentId);
  // Matched by content-addressed key, never by label: a label is display text that may be
  // rewritten, and matching on it would silently sever cultural transmission.
  const recipe =
    action.channel === 'teach' && action.recipeKey !== undefined
      ? agent?.knowledge.recipes.find((r) => r.key === action.recipeKey)
      : undefined;
  if (action.channel === 'teach' && !recipe) return reject('unknownTarget');

  ctx.ledger.debit(cost);
  ctx.draft.organisms.set(organism.id, { ...organism, energy: organism.energy - cost });
  ctx.draft.signals.push({
    organismId: organism.id,
    lineageId: organism.lineageId,
    agentId: organism.agentId,
    position: organism.position,
    regionId: organism.regionId,
    channel: action.channel,
    intensity: action.intensity,
    radiusCu: radius,
    emittedAtTick: ctx.draft.world.tick,
    ...(recipe === undefined ? {} : { recipe }),
  });
  ctx.events.emit('signalEmitted', organism.regionId, {
    summary: `${organism.id} signalled ${action.channel}`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: { channel: action.channel, intensity: action.intensity, radiusCu: radius },
  });
  return ACCEPTED;
}

/* -------------------------------------------------------------------------- */
/* Lifetime adaptation                                                         */
/* -------------------------------------------------------------------------- */

function applyExpressTrait(
  ctx: ResolutionContext,
  organism: Organism,
  traitId: string,
): Resolution {
  const cost = 4;
  if (organism.energy < cost) return reject('insufficientEnergy');
  const current = organism.lifetime.emphasis[traitId as keyof typeof organism.lifetime.emphasis];
  const next = Math.min(MAX_TRAIT_EMPHASIS, (current ?? 0) + 25);
  ctx.ledger.debit(cost);
  ctx.draft.organisms.set(organism.id, {
    ...organism,
    energy: organism.energy - cost,
    lifetime: {
      ...organism.lifetime,
      // Lifetime emphasis is explicitly *not* written back to the genotype: it dies with
      // the individual. Only reproduction touches heritable values.
      emphasis: { ...organism.lifetime.emphasis, [traitId]: next },
    },
  });
  ctx.events.emit('traitExpressed', organism.regionId, {
    summary: `${organism.id} emphasised ${traitId}`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: { traitId, emphasis: next },
  });
  return ACCEPTED;
}

/* -------------------------------------------------------------------------- */
/* Materials and construction                                                  */
/* -------------------------------------------------------------------------- */

function applyCollect(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  action: Extract<AgentAction, { type: 'collect' }>,
): Resolution {
  const node = ctx.draft.resources.get(asResourceNode(action.resourceNodeId));
  if (!node || node.quantity <= 0) return reject('unknownTarget');
  if (distance(organism.position, node.position) > ctx.config.interactionRadiusCu) {
    return reject('outOfRange');
  }
  const carried = organism.inventory.reduce((sum, e) => sum + e.quantity, 0);
  const headroom = ctx.config.inventoryCapacity - carried;
  if (headroom <= 0) return reject('inventoryFull');

  const capable = Math.max(1, scaleByPerMille(60, phenotype.manipulationScore));
  const taken = Math.min(action.quantity, node.quantity, headroom, capable);
  if (taken <= 0) return reject('inventoryFull');
  const cost = Math.max(1, Math.trunc(taken / 8));
  if (organism.energy < cost) return reject('insufficientEnergy');

  const existing = organism.inventory.find((e) => e.materialId === node.materialId);
  if (!existing && organism.inventory.length >= MAX_INVENTORY_ENTRIES)
    return reject('inventoryFull');
  const inventory: InventoryEntry[] = existing
    ? organism.inventory.map((e) =>
        e.materialId === node.materialId ? { ...e, quantity: e.quantity + taken } : e,
      )
    : [...organism.inventory, { materialId: node.materialId, quantity: taken }];

  ctx.ledger.debit(cost);
  const remaining = node.quantity - taken;
  ctx.draft.resources.set(node.id, { ...node, quantity: remaining });
  ctx.draft.organisms.set(organism.id, {
    ...organism,
    energy: organism.energy - cost,
    inventory,
  });
  learnMaterial(ctx, organism.agentId, node.materialId);
  // Gathering was the only one of the thirteen actions that resolved silently, which made the
  // single most frequent productive act in the world invisible to spectators and to every
  // measurement taken over the event log. Emitting it is what makes foraging observable at all.
  const label = ctx.draft.materials.get(node.materialId)?.label ?? node.materialId;
  ctx.events.emit('materialCollected', organism.regionId, {
    summary: `${organism.id} gathered ${taken} ${label}`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: {
      materialId: node.materialId,
      label,
      quantity: taken,
      resourceNodeId: node.id,
      remaining,
    },
  });
  return ACCEPTED;
}

function applyCombine(
  ctx: ResolutionContext,
  organism: Organism,
  action: Extract<AgentAction, { type: 'combine' }>,
): Resolution {
  const components = toComponents(action.components);
  if (!hasInventory(organism, components)) return reject('insufficientMaterial');

  const volume = totalVolume(components);
  const cost = Math.max(1, Math.trunc(volume / 4));
  if (organism.energy < cost) return reject('insufficientEnergy');

  // The derived material's properties are a volume-weighted blend, and both its identity and its
  // name follow from those properties rather than from the ingredient list. Combining is therefore
  // speculative in a way it was not before: an organism cannot know what it will get, and two
  // different recipes may turn out to yield the same substance.
  const candidate = combineMaterials(components, ctx.draft.materials, ctx.draft.world.tick);
  if (!candidate) return reject('insufficientMaterial');
  const derivedId = candidate.id;
  const existing = ctx.draft.materials.get(derivedId);
  // Only a *new* entry can overflow the catalogue. Repeating a combination — or arriving at a known
  // substance by a new route — resolves to an id the world already holds, and `set` leaves the size
  // unchanged. Testing the cap before that is known bounds nothing and permanently disables all
  // crafting the moment the catalogue saturates.
  if (!existing && ctx.draft.materials.size >= ctx.config.maxMaterials) {
    return reject('actionUnavailable');
  }
  // The first discovery keeps its own properties. A later route landing in the same bucket is the
  // same substance, and rewriting the entry would silently mutate every inventory holding it.
  const definition = existing ?? candidate;

  ctx.ledger.debit(cost);
  ctx.draft.materials.set(derivedId, definition);
  const inventory = consumeInventory(organism.inventory, components);
  const produced = Math.max(1, Math.trunc(volume / 2));
  ctx.draft.organisms.set(organism.id, {
    ...organism,
    energy: organism.energy - cost,
    inventory: addInventory(inventory, { materialId: derivedId, quantity: produced }),
  });
  learnMaterial(ctx, organism.agentId, derivedId);
  // The recipe is labelled by what it produces, so its label always matches the material.
  learnRecipe(ctx, organism.agentId, deriveRecipeKey(components), definition.label, components, {
    produces: derivedId,
  });
  if (!existing) {
    ctx.events.emit('materialDiscovered', organism.regionId, {
      summary: `${organism.id} produced ${definition.label}`,
      organismId: organism.id,
      agentId: organism.agentId,
      lineageId: organism.lineageId,
      payload: { materialId: derivedId },
    });
  }
  ctx.events.emit('materialCombined', organism.regionId, {
    summary: `${organism.id} combined ${components.length} materials`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: {
      materialId: derivedId,
      label: definition.label,
      componentIds: components.map((c) => c.materialId),
    },
  });
  return ACCEPTED;
}

function applyBuild(
  ctx: ResolutionContext,
  organism: Organism,
  action: Extract<AgentAction, { type: 'build' }>,
): Resolution {
  if (ctx.draft.structures.size >= ctx.config.maxStructures) return reject('actionUnavailable');
  const components = toComponents(action.components);
  if (!hasInventory(organism, components)) return reject('insufficientMaterial');
  const volume = totalVolume(components);
  if (volume < MIN_STRUCTURE_VOLUME) return reject('insufficientMaterial');
  const cost = Math.max(1, volume * ctx.config.buildEnergyPerUnit);
  if (organism.energy < cost) return reject('insufficientEnergy');

  // Authoritative derivation. What the builder *intended* is irrelevant.
  const functions = deriveStructureFunctions(components, action.pattern, ctx.draft.materials);
  const properties = blendProperties(components, ctx.draft.materials);
  const structureId = asStructureId(
    `st-${ctx.draft.world.id}-${String(ctx.draft.world.tick).padStart(8, '0')}-${ctx.draft.structures.size.toString(36)}`,
  );
  const structure: Structure = {
    id: structureId,
    regionId: organism.regionId,
    position: organism.position,
    pattern: action.pattern,
    components,
    functions,
    properties,
    volume,
    integrity: initialIntegrity(properties),
    createdByAgentId: organism.agentId,
    createdByLineageId: organism.lineageId,
    createdByOrganismId: organism.id,
    createdAtTick: ctx.draft.world.tick,
    lastChangedAtTick: ctx.draft.world.tick,
    usage: [],
    label: describeStructure(action.pattern, functions),
  };

  ctx.ledger.debit(cost);
  ctx.draft.structures.set(structureId, structure);
  ctx.draft.organisms.set(organism.id, {
    ...organism,
    energy: organism.energy - cost,
    inventory: consumeInventory(organism.inventory, components),
  });
  learnStructure(ctx, organism.agentId, structureId);
  ctx.events.emit('structureBuilt', organism.regionId, {
    summary: `${organism.id} built a ${structure.label}`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: { structureId, pattern: action.pattern, functions: functions.map((f) => f.id) },
  });
  return ACCEPTED;
}

function applyAttach(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  structureId: string,
): Resolution {
  const structure = ctx.draft.structures.get(asStructure(structureId));
  if (!structure) return reject('unknownTarget');
  if (distance(organism.position, structure.position) > ctx.config.interactionRadiusCu) {
    return reject('outOfRange');
  }
  const shelter = structure.functions.find((f) => f.id === 'shelter' || f.id === 'anchor');
  if (!shelter) return reject('actionUnavailable');
  void phenotype;

  ctx.draft.structures.set(structure.id, {
    ...structure,
    usage: recordUsage(structure.usage, {
      tick: ctx.draft.world.tick,
      organismId: organism.id,
      lineageId: organism.lineageId,
      kind: 'shelter',
    }).slice(-MAX_STRUCTURE_USAGE_RECORDS),
  });
  ctx.draft.organisms.set(organism.id, { ...organism, attachedStructureId: structure.id });
  ctx.events.emit('structureUsed', organism.regionId, {
    summary: `${organism.id} sheltered in ${structure.label}`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: { structureId: structure.id, functionId: shelter.id },
  });
  return ACCEPTED;
}

function applyInspect(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  action: Extract<AgentAction, { type: 'inspect' }>,
): Resolution {
  if (action.targetKind === 'structure') {
    const structure = ctx.draft.structures.get(asStructure(action.targetId));
    if (!structure) return reject('unknownTarget');
    if (
      distance(organism.position, structure.position) >
      structureVisibilityRadiusCu(phenotype.perceptionRadiusCu, structure.volume)
    ) {
      return reject('notVisible');
    }
    learnStructure(ctx, organism.agentId, structure.id);
    for (const component of structure.components) {
      learnMaterial(ctx, organism.agentId, component.materialId);
    }
    learnRecipesFromStructure(ctx, organism, phenotype, structure);
    rememberStructure(ctx, organism, structure);
    ctx.draft.structures.set(structure.id, {
      ...structure,
      usage: recordUsage(structure.usage, {
        tick: ctx.draft.world.tick,
        organismId: organism.id,
        lineageId: organism.lineageId,
        kind: 'inspect',
      }).slice(-MAX_STRUCTURE_USAGE_RECORDS),
    });
    const strongest = strongestFunction(structure.functions);
    ctx.events.emit('structureUsed', organism.regionId, {
      summary: `${organism.id} inspected ${structure.label}`,
      organismId: organism.id,
      agentId: organism.agentId,
      lineageId: organism.lineageId,
      payload: { structureId: structure.id, functionId: strongest },
    });
    return ACCEPTED;
  }

  if (action.targetKind === 'resourceNode') {
    const node = ctx.draft.resources.get(asResourceNode(action.targetId));
    if (!node) return reject('unknownTarget');
    if (distance(organism.position, node.position) > phenotype.perceptionRadiusCu) {
      return reject('notVisible');
    }
    learnMaterial(ctx, organism.agentId, node.materialId);
    return ACCEPTED;
  }

  const target = ctx.draft.organisms.get(asOrganism(action.targetId));
  if (!target || !target.alive) return reject('unknownTarget');
  if (distance(organism.position, target.position) > phenotype.perceptionRadiusCu) {
    return reject('notVisible');
  }
  return ACCEPTED;
}

function applyRepurpose(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  action: Extract<AgentAction, { type: 'repurpose' }>,
): Resolution {
  const structure = ctx.draft.structures.get(asStructure(action.structureId));
  if (!structure) return reject('unknownTarget');
  if (distance(organism.position, structure.position) > ctx.config.interactionRadiusCu) {
    return reject('outOfRange');
  }
  const cost = Math.max(2, Math.trunc(structure.volume / 6));
  if (organism.energy < cost) return reject('insufficientEnergy');

  // Reworking someone else's construction damages it; reworking your own is cheaper.
  const foreign = structure.createdByLineageId !== organism.lineageId;
  const integrityLoss = foreign
    ? Math.max(40, 200 - scaleByPerMille(120, phenotype.manipulationScore))
    : 40;
  const functions = deriveStructureFunctions(
    structure.components,
    action.pattern,
    ctx.draft.materials,
  );
  const integrity = clampPerMille(structure.integrity - integrityLoss);

  ctx.ledger.debit(cost);
  ctx.draft.organisms.set(organism.id, { ...organism, energy: organism.energy - cost });
  if (integrity <= 0) {
    ctx.draft.structures.delete(structure.id);
    ctx.events.emit('structureCollapsed', organism.regionId, {
      summary: `${structure.label} collapsed while being repurposed`,
      organismId: organism.id,
      agentId: organism.agentId,
      lineageId: organism.lineageId,
      payload: { structureId: structure.id },
    });
    return ACCEPTED;
  }
  ctx.draft.structures.set(structure.id, {
    ...structure,
    pattern: action.pattern,
    functions,
    integrity,
    lastChangedAtTick: ctx.draft.world.tick,
    label: describeStructure(action.pattern, functions),
    usage: recordUsage(structure.usage, {
      tick: ctx.draft.world.tick,
      organismId: organism.id,
      lineageId: organism.lineageId,
      kind: 'repurpose',
    }).slice(-MAX_STRUCTURE_USAGE_RECORDS),
  });
  learnStructure(ctx, organism.agentId, structure.id);
  ctx.events.emit('structureRepurposed', organism.regionId, {
    summary: `${organism.id} repurposed a structure into a ${action.pattern}`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: {
      structureId: structure.id,
      pattern: action.pattern,
      functions: functions.map((f) => f.id),
    },
  });
  return ACCEPTED;
}

/**
 * Spend carried material to push a structure's integrity back up.
 *
 * This is the only force in the world that opposes decay, so it is what decides whether anything
 * built is ever kept. Deliberately open to any lineage: maintaining a neighbour's construction is a
 * cooperative act, and the structure is a shared landmark either way.
 */
function applyRepair(
  ctx: ResolutionContext,
  organism: Organism,
  action: Extract<AgentAction, { type: 'repair' }>,
): Resolution {
  const structure = ctx.draft.structures.get(asStructure(action.structureId));
  if (!structure) return reject('unknownTarget');
  if (distance(organism.position, structure.position) > ctx.config.interactionRadiusCu) {
    return reject('outOfRange');
  }
  if (structure.integrity >= PER_MILLE) return reject('actionUnavailable');

  const components = toComponents(action.components);
  if (!hasInventory(organism, components)) return reject('insufficientMaterial');
  const patchVolume = totalVolume(components);
  if (patchVolume <= 0) return reject('insufficientMaterial');

  // Patching is cheaper per unit than raising a structure from nothing: the frame already exists.
  const cost = Math.max(1, Math.trunc((patchVolume * ctx.config.buildEnergyPerUnit) / 2));
  if (organism.energy < cost) return reject('insufficientEnergy');

  const patchProperties = blendProperties(components, ctx.draft.materials);
  const restored = repairYield(
    structure.properties,
    patchProperties,
    patchVolume,
    structure.volume,
  );
  const integrity = clampPerMille(structure.integrity + restored);

  ctx.ledger.debit(cost);
  ctx.draft.organisms.set(organism.id, {
    ...organism,
    energy: organism.energy - cost,
    inventory: consumeInventory(organism.inventory, components),
  });
  ctx.draft.structures.set(structure.id, {
    ...structure,
    integrity,
    lastChangedAtTick: ctx.draft.world.tick,
    usage: recordUsage(structure.usage, {
      tick: ctx.draft.world.tick,
      organismId: organism.id,
      lineageId: organism.lineageId,
      kind: 'repair',
    }).slice(-MAX_STRUCTURE_USAGE_RECORDS),
  });
  learnStructure(ctx, organism.agentId, structure.id);
  ctx.events.emit('structureRepaired', organism.regionId, {
    summary: `${organism.id} repaired a ${structure.label}`,
    organismId: organism.id,
    agentId: organism.agentId,
    lineageId: organism.lineageId,
    payload: { structureId: structure.id, integrity, restored },
  });
  return ACCEPTED;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */
function strongestFunction(functions: readonly DerivedFunction[]) {
  if (functions.length === 0) return 'shelter' as const;
  return functions.reduce((best, f) => (f.magnitude > best.magnitude ? f : best)).id;
}

function toComponents(
  raw: readonly { readonly materialId: string; readonly quantity: number }[],
): MaterialComponent[] {
  return [
    ...normaliseComponents(
      raw.map((c) => ({ materialId: asMaterialId(c.materialId), quantity: c.quantity })),
    ),
  ];
}

function hasInventory(organism: Organism, components: readonly MaterialComponent[]): boolean {
  for (const component of components) {
    const entry = organism.inventory.find((e) => e.materialId === component.materialId);
    if (!entry || entry.quantity < component.quantity) return false;
  }
  return components.length > 0;
}

function consumeInventory(
  inventory: readonly InventoryEntry[],
  components: readonly MaterialComponent[],
): InventoryEntry[] {
  const next = inventory.map((e) => ({ ...e }));
  for (const component of components) {
    const entry = next.find((e) => e.materialId === component.materialId);
    if (entry) entry.quantity -= component.quantity;
  }
  return next.filter((e) => e.quantity > 0);
}

function addInventory(inventory: InventoryEntry[], entry: InventoryEntry): InventoryEntry[] {
  const existing = inventory.find((e) => e.materialId === entry.materialId);
  if (existing) {
    return inventory.map((e) =>
      e.materialId === entry.materialId ? { ...e, quantity: e.quantity + entry.quantity } : e,
    );
  }
  if (inventory.length >= MAX_INVENTORY_ENTRIES) return inventory;
  return [...inventory, entry];
}

/** Derived materials are content-addressed so the same recipe always yields the same id. */
function learnMaterial(
  ctx: ResolutionContext,
  agentId: Organism['agentId'],
  materialId: string,
): void {
  const agent = ctx.draft.agents.get(agentId);
  if (!agent) return;
  const id = asMaterialId(materialId);
  if (agent.knowledge.knownMaterialIds.includes(id)) return;
  const known = [...agent.knowledge.knownMaterialIds, id].slice(-MAX_KNOWN_MATERIALS);
  ctx.draft.agents.set(agentId, {
    ...agent,
    knowledge: { ...agent.knowledge, knownMaterialIds: known },
  });
}

function learnStructure(
  ctx: ResolutionContext,
  agentId: Organism['agentId'],
  structureId: Structure['id'],
): void {
  const agent = ctx.draft.agents.get(agentId);
  if (!agent) return;
  if (agent.knowledge.knownStructureIds.includes(structureId)) return;
  const known = [...agent.knowledge.knownStructureIds, structureId].slice(-MAX_KNOWN_STRUCTURES);
  ctx.draft.agents.set(agentId, {
    ...agent,
    knowledge: { ...agent.knowledge, knownStructureIds: known },
  });
}

function learnRecipe(
  ctx: ResolutionContext,
  agentId: Organism['agentId'],
  key: string,
  label: string,
  components: readonly MaterialComponent[],
  provenance: { readonly produces?: MaterialId; readonly fromLineageId?: LineageId } = {},
): void {
  const agent = ctx.draft.agents.get(agentId);
  if (!agent) return;
  if (agent.knowledge.recipes.some((r) => r.key === key)) return;
  const recipes = [
    ...agent.knowledge.recipes,
    {
      key,
      label,
      components,
      learnedAtTick: ctx.draft.world.tick,
      ...(provenance.produces === undefined ? {} : { producesMaterialId: provenance.produces }),
      ...(provenance.fromLineageId === undefined
        ? {}
        : { learnedFromLineageId: provenance.fromLineageId }),
    },
  ].slice(-MAX_KNOWN_RECIPES);
  ctx.draft.agents.set(agentId, { ...agent, knowledge: { ...agent.knowledge, recipes } });
}

export { learnRecipe, learnMaterial, learnStructure };

/**
 * Reads the recipes for a construction's composite components out of the construction itself.
 *
 * This is the world's durable channel for cultural transmission, and the one the rest of the
 * simulation was already built around: `observe` grants structures a long-range landmark bonus
 * expressly so "knowledge could never cross a lineage boundary" stops being true, and the
 * heuristic's inspect branch is documented as "how knowledge crosses a lineage boundary". Both
 * were correct about the intent and neither ever transferred a recipe, because inspection learned
 * a structure's *materials* without ever learning how any of them were made — and a composite
 * material cannot be gathered, only combined, so its id alone is close to useless.
 *
 * Teaching by signal cannot carry this load on its own. Measured over 600 ticks, an organism saw
 * any non-kin organism at all on 0.54% of its turns on one trajectory and on *none* of 47,067
 * turns on another: lineages settle apart and mostly never meet. A building does not have to be
 * met. It stands for over a thousand ticks after its builder is dead, stays legible at landmark
 * range, and so lets knowledge travel across both distance and time — which is what distinguishes
 * culture from a conversation.
 *
 * A composite's ingredient list *is* its recipe, so the artefact genuinely carries the knowledge
 * rather than the reader being handed it. Memory is required: an organism that cannot retain
 * anything cannot carry a recipe home, the same condition `propagateKnowledge` places on a
 * listener.
 */
function learnRecipesFromStructure(
  ctx: ResolutionContext,
  organism: Organism,
  phenotype: Phenotype,
  structure: Structure,
): void {
  if (phenotype.memorySlots < 1) return;
  const agent = ctx.draft.agents.get(organism.agentId);
  if (!agent) return;

  const known = new Set(agent.knowledge.recipes.map((r) => r.key));
  for (const component of structure.components) {
    const definition = ctx.draft.materials.get(component.materialId);
    const derivedFrom = definition?.derivedFrom;
    if (!definition || !derivedFrom || derivedFrom.length === 0) continue;
    const key = deriveRecipeKey(derivedFrom);
    if (known.has(key)) continue;
    known.add(key);
    learnRecipe(ctx, organism.agentId, key, definition.label, derivedFrom, {
      produces: definition.id,
      fromLineageId: structure.createdByLineageId,
    });
    // Attributed to the builder, exactly as a taught recipe is attributed to its teacher, so
    // the origin of a piece of knowledge reads the same however it travelled.
    ctx.events.emit('knowledgeShared', organism.regionId, {
      summary: `${organism.lineageId} learned ${definition.label} from ${structure.label}`,
      agentId: structure.createdByAgentId,
      lineageId: structure.createdByLineageId,
      organismId: organism.id,
      payload: {
        recipeKey: key,
        recipeLabel: definition.label,
        toLineageIds: [organism.lineageId],
      },
    });
  }
}

function rememberStructure(ctx: ResolutionContext, organism: Organism, structure: Structure): void {
  const phenotype = derivePhenotype(organism.genotype);
  if (phenotype.memorySlots <= 0) return;
  const existing = ctx.draft.memories.get(organism.agentId) ?? [];
  const note = `saw ${structure.label} at ${structure.regionId}`.slice(0, MAX_MEMORY_NOTE_LENGTH);
  if (existing.some((m) => m.subjectId === structure.id)) return;
  const next = [
    ...existing,
    {
      id: asMemoryIdSafe(`me-${organism.agentId}-${structure.id}`),
      agentId: organism.agentId,
      kind: 'structure' as const,
      createdAtTick: ctx.draft.world.tick,
      salience: 800,
      position: structure.position,
      subjectId: structure.id,
      note,
    },
  ];
  next.sort((a, b) => b.salience - a.salience || (a.id < b.id ? -1 : 1));
  ctx.draft.memories.set(organism.agentId, next.slice(0, phenotype.memorySlots));
}

/* Narrow helpers: every cast is preceded by the domain's own identifier validation. */

function asOrganism(value: string) {
  return asOrganismId(value);
}

function asResourceNode(value: string) {
  return asResourceNodeId(value);
}

function asStructure(value: string) {
  return asStructureId(value);
}

function asMemoryIdSafe(value: string) {
  return asMemoryId(value.slice(0, 64));
}

/** Signals older than {@link SIGNAL_LIFETIME_TICKS} are dropped at the start of each tick. */
export function expireSignals(draft: WorldDraft): void {
  draft.signals = draft.signals.filter(
    (s) => draft.world.tick - s.emittedAtTick < SIGNAL_LIFETIME_TICKS,
  );
}
