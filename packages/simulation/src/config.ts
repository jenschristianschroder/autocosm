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
  /**
   * Hard ceiling on lineages that have at least one living member.
   *
   * Counts the living, like `maxOrganisms` and for the same reason: a cumulative count would
   * permanently stop a world diversifying once this many lineages had ever existed. The bound
   * exists because every lineage competes for the same fixed `maxDecisionsPerTick`, so an
   * unbounded split rate would starve them all of cognition rather than enrich the world.
   */
  readonly maxActiveLineages: number;
  /**
   * Mean absolute genome distance from its lineage's *founding* genome at which a newborn founds
   * its own lineage, on the 0-1000 trait scale.
   */
  readonly speciationDivergence: number;
  /**
   * Living members a lineage needs before it can bud.
   *
   * Keeps a split a sign of success rather than of collapse: without it a lineage down to its
   * last pair would shed splinters that inherit its predicament and immediately die too.
   */
  readonly speciationMinParentPopulation: number;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = Object.freeze({
  maxOrganisms: 420,
  maxDeadOrganismsRetained: 120,
  maxStructures: 160,
  // Measured with the ceiling lifted to 100 000, three trajectories over 3000 ticks: discovery
  // converges and then stays flat, at 147/165/347 materials, with 1000-2300 ticks of complete
  // silence after the last discovery. The reachable combination space still closes on its own, so
  // no eviction is needed — only headroom above the highest natural fixed point.
  //
  // This bound has now been outgrown twice, which is the useful part of the history. At 96 every
  // world was truncated at 40-70% of its own chemistry by tick ~182. At 320 — chosen against a
  // then-highest fixed point of 253 — seed 4242424 was clipped at exactly 320 while its true
  // asymptote is 347. The fixed point tracks living population and region occupancy, both of which
  // the deposit-visibility fix raised sharply (26 -> 137-259 alive, 9 -> 17-23 regions), so 1.26x
  // headroom did not survive a single balance change. 512 is ~1.5x the highest measured asymptote.
  maxMaterials: 512,
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
  maxActiveLineages: 16,
  // Measured drift from the founding genome over 3000 ticks, three seeds: 19->43, 22->56, 14->44,
  // rising steadily throughout. Against the running mean the same births never exceeded 27
  // (median 9), so any threshold above that is unreachable by construction — the mean chases its
  // own population. 40 sits inside the observed drift range without being reached early.
  speciationDivergence: 40,
  speciationMinParentPopulation: 6,
});

/** Merge a partial override over the defaults, keeping every field present and bounded. */
export function resolveSimulationConfig(
  overrides: Partial<SimulationConfig> = {},
): SimulationConfig {
  return Object.freeze({ ...DEFAULT_SIMULATION_CONFIG, ...overrides });
}
