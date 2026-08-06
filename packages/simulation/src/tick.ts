import {
  MAX_MEMORY_NOTE_LENGTH,
  Prng,
  SIGNAL_LIFETIME_TICKS,
  WORLD_SPAN_CU,
  ambientLightPerMille,
  asGoalId,
  asMemoryId,
  asOrganismId,
  clampPerMille,
  decayPerTick,
  derivePhenotype,
  hashSeed,
  isPressureBoundary,
  makePosition,
  regionIdOf,
  scaleByPerMille,
  type ActionProposal,
  type AgentAction,
  type AgentGoal,
  type DeathCause,
  type EnvironmentalPressure,
  type LineageId,
  type Memory,
  type Observation,
  type Organism,
  type OrganismId,
  type PendingDecision,
  type Position,
  type PressureKind,
  type WorldEvent,
} from '@autocosm/domain';
import type { SimulationConfig } from './config.js';
import { DEFAULT_SIMULATION_CONFIG } from './config.js';
import {
  detectDecisionPoint,
  selectDecisions,
  toPendingDecision,
  type DecisionCandidate,
} from './decisions.js';
import { EventSink } from './events.js';
import { meanGenotypeOf, reproduce } from './evolution.js';
import { decideHeuristically } from './heuristics.js';
import { observe } from './observe.js';
import { EnergyLedger, absorbEnergy, resolveAction, type ResolutionContext } from './resolve.js';
import {
  freezeDraft,
  livingOrganismIds,
  sortedIds,
  toDraft,
  type WorldDraft,
  type WorldState,
} from './state.js';

/**
 * The deterministic tick engine.
 *
 * `advanceTick(state, input)` is a pure function. Given the same world state, the same
 * ordered accepted proposals and the same seed, it always produces the same next state and
 * the same events with the same identifiers. Nothing here reads wall-clock time, the
 * network, storage or `Math.random`.
 */
export interface TickInput {
  /** Proposals returned by the think job, keyed by organism. Applied before reflexes. */
  readonly proposals?: ReadonlyMap<OrganismId, ActionProposal>;
  readonly config?: SimulationConfig;
}

export interface TickResult {
  readonly state: WorldState;
  readonly events: readonly WorldEvent[];
  readonly decisions: readonly PendingDecision[];
  readonly metrics: TickMetrics;
}

export interface TickMetrics {
  readonly tick: number;
  readonly livingOrganisms: number;
  readonly births: number;
  readonly deaths: number;
  readonly acceptedActions: number;
  readonly rejectedActions: number;
  readonly proposalsApplied: number;
  readonly decisionsRequested: number;
  readonly structures: number;
  readonly energyInflow: number;
  readonly energyOutflow: number;
  readonly eventsDropped: number;
}

