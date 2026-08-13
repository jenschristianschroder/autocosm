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
   *
   * It cannot be set above a convergence point, because measurement showed there is none: growth
   * decelerates but stays strongly positive out to at least tick 2400, and is punctuated rather
   * than convergent. See the default for the trajectories. This is a bound that will eventually
   * bind, not a ceiling above an asymptote.
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
  //
  // Re-measured after the population-ceiling observable landed, and the prediction in the line
  // above held: the asymptote moved 347 -> 431 (seed 7), because organisms that stop burning
  // every turn on a doomed reproduction proposal spend those turns gathering and combining
  // instead.
  //
  // Outgrown a *third* time, by the material-reaction rules, and this time it is recorded rather
  // than fixed. Reactions change composite properties, which changes what heuristics gather and
  // combine, which moves the fixed point again. Seed 7 / worldId `wd-probe` over 2000 ticks:
  //
  //     cap 512     -> 512 materials, last discovery 1640, 3 combine rejections
  //     cap 100 000 -> 514 materials, last discovery 1729, 0 combine rejections
  //
  // So the bound bit at 512, and the regression test's stated invariant — discovery ends
  // *strictly* below the bound — was violated on that trajectory. The alarm did not fire because
  // the test covers two seeds against one worldId (`w-mat`), and worldId alone moves a trajectory
  // as much as a seed does. That coverage gap is the real defect; the 2-material clip is 0.4%.
  //
  // Deliberately raised only to the read-model catalogue cap, not further, because beyond that
  // point it stops being a tuning question:
  //   - 514 is not a converged asymptote. Discovery was still active at tick 1729 of 2000, only
  //     271 ticks of silence, against the 1000-2300 ticks that justified every earlier number
  //     here. Choosing a persistence bound off an unconverged count is the mistake this comment
  //     already records twice, so 576 is taken as *free* headroom rather than as a measured one.
  //   - The catalogue cannot follow it upward indefinitely. Measured at ~1085 bytes for a
  //     worst-case composite DTO, a 1024-material catalogue is ~488 KB typical and ~1.06 MB worst
  //     case on `/world`. 576 (~275 KB) is already near the practical limit for a polled route,
  //     and the catalogue must stay >= this bound or it silently drops an arbitrary alphabetical
  //     tail — taking each dropped material's label *and* its reaction attribution with it, which
  //     is the exact illegibility Phase A spent five commits removing.
  //   - A world of 500+ materials is already past what a spectator can comprehend, so "more
  //     chemistry" is not self-evidently the goal it looks like.
  // Going above 576 therefore trades payload and legibility against open-endedness, and wants a
  // converged measurement plus a *selective* catalogue — one that keeps every material the world
  // currently references rather than an alphabetical prefix — not a larger constant.
  //
  // ---- Both preconditions were then tested. One does not exist; the other was superseded. ----
  //
  // **There is no converged measurement to take.** With the cap lifted to 100 000 and the supply
  // fix below applied, three trajectories were run to 2400 ticks at a pinned population of 420,
  // logging the catalogue every 200 ticks. Growth decelerates and never stops:
  //
  //   tick    4242424/w-mat      7/w-mat        7/wd-probe
  //   800     303 (+105)         280 (+70)      425 (+171)
  //   1200    664 (+175)         523 (+111)     849 (+204)
  //   1600    986 (+151)         766 (+118)     1153 (+117)
  //   2000    1251 (+152)        -              -
  //
  // Still +152 per window at tick 2000, on a world production runs ~7x longer than. This
  // corroborates the 4000-tick probe recorded in `material-discovery.test.ts`: discovery is
  // *punctuated, not convergent* — `wd-probe` posted its single largest window of that entire run
  // (66 discoveries) at tick 3200, after ~800 ticks of near-silence. So the earlier instruction to
  // wait for convergence cannot be satisfied at any horizon, and this constant can only ever be a
  // **bound**, never a ceiling sitting above a known asymptote. Saying so is the point: three
  // separate revisions of this comment treated an unconverged count as an asymptote.
  //
  // **The selective catalogue was built as a decoupling instead, which is strictly better.** The
  // stated requirement — "keep every material the world currently references" — assumed the
  // catalogue is what makes a material legible. Grepping the read model proved that is true for
  // exactly one field, `SnapshotResponse.resources[].materialId`; every detail route already joins
  // labels server-side. That one field now carries `materialLabel`/`materialSubtitle` inline, so
  // truncating the catalogue can no longer render anything as a raw id. The failure mode it was
  // protecting against was also worse than documented: base ids are words and crafted ids are
  // `mx...`, so an alphabetical slice at 576 drops `water`, `silt`, `sand`, `stone`, `resin` and
  // `toxinSac` *first* — precisely what every resource node is made of. The catalogue now sorts
  // base-before-composite and stays at 576 as a browse convenience.
  //
  // So `maxMaterials` is now a **pure simulation and storage bound**, decoupled from `/world`
  // payload entirely. 8192 is chosen against the two limits that remain real:
  //   - `MAX_PER_STORE = 20_000` (`storage/bundle.ts`) caps what a bundle load will drain, and a
  //     truncated materials store is silent corruption. 8192 sits 2.4x below it.
  //   - 5.3x above the highest measured 2400-tick trajectory, so `material-discovery.test.ts`'s
  //     "catalogue <= 90% of the bound" gate has real margin (~1500/7373 = 20%) rather than
  //     passing by a hair.
  // It is not a solved problem. An unbounded process against a fixed bound binds *eventually*, and
  // the only real fix is eviction — rejected earlier because events carry `materialId` and a
  // pruned material takes its label with it, an objection the decoupling above does **not**
  // remove (the label is derived from the record, so evicting the record still loses it). The
  // combine rejection counter in `material-discovery.test.ts` is the alarm for when this binds.
  maxMaterials: 8192,
  maxDecisionsPerTick: 12,
  decisionExpiryTicks: 40,
  minTicksBetweenDecisionsPerLineage: 6,
  minPlanningForDiscretionaryDecision: 40,
  // Raised 60 -> 180 to unprice the creative ladder. Production at tick 13 966 had 0 structures
  // standing and 76 materials after ~14k ticks, while a fresh local world reached 326-455 by tick
  // 4000. The cause is not resource exhaustion and not a mis-ordered branch: every creative rung
  // is gated on surplus energy, branch 6 (feed, `energyRatio < 620`) precedes all of them in a
  // first-match ladder, and a world pinned at `maxOrganisms` has no surplus. Only 5.8% of the
  // production population cleared 620, so `collect` was almost never proposed, carried stock never
  // reached the combine branch's `carried >= 90`, and build — needing surplus *and* a full load —
  // was unreachable twice over.
  //
  // Six paired seeds, 900 ticks, control and treatment run simultaneously from separate worktrees
  // of the same commit (n=1 in this system is noise: an earlier single-seed comparison of an
  // unrelated change read as a catastrophic regression and was contradicted by two other seeds):
  //
  //   metric                control(60)  treatment(180)  ratio  t(5)   seeds favouring
  //   living organisms      148.0        419.5           2.83   20.07  6/6
  //   materials known       159.3        415.7           2.61    5.41  6/6
  //   standing structures    25.2         54.5           2.17    8.48  6/6
  //   structures built       37.2         69.3           1.87    7.37  6/6
  //   combinations          307.0        953.7           3.11    4.59  6/6
  //   share >= 620 energy    52.7%        67.0%          1.27    2.54  6/6
  //   median energy         625          742             1.19    2.48  6/6
  //   lineages                8.5          9.0           1.06    0.89  2/6
  //
  // Significance needs |t| >= 2.571 at df=5; the sign test is 6/6 on every row above (p = 0.031).
  //
  // Two honest caveats, recorded because they argue against the change:
  //   - **The proposed mechanism is the weakest row in the table.** `share >= 620` is the variable
  //     the causal story runs through, and at t=2.54 it is the one result that does *not* clear
  //     the significance threshold. Outcomes are established; the explanation is supported, not
  //     proven, at n=6.
  //   - **Lineage count does not move** (2/6, t=0.89), contradicting the "consolidation ratchet"
  //     an earlier single-arm sweep appeared to show. That reading is withdrawn.
  //
  // Dose-response across four points, including the live world, is monotonic in the share clearing
  // the feed gate — which is why the mechanism is believed despite the caveat above:
  //
  //   world                          share >= 620   materials   standing
  //   production, tick 13 966          5.8%           76           0
  //   local, ceiling 420, regen 60    54.5%          184          14
  //   local, regen 180                87.4%          540          75
  //   local, regen 360                94.0%          576 (capped) 102
  //
  // Production is expected to respond *more* strongly than the local dose-response suggests,
  // because it is pinned at 421/420: extra supply cannot become extra organisms, so it must become
  // per-head wealth, and pinning also blocks branch 5 (reproduce, `> 700`) — the competing sink
  // that would otherwise absorb exactly the organisms rich enough to create.
  //
  // 360 was measured and not taken. It buys a further 6.6 points of share for 2x the supply, and
  // caps the material catalogue outright, so it trades a shrinking return against a world that no
  // longer has scarcity as a selection pressure at all.
  biomassRegenAtFullLight: 180,
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
