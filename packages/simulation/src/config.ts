/**
 * Bounded simulation knobs.
 *
 * Every limit here exists to keep a tick cheap, deterministic and finite. Nothing in the
 * engine may loop without a bound drawn from this configuration.
 */
export interface SimulationConfig {
  /**
   * Hard ceiling on the *living* population. Reproduction is refused above this count.
   *
   * Counts living organisms only. Corpses linger in the organism map so a spectator can still
   * inspect a recent death, and counting them here would make the ceiling cumulative: every
   * world would sterilise itself permanently once this many organisms had ever been born.
   */
  readonly maxOrganisms: number;
  /**
   * How many dead organisms are kept after they die, so a recent death stays inspectable.
   *
   * Permanent ancestry lives in `lineageNodes`, which is never pruned, so dropping a corpse
   * loses no history. This bound is what keeps the organism map — and the persisted world
   * record — finite in a world that runs indefinitely.
   */
  readonly maxDeadOrganismsRetained: number;
  /** Hard ceiling on persistent constructions. */
  readonly maxStructures: number;
  /**
   * Hard ceiling on derived material definitions, keeping the catalogue bounded.
   *
   * A backstop, not a balance knob. Discovery is one-way — nothing removes a material — so this
   * is cumulative, and a world that touches it has crafting disabled for the rest of its life.
   * It must therefore sit above the point where discovery closes on its own; see the default.
   */
  readonly maxMaterials: number;
  /** Maximum new AI decisions requested in a single tick. */
  readonly maxDecisionsPerTick: number;
  /** A decision not resolved within this many ticks is discarded. */
  readonly decisionExpiryTicks: number;
  /** Minimum ticks between AI decisions for the same lineage. Controls model spend. */
  readonly minTicksBetweenDecisionsPerLineage: number;
  /** Minimum effective planning required before a lineage is offered discretionary AI. */
  readonly minPlanningForDiscretionaryDecision: number;
  /** Biomass produced per region per tick at full light, in `mu`. */
  readonly biomassRegenAtFullLight: number;
  /** Maximum standing biomass per region, in `mu`. */
  readonly biomassCap: number;
  /** Energy released per `mu` of grazed biomass. */
  readonly energyPerBiomassUnit: number;
  /**
   * Fraction of a carcass's remaining energy that returns to the region as biomass, in
   * per-mille. The remainder is lost to decay. Keeps the ecosystem from running down while
   * still making death costly.
   */
  readonly carcassRecoveryPerMille: number;
  /** Fraction of a victim's energy an attacker actually absorbs, in per-mille. */
  readonly predationEfficiency: number; /** Fraction of reproduction energy that reaches the offspring, in per-mille. */
  readonly reproductionEfficiency: number;
  /** Energy cost per `mu` of material placed into a construction. */
  readonly buildEnergyPerUnit: number;
  /** Ticks an organism must wait between reproduction attempts. */
  readonly reproductionCooldownTicks: number;
  /** Memory salience lost per tick. */
  readonly memoryDecayPerTick: number;
  /** Maximum organisms processed per tick. Exceeding this is a configuration error. */
  readonly maxOrganismsProcessedPerTick: number;
  /** Radius within which an organism may interact with a target, in `cu`. */
  readonly interactionRadiusCu: number;
  /** Maximum material units an organism may carry. */
  readonly inventoryCapacity: number;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = Object.freeze({
  maxOrganisms: 420,
  maxDeadOrganismsRetained: 120,
  maxStructures: 160,
  // Measured with the ceiling lifted, six trajectories over 1500 ticks: discovery converges by
  // tick ~900 and then stays flat, at 133/161/188/189/201/253 materials. The reachable
  // combination space closes on its own, so no eviction is needed — only headroom above the
  // highest natural fixed point. At 96 every world was truncated at 40-70% of its own chemistry
  // by tick ~182, roughly 15% into a 1200-tick run.
  maxMaterials: 320,
  maxDecisionsPerTick: 12,
  decisionExpiryTicks: 40,
  minTicksBetweenDecisionsPerLineage: 6,
  minPlanningForDiscretionaryDecision: 40,
  biomassRegenAtFullLight: 60,
  biomassCap: 6000,
  energyPerBiomassUnit: 5,
  carcassRecoveryPerMille: 500,
  predationEfficiency: 600,
  reproductionEfficiency: 700,
  buildEnergyPerUnit: 1,
  reproductionCooldownTicks: 18,
  memoryDecayPerTick: 6,
  maxOrganismsProcessedPerTick: 600,
  interactionRadiusCu: 420,
  inventoryCapacity: 240,
});

/** Merge a partial override over the defaults, keeping every field present and bounded. */
export function resolveSimulationConfig(
  overrides: Partial<SimulationConfig> = {},
): SimulationConfig {
  return Object.freeze({ ...DEFAULT_SIMULATION_CONFIG, ...overrides });
}
