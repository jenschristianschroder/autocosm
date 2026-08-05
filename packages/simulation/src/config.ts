/**
 * Bounded simulation knobs.
 *
 * Every limit here exists to keep a tick cheap, deterministic and finite. Nothing in the
 * engine may loop without a bound drawn from this configuration.
 */
export interface SimulationConfig {
  /** Hard population ceiling. Reproduction is refused above this count. */
  readonly maxOrganisms: number;
  /** Hard ceiling on persistent constructions. */
  readonly maxStructures: number;
  /** Hard ceiling on derived material definitions, keeping the catalogue bounded. */
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
  maxStructures: 160,
  maxMaterials: 96,
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