export function advanceTick(state: WorldState, input: TickInput = {}): TickResult {
  const config = input.config ?? DEFAULT_SIMULATION_CONFIG;
  const draft = toDraft(state);
  const tick = draft.world.tick + 1;
  draft.world = { ...draft.world, tick };

  const events = new EventSink(draft.world.id, tick);
  const ledger = new EnergyLedger();
  const ctx: ResolutionContext = { draft, config, events, ledger };

  let births = 0;
  let deaths = 0;
  let accepted = 0;
  let rejected = 0;
  let proposalsApplied = 0;

  // 1. Environment: pressure cycle, then regional regeneration.
  applyPressure(draft, events);
  regenerateRegions(draft, config);

  // 2. Expire stale signals emitted in earlier ticks.
  draft.signals = draft.signals.filter((s) => tick - s.emittedAtTick < SIGNAL_LIFETIME_TICKS);

  // 3. Found organisms for lineages authored since the last tick. Agent creation never
  //    writes world state directly; the tick is the only thing that can add a body.
  births += foundPendingLineages(draft, events);

  // 4. Per-organism resolution, in stable identifier order.
  const order = livingOrganismIds(draft);
  if (order.length > config.maxOrganismsProcessedPerTick) {
    order.length = config.maxOrganismsProcessedPerTick;
  }

  const candidates: DecisionCandidate[] = [];
  const observations = new Map<OrganismId, Observation>();
  let reproductionOrdinal = 0;

  for (const organismId of order) {
    const current = draft.organisms.get(organismId);
    if (!current || !current.alive) continue;
    const phenotype = derivePhenotype(current.genotype);
    const observation = observe(draft, current, phenotype);
    observations.set(organismId, observation);

    const proposal = input.proposals?.get(organismId);
    let action: AgentAction;
    if (proposal) {
      action = proposal.action;
      proposalsApplied += 1;
    } else {
      action = decideHeuristically(observation, draft.world.seed);
    }

    if (action.type === 'reproduce') {
      const outcome = reproduce({
        draft,
        config,
        events,
        ledger,
        parent: current,
        investment: action.investment,
        ordinal: reproductionOrdinal,
      });
      reproductionOrdinal += 1;
      if (outcome.child) {
        births += 1;
        accepted += 1;
      } else {
        rejected += 1;
        events.emit('actionRejected', current.regionId, {
          summary: `reproduce rejected: ${outcome.reason ?? 'unknown'}`,
          organismId: current.id,
          agentId: current.agentId,
          lineageId: current.lineageId,
          payload: { actionType: 'reproduce', reason: 'actionUnavailable' },
        });
      }
    } else {
      const resolution = resolveAction(ctx, organismId, action);
      if (resolution.accepted) {
        accepted += 1;
      } else {
        rejected += 1;
        events.emit('actionRejected', current.regionId, {
          summary: `${action.type} rejected: ${resolution.reason ?? 'unknown'}`,
          organismId: current.id,
          agentId: current.agentId,
          lineageId: current.lineageId,
          payload: { actionType: action.type, reason: resolution.reason ?? 'malformed' },
        });
      }
    }

    // Metabolism, ageing and survival are applied after the action so that an organism
    // always pays for the tick it acted in.
    const after = draft.organisms.get(organismId);
    if (after?.alive) {
      const cause = metabolise(draft, after, config, ledger);
      if (cause) markDead(draft, organismId, cause);
    }
  }

  // 4b. One sweep finalises every death this tick, whatever caused it.
  deaths += finaliseDeaths(draft, events, ledger, config);

  // 5. Propagate teaching signals into lineage knowledge.
  propagateKnowledge(draft, events);

  // 6. Structures decay; collapsed ones are removed so storage stays bounded.
  decayStructures(draft, events);

  // 7. Memories fade.
  decayMemories(draft, config);

  // 8. Consider pending creator goals. Adoption is never guaranteed.
  considerGoals(draft, events);

  // 9. Lineage bookkeeping and extinction.
  updateLineages(draft, events);

  // 9b. Old corpses are dropped so storage stays bounded. Ancestry survives in `lineageNodes`.
  pruneDeadOrganisms(draft, config);

  // 10. Decision points.
  for (const organismId of order) {
    const organism = draft.organisms.get(organismId);
    const observation = observations.get(organismId);
    if (!organism?.alive || !observation) continue;
    const candidate = detectDecisionPoint(draft, organism, observation, config);
    if (candidate) candidates.push(candidate);
  }
  const selected = selectDecisions(candidates, config.maxDecisionsPerTick);
  const decisions: PendingDecision[] = [];
  for (const candidate of selected) {
    const observation = observations.get(candidate.organism.id);
    if (!observation) continue;
    const decision = toPendingDecision(draft, candidate, observation, config);
    decisions.push(decision);
    const agent = draft.agents.get(candidate.organism.agentId);
    if (agent) {
      draft.agents.set(agent.id, {
        ...agent,
        lastDecisionTick: tick,
        decisionCount: agent.decisionCount + 1,
      });
    }
    events.emit('decisionRequested', candidate.organism.regionId, {
      summary: `decision requested: ${candidate.reason}`,
      organismId: candidate.organism.id,
      agentId: candidate.organism.agentId,
      lineageId: candidate.organism.lineageId,
      causationId: decision.id,
      payload: { decisionId: decision.id, reason: candidate.reason },
    });
  }

  // 11. World statistics.
  const living = livingOrganismIds(draft).length;
  let activeLineages = 0;
  let extinctLineages = 0;
  for (const id of sortedIds(draft.lineages)) {
    const lineage = draft.lineages.get(id);
    if (!lineage) continue;
    if (lineage.extinctAtTick === undefined) activeLineages += 1;
    else extinctLineages += 1;
  }
  draft.world = {
    ...draft.world,
    stats: {
      livingOrganisms: living,
      activeLineages,
      extinctLineages,
      structures: draft.structures.size,
      discoveredMaterials: draft.materials.size,
      totalBirths: draft.world.stats.totalBirths + births,
      totalDeaths: draft.world.stats.totalDeaths + deaths,
    },
  };

  return {
    state: freezeDraft(draft),
    events: events.drain(),
    decisions,
    metrics: {
      tick,
      livingOrganisms: living,
      births,
      deaths,
      acceptedActions: accepted,
      rejectedActions: rejected,
      proposalsApplied,
      decisionsRequested: decisions.length,
      structures: draft.structures.size,
      energyInflow: ledger.inflow,
      energyOutflow: ledger.outflow,
      eventsDropped: events.droppedCount,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Stages                                                                      */
/* -------------------------------------------------------------------------- */

const PRESSURE_KINDS: readonly PressureKind[] = [
  'heatwave',
  'coldSnap',
  'drought',
  'bloom',
  'storm',
];

function applyPressure(draft: WorldDraft, events: EventSink): void {
  const tick = draft.world.tick;
  if (draft.world.pressure.endsAtTick > 0 && tick >= draft.world.pressure.endsAtTick) {
    draft.world = {
      ...draft.world,
      pressure: { kind: 'calm', startedAtTick: tick, endsAtTick: 0, severity: 0 },
    };
  }
  if (!isPressureBoundary(tick, draft.world.calendar)) return;

  const rng = new Prng(hashSeed('pressure', draft.world.seed, tick));
  const kind = PRESSURE_KINDS[rng.nextInt(PRESSURE_KINDS.length)] ?? 'storm';
  const severity = clampPerMille(rng.nextRange(300, 900));
  const duration = rng.nextRange(24, 72);
  const pressure: EnvironmentalPressure = {
    kind,
    startedAtTick: tick,
    endsAtTick: tick + duration,
    severity,
  };
  draft.world = { ...draft.world, pressure };
  const firstRegion = sortedIds(draft.regions)[0];
  if (firstRegion) {
    events.emit('environmentalPressure', firstRegion, {
      summary: `${kind} began (severity ${severity}‰)`,
      payload: { pressure: kind, severity, endsAtTick: pressure.endsAtTick },
    });
  }
}

function regenerateRegions(draft: WorldDraft, config: SimulationConfig): void {
  const light = ambientLightPerMille(draft.world.tick, draft.world.calendar);
  const pressure = draft.world.pressure;
  for (const id of sortedIds(draft.regions)) {
    const region = draft.regions.get(id);
    if (!region) continue;
    let growth = scaleByPerMille(
      scaleByPerMille(config.biomassRegenAtFullLight, light),
      region.lightModifier,
    );
    // Environmental pressure suppresses or, for a bloom, amplifies primary production.
    if (pressure.kind === 'drought' || pressure.kind === 'coldSnap') {
      growth -= scaleByPerMille(growth, pressure.severity);
    } else if (pressure.kind === 'bloom') {
      growth += scaleByPerMille(growth, pressure.severity);
    }
    const biomass = Math.max(0, Math.min(config.biomassCap, region.biomass + Math.trunc(growth)));
    if (biomass !== region.biomass) draft.regions.set(id, { ...region, biomass });
  }

  for (const id of sortedIds(draft.resources)) {
    const node = draft.resources.get(id);
    if (!node || node.regenPerTick <= 0 || node.quantity >= node.capacity) continue;
    draft.resources.set(id, {
      ...node,
      quantity: Math.min(node.capacity, node.quantity + node.regenPerTick),
    });
  }
}

/**
 * Give a body to every lineage that has none yet.
 *
 * This is the second half of the agent-creation flow: `world-web` records the authored
 * agent and lineage, and the tick — the only authoritative writer — creates the first cell.
 */
function foundPendingLineages(draft: WorldDraft, events: EventSink): number {
  let founded = 0;
  for (const lineageId of sortedIds(draft.lineages)) {
    const lineage = draft.lineages.get(lineageId);
    if (!lineage || lineage.births > 0 || lineage.livingCount > 0) continue;
    if (lineage.extinctAtTick !== undefined) continue;
    const agent = draft.agents.get(lineage.agentId);
    if (!agent || agent.status !== 'active') continue;

    const rng = new Prng(hashSeed('found', draft.world.seed, lineage.id));
    const position = findHabitat(draft, agent.habitat, rng);
    const genotype = lineage.meanGenotype;
    const phenotype = derivePhenotype(genotype);
    const organismId = asOrganismId(`or-${lineage.id}-0`.slice(0, 64));
    const regionId = regionIdOf(position);

    draft.organisms.set(organismId, {
      id: organismId,
      worldId: draft.world.id,
      agentId: agent.id,
      lineageId: lineage.id,
      regionId,
      position,
      genotype,
      lifetime: { emphasis: {}, successes: {}, failures: {} },
      energy: Math.trunc((phenotype.maxEnergy * 3) / 4),
      health: phenotype.maxHealth,
      ageTicks: 0,
      bornAtTick: draft.world.tick,
      generation: 0,
      inventory: [],
      reproductionReadyTick: draft.world.tick + phenotype.maturityAgeTicks,
      alive: true,
    });
    draft.lineageNodes.set(organismId, {
      organismId,
      lineageId: lineage.id,
      bornAtTick: draft.world.tick,
      generation: 0,
      complexity: 0,
    });
    draft.lineages.set(lineage.id, { ...lineage, births: 1, livingCount: 1 });
    events.emit('organismBorn', regionId, {
      summary: `${agent.name} entered the world as a basic cell`,
      organismId,
      agentId: agent.id,
      lineageId: lineage.id,
      payload: { generation: 0 },
    });
    founded += 1;
  }
  return founded;
}

/**
 * Metabolic upkeep, environmental stress and ageing.
 *
 * Returns a cause of death, or `null` when the organism survives the tick.
 */
function metabolise(
  draft: WorldDraft,
  organism: Organism,
  config: SimulationConfig,
  ledger: EnergyLedger,
): DeathCause | null {
  const phenotype = derivePhenotype(organism.genotype);
  const region = draft.regions.get(organism.regionId);
  const light = ambientLightPerMille(draft.world.tick, draft.world.calendar);

  // Photosynthesis is the only source of energy that does not come from something else.
  const effectiveLight = scaleByPerMille(light, region?.lightModifier ?? 1000);
  const gained = scaleByPerMille(phenotype.photosynthesisAtFullLight, effectiveLight);

  let upkeep = phenotype.upkeepPerTick;
  const pressure = draft.world.pressure;
  if (pressure.severity > 0 && region) {
    const tolerance = organism.genotype.thermalTolerance;
    if (pressure.kind === 'heatwave' || pressure.kind === 'coldSnap') {
      const stress = Math.max(0, pressure.severity - tolerance);
      upkeep += scaleByPerMille(phenotype.upkeepPerTick, stress);
    } else if (pressure.kind === 'storm') {
      upkeep += scaleByPerMille(phenotype.upkeepPerTick, Math.trunc(pressure.severity / 2));
    }
  }
  // Shelter reduces exposure.
  if (organism.attachedStructureId !== undefined) {
    const structure = draft.structures.get(organism.attachedStructureId);
    const shelter = structure?.functions.find((f) => f.id === 'shelter');
    if (shelter) upkeep -= scaleByPerMille(upkeep, Math.trunc(shelter.magnitude / 2));
  }
  upkeep = Math.max(1, upkeep);

  // Photosynthesis above the storage ceiling is simply not captured, so it is never
  // credited. Upkeep the organism cannot pay is charged only up to what it actually held.
  const absorbed = absorbEnergy(organism.energy, gained, phenotype.maxEnergy);
  ledger.credit(absorbed);

  const available = organism.energy + absorbed;
  const paid = Math.min(upkeep, available);
  ledger.debit(paid);

  let energy = available - paid;
  const deficit = upkeep - paid;
  let health = organism.health;
  const ageTicks = organism.ageTicks + 1;

  if (deficit > 0) {
    // Starvation converts health into the missing energy, then kills.
    health -= Math.max(1, Math.trunc(deficit / 2));
  } else if (health < phenotype.maxHealth && energy > phenotype.upkeepPerTick * 4) {
    const regen = Math.min(phenotype.regenerationPerTick, phenotype.maxHealth - health);
    if (regen > 0 && energy >= regen) {
      health += regen;
      energy -= regen;
      ledger.debit(regen);
    }
  }

  health = Math.max(0, health);
  draft.organisms.set(organism.id, { ...organism, energy, health, ageTicks });

  if (health <= 0) return deficit > 0 ? 'starvation' : 'environment';
  if (ageTicks >= phenotype.maxAgeTicks) return 'age';
  void config;
  return null;
}

/** Mark an organism dead. Bookkeeping is finished by {@link finaliseDeaths}. */
function markDead(draft: WorldDraft, organismId: OrganismId, cause: DeathCause): void {
  const organism = draft.organisms.get(organismId);
  if (!organism || !organism.alive) return;
  draft.organisms.set(organismId, {
    ...organism,
    alive: false,
    health: 0,
    diedAtTick: draft.world.tick,
    causeOfDeath: cause,
  });
}

/**
 * Finalise every organism that died this tick, whatever killed it.
 *
 * Deaths happen in several places — predation and toxicity inside action resolution,
 * starvation and old age in metabolism — so the bookkeeping lives in one sweep. That keeps
 * the death event, the lineage record and the energy ledger consistent no matter the cause.
 */
function finaliseDeaths(
  draft: WorldDraft,
  events: EventSink,
  ledger: EnergyLedger,
  config: SimulationConfig,
): number {
  let deaths = 0;
  for (const organismId of sortedIds(draft.organisms)) {
    const organism = draft.organisms.get(organismId);
    if (!organism || organism.alive) continue;
    if (organism.diedAtTick !== draft.world.tick) continue;
    const node = draft.lineageNodes.get(organismId);
    if (node?.diedAtTick !== undefined) continue;

    deaths += 1;
    const cause: DeathCause = organism.causeOfDeath ?? 'environment';

    // The carcass leaves the organism energy pool. Part of it returns to the region as
    // biomass, closing the ecological loop; the rest is lost to decay.
    const carcass = organism.energy;
    if (carcass > 0) {
      ledger.debit(carcass);
      const region = draft.regions.get(organism.regionId);
      if (region) {
        const returned = Math.trunc(
          scaleByPerMille(carcass, config.carcassRecoveryPerMille) /
            Math.max(1, config.energyPerBiomassUnit),
        );
        if (returned > 0) {
          draft.regions.set(region.id, {
            ...region,
            biomass: Math.min(config.biomassCap, region.biomass + returned),
          });
        }
      }
      draft.organisms.set(organismId, { ...organism, energy: 0 });
    }

    if (node) {
      draft.lineageNodes.set(organismId, {
        ...node,
        diedAtTick: draft.world.tick,
        causeOfDeath: cause,
      });
    }
    events.emit('organismDied', organism.regionId, {
      summary: `${organism.id} died of ${cause}`,
      organismId,
      agentId: organism.agentId,
      lineageId: organism.lineageId,
      payload: { cause, ageTicks: organism.ageTicks },
    });
  }
  return deaths;
}

/**
 * Cultural transmission.
 *
 * A recipe only crosses a lineage boundary when someone teaches it *and* a listener has
 * evolved memory to retain it. Lineages without memory are permanently non-cultural.
 */
function propagateKnowledge(draft: WorldDraft, events: EventSink): void {
  for (const signal of draft.signals) {
    if (signal.channel !== 'teach' || !signal.recipe) continue;
    if (signal.emittedAtTick !== draft.world.tick) continue;
    const taught: LineageId[] = [];
    for (const organismId of livingOrganismIds(draft)) {
      const listener = draft.organisms.get(organismId);
      if (!listener || listener.agentId === signal.agentId) continue;
      const phenotype = derivePhenotype(listener.genotype);
      if (phenotype.memorySlots < 1) continue;
      const dx = listener.position.x - signal.position.x;
      const dz = listener.position.z - signal.position.z;
      if (dx * dx + dz * dz > signal.radiusCu * signal.radiusCu) continue;
      const agent = draft.agents.get(listener.agentId);
      if (!agent) continue;
      if (agent.knowledge.recipes.some((r) => r.key === signal.recipe?.key)) continue;
      draft.agents.set(agent.id, {
        ...agent,
        knowledge: {
          ...agent.knowledge,
          recipes: [
            ...agent.knowledge.recipes,
            {
              ...signal.recipe,
              learnedAtTick: draft.world.tick,
              learnedFromLineageId: signal.lineageId,
            },
          ].slice(-12),
        },
      });
      taught.push(listener.lineageId);
    }
    if (taught.length > 0) {
      events.emit('knowledgeShared', signal.regionId, {
        summary: `${signal.lineageId} taught ${signal.recipe.label}`,
        agentId: signal.agentId,
        lineageId: signal.lineageId,
        organismId: signal.organismId,
        payload: {
          recipeKey: signal.recipe.key,
          recipeLabel: signal.recipe.label,
          toLineageIds: [...new Set(taught)].sort(),
        },
      });
    }
  }
}

function decayStructures(draft: WorldDraft, events: EventSink): void {
  for (const id of sortedIds(draft.structures)) {
    const structure = draft.structures.get(id);
    if (!structure) continue;
    const loss = decayPerTick(structure.properties);
    const integrity = structure.integrity - loss;
    if (integrity <= 0) {
      draft.structures.delete(id);
      events.emit('structureCollapsed', structure.regionId, {
        summary: `${structure.label} collapsed`,
        lineageId: structure.createdByLineageId,
        agentId: structure.createdByAgentId,
        payload: { structureId: id },
      });
      continue;
    }
    draft.structures.set(id, { ...structure, integrity: clampPerMille(integrity) });
  }
}

/**
 * Drop the oldest corpses once more than `maxDeadOrganismsRetained` are held.
 *
 * Dead organisms stay in the map briefly so a spectator following a death event can still open
 * the organism, but they must not accumulate: the whole map is serialised into the world record
 * every tick. Permanent ancestry is kept separately in `lineageNodes`, so nothing is lost.
 *
 * Retention is by death tick, newest first, with the id as a tie-break, so the survivors are the
 * same in every process replaying the same history.
 */
function pruneDeadOrganisms(draft: WorldDraft, config: SimulationConfig): void {
  const dead: OrganismId[] = [];
  for (const id of sortedIds(draft.organisms)) {
    if (draft.organisms.get(id)?.alive === false) dead.push(id);
  }
  if (dead.length <= config.maxDeadOrganismsRetained) return;

  dead.sort((a, b) => {
    const left = draft.organisms.get(a)?.diedAtTick ?? 0;
    const right = draft.organisms.get(b)?.diedAtTick ?? 0;
    return right - left || a.localeCompare(b);
  });
  for (const id of dead.slice(config.maxDeadOrganismsRetained)) {
    draft.organisms.delete(id);
  }
}

function decayMemories(draft: WorldDraft, config: SimulationConfig): void {
  for (const agentId of sortedIds(draft.memories)) {
    const memories = draft.memories.get(agentId);
    if (!memories || memories.length === 0) continue;
    const next: Memory[] = [];
    for (const memory of memories) {
      const salience = memory.salience - config.memoryDecayPerTick;
      if (salience > 0) next.push({ ...memory, salience: clampPerMille(salience) });
    }
    if (next.length === 0) draft.memories.delete(agentId);
    else draft.memories.set(agentId, next);
  }
}

/**
 * Consider each pending creator goal.
 *
 * The agent may adopt, defer or reject it. Adoption depends on the lineage's own drives
 * and state; a human can never force it. Adopted goals become a high-salience memory that
 * biases later observations.
 */
function considerGoals(draft: WorldDraft, events: EventSink): void {
  for (const agentId of sortedIds(draft.goals)) {
    const goals = draft.goals.get(agentId);
    const agent = draft.agents.get(agentId);
    if (!goals || !agent) continue;
    let changed = false;
    const next: AgentGoal[] = [];
    for (const goal of goals) {
      if (goal.status !== 'pending') {
        next.push(goal);
        continue;
      }
      const rng = new Prng(hashSeed('goal', draft.world.seed, draft.world.tick, goal.id));
      // Agents with living bodies and spare capacity are receptive; struggling ones defer.
      const lineage = draft.lineages.get(agent.lineageId);
      const alive = lineage?.livingCount ?? 0;
      const receptiveness = clampPerMille(
        300 + Math.trunc(agent.drives.explore / 4) + Math.min(300, alive * 40),
      );
      const outcome: AgentGoal['status'] = rng.chance(receptiveness)
        ? 'adopted'
        : rng.chance(700)
          ? 'deferred'
          : 'rejected';
      next.push({
        ...goal,
        status: outcome,
        resolvedAtTick: draft.world.tick,
        resolutionNote:
          outcome === 'adopted'
            ? 'aligned with current drives'
            : outcome === 'deferred'
              ? 'postponed while survival takes priority'
              : 'incompatible with current drives',
      });
      changed = true;
      if (outcome === 'adopted') {
        const memories = draft.memories.get(agentId) ?? [];
        draft.memories.set(agentId, [
          ...memories,
          {
            id: asMemoryId(`me-goal-${goal.id}`.slice(0, 64)),
            agentId,
            kind: 'lesson',
            createdAtTick: draft.world.tick,
            salience: 1000,
            note: goal.text.slice(0, MAX_MEMORY_NOTE_LENGTH),
          },
        ]);
      }
      const region = sortedIds(draft.regions)[0];
      if (region) {
        events.emit('goalConsidered', region, {
          summary: `goal ${outcome}`,
          agentId,
          lineageId: agent.lineageId,
          causationId: goal.id,
          payload: { goalId: goal.id, outcome },
        });
      }
    }
    if (changed) draft.goals.set(agentId, next);
  }
}

function updateLineages(draft: WorldDraft, events: EventSink): void {
  const byLineage = new Map<string, Organism[]>();
  for (const organismId of livingOrganismIds(draft)) {
    const organism = draft.organisms.get(organismId);
    if (!organism) continue;
    const bucket = byLineage.get(organism.lineageId) ?? [];
    bucket.push(organism);
    byLineage.set(organism.lineageId, bucket);
  }

  for (const lineageId of sortedIds(draft.lineages)) {
    const lineage = draft.lineages.get(lineageId);
    if (!lineage) continue;
    const living = byLineage.get(lineageId) ?? [];
    const mean = meanGenotypeOf(living);
    const deaths = Math.max(0, lineage.livingCount - living.length);
    const updated = {
      ...lineage,
      livingCount: living.length,
      deaths: lineage.deaths + deaths,
      ...(mean ? { meanGenotype: mean } : {}),
    };

    if (living.length === 0 && lineage.extinctAtTick === undefined && lineage.births > 0) {
      draft.lineages.set(lineageId, { ...updated, extinctAtTick: draft.world.tick });
      const agent = draft.agents.get(lineage.agentId);
      if (agent) {
        draft.agents.set(agent.id, {
          ...agent,
          status: 'extinct',
          extinctAtTick: draft.world.tick,
        });
      }
      const region = sortedIds(draft.regions)[0];
      if (region) {
        events.emit('lineageExtinct', region, {
          summary: `${lineage.name} died out`,
          agentId: lineage.agentId,
          lineageId,
          payload: {
            generations: lineage.generations,
            lifespanTicks: draft.world.tick - lineage.foundedAtTick,
          },
        });
      }
      continue;
    }
    draft.lineages.set(lineageId, updated);
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function findHabitat(draft: WorldDraft, habitat: string, rng: Prng): Position {
  const band = HABITAT_BANDS[habitat] ?? ([-150, 150] as const);
  let best = makePosition(rng.nextInt(WORLD_SPAN_CU), rng.nextInt(WORLD_SPAN_CU));
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 64; i += 1) {
    const candidate = makePosition(rng.nextInt(WORLD_SPAN_CU), rng.nextInt(WORLD_SPAN_CU));
    const elevation = draft.terrain.elevationAtPosition(candidate);
    const score =
      elevation < band[0] ? band[0] - elevation : elevation > band[1] ? elevation - band[1] : 0;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      if (score === 0) break;
    }
  }
  return best;
}

const HABITAT_BANDS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  abyss: [-2400, -1200],
  shallows: [-1200, -150],
  shore: [-150, 150],
  plain: [150, 1100],
  highland: [1100, 2200],
});

/** Submit a creator goal into the draft. Used by tests and by the seeded demo. */
export function attachGoal(
  draft: WorldDraft,
  goal: Omit<AgentGoal, 'id'> & { readonly id?: string },
): AgentGoal {
  const id = asGoalId((goal.id ?? `go-${goal.agentId}-${draft.world.tick}`).slice(0, 64));
  const record: AgentGoal = { ...goal, id };
  const existing = draft.goals.get(goal.agentId) ?? [];
  draft.goals.set(goal.agentId, [...existing, record]);
  return record;
}

export { EnergyLedger };
