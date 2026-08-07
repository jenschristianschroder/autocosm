# Domain model

Everything in this document is implemented and covered by tests in `packages/domain` and
`packages/simulation`. Source of truth is the code; this is the explanation.

---

## 1. Units

Every authoritative quantity is an **integer**. Integer arithmetic keeps ticks bit-for-bit
reproducible across machines and Node.js versions. Floating point exists only in the browser, for
presentation.

| Symbol | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| `cu`   | centi-unit of length. 100 cu = 1 world unit, rendered as roughly one metre. |
| `eu`   | energy unit. Metabolism, movement and construction are all priced in `eu`.  |
| `mu`   | material unit. Mass and material quantities are counted in `mu`.            |
| `hp`   | health point.                                                               |
| `‰`    | per-mille, `0..1000`. Traits, material properties and every ratio use this. |
| `tick` | one logical simulation step. The wall-clock mapping is configuration.       |

`clamp`, `clampPerMille`, `scaleByPerMille`, `lerpPerMille` and `isqrt` in
`packages/domain/src/units.ts` are the only arithmetic helpers the simulation uses. `NaN` collapses
to the lower bound rather than propagating, so one corrupted upstream value cannot poison a tick.

---

## 2. The three kinds of change

These are deliberately distinct mechanisms with distinct storage and distinct rules. Conflating them
is the classic way to make an "evolution" simulation that is really just a levelling system.

| Kind                   | Lives on | Changes when                   | Inherited?                               |
| ---------------------- | -------- | ------------------------------ | ---------------------------------------- |
| **Genotype**           | organism | reproduction, via mutation     | yes — this is the only heritable channel |
| **Lifetime state**     | organism | continuously, during a life    | no — dies with the organism              |
| **Cultural knowledge** | lineage  | when it is taught and received | no — _transmitted_, not inherited        |

Cultural transmission is not free. A lineage can only teach when it has evolved enough
`signalStrength` to emit a `teach` signal at useful radius, and can only receive when it has enough
`memoryCapacity` to hold the design. A lineage that discovers a good material combination and then
goes extinct without having evolved communication takes the knowledge with it. That is intentional
and observable in the event history as a `materialCombined` with no subsequent `knowledgeShared`.

---

## 3. Traits

24 heritable traits across 8 categories. Every trait has a stated benefit **and** a stated cost, and
`upkeepAtFull + massAtFull > 0` for all 24 — enforced by a regression test so a future "free" trait
cannot silently create a linear upgrade ladder.

| Category     | Trait                    | Upkeep `eu` | Mass `mu` | Seed ‰ | Suppresses             |
| ------------ | ------------------------ | ----------: | --------: | -----: | ---------------------- |
| metabolism   | `metabolicRate`          |           9 |         0 |    400 | longevity              |
| metabolism   | `energyReserve`          |           3 |        90 |    300 | motility               |
| metabolism   | `photosynthesis`         |           2 |        40 |    250 | motility, camouflage   |
| metabolism   | `thermalTolerance`       |           6 |        30 |    200 | —                      |
| metabolism   | `toxinResistance`        |           5 |        20 |    150 | regeneration           |
| movement     | `motility`               |           7 |        40 |    350 | photosynthesis         |
| movement     | `buoyancy`               |           2 |        10 |    500 | armor                  |
| movement     | `bodySize`               |           8 |       220 |    250 | camouflage             |
| sensing      | `photoreception`         |           4 |        10 |    200 | —                      |
| sensing      | `chemoreception`         |           4 |         8 |    250 | —                      |
| sensing      | `perceptionRange`        |           8 |        14 |    220 | —                      |
| defence      | `armor`                  |           5 |       160 |    150 | motility, regeneration |
| defence      | `regeneration`           |           7 |        10 |    200 | —                      |
| defence      | `camouflage`             |           3 |         6 |    200 | signalStrength         |
| social       | `aggression`             |           4 |        20 |    200 | sociality              |
| social       | `sociality`              |           3 |         8 |    250 | aggression             |
| social       | `signalStrength`         |           4 |         8 |    180 | camouflage             |
| cognition    | `memoryCapacity`         |           9 |        24 |    150 | —                      |
| cognition    | `learningRate`           |           6 |        10 |    150 | —                      |
| cognition    | `planningDepth`          |          14 |        30 |     80 | —                      |
| manipulation | `manipulation`           |           6 |        34 |    120 | motility               |
| lifeHistory  | `reproductiveInvestment` |           2 |        16 |    400 | —                      |
| lifeHistory  | `mutability`             |           1 |         0 |    300 | longevity              |
| lifeHistory  | `longevity`              |           5 |        12 |    300 | metabolicRate          |

### How the tradeoff actually bites

Three mechanisms, all in `packages/simulation/src/resolve.ts` and `tick.ts`:

1. **Upkeep.** Every tick an organism pays `Σ scaleByPerMille(upkeepAtFull, expression)` in `eu`,
   whether or not the trait is used. Insulation costs the same in mild weather.
2. **Mass.** `Σ scaleByPerMille(massAtFull, expression)` is carried mass. Mass divides effective
   movement speed and multiplies movement cost. An armoured organism is genuinely slower, not
   nominally slower.
3. **Suppression.** A trait listed in `suppresses` has its _effectiveness_ reduced in proportion to
   the suppressor's expression. `armor` at 800‰ does not just add mass — it actively degrades
   `motility` and `regeneration`. This is what makes the trait space non-monotonic: you cannot
   maximise everything, and the local optimum genuinely depends on the biome.

### Intelligence is emergent, not selectable

`planningDepth` is the most expensive trait in the catalogue (14 `eu` upkeep, 30 `mu` mass) and has
the lowest seed value (80‰). On its own it does nothing useful at all. It only becomes valuable
when the organism _also_ has:

- `perceptionRange` and at least one of `photoreception` / `chemoreception`, or there is nothing to
  plan about;
- `memoryCapacity`, or there is nowhere to keep the plan between ticks;
- `signalStrength` and `sociality`, or the plan cannot involve anyone else;
- surplus energy, or the upkeep kills the organism before the plan pays off.

`capabilities.ts` encodes this as hard gates: `repurpose` requires `minPlanning: 120` **and**
`minManipulation: 400` **and** `minMemorySlots: 3`. An organism that evolved planning alone simply
cannot act on it. Cognition has to be paid for by a supporting body plan, which is exactly the
constraint real cognition operates under.

---

## 4. Materials

Materials are property vectors, not names. 8 composable properties, all in per-mille:

`hardness`, `flexibility`, `adhesion`, `conductivity`, `toxicity`, `photosensitivity`, `porosity`,
`density`.

14 base materials seed the world across four origins:

| Origin    | Materials                                                                      |
| --------- | ------------------------------------------------------------------------------ |
| `fluid`   | `water`                                                                        |
| `mineral` | `silt`, `sand`, `clay`, `stone`, `mineralSalt`, `lightCrystal`                 |
| `organic` | `biofilm`, `fibre`, `chitin`, `resin`, `algaeMat`, `toxinSac`, `carapaceShard` |

Each also carries `nutritionPerUnit` in `eu` per `mu` — zero for inedible matter, which is what
makes `stone` a building material and `algaeMat` a food.

### Combination

`combine` blends component property vectors by volume (`blendProperties`), then applies a small
pattern-dependent bonus. The result is a **new material definition** with `derivedFrom` and
`discoveredAtTick` recorded, stored in the world's material table and available to anyone who can
observe it. Two lineages that independently discover the same combination get the same properties —
the blend is a pure function — but each records its own discovery event.

There is no recipe list. Any combination is legal; most are useless. `fibre` + `resin` produces
something with high adhesion and moderate flexibility, which happens to satisfy the `snare` rule.
Nobody wrote that down as a recipe; it falls out of the property arithmetic.

### Naming

A composite's name is **derived**, never proposed. `deriveMaterialName` (`domain/naming.ts`) reads
the finished property vector and origin and produces a label and a one-line description — _"Pliant
Resinweave"_, _"Very adhesive and flexible organic material. Not edible."_ The noun encodes the
dominant property, the adjective the runner-up, so the name carries two checkable facts rather than
flavour text. Word choice is indexed by an avalanche-mixed FNV-1a hash of the material id against a
static, versioned table, so the same material is called the same thing in every process and on every
replay. The mixing step matters: composites cluster on a handful of property pairs, so the id hash is
what actually separates them, and indexing a word list with FNV-1a's weakly-distributed low bits
produced a world in which only 23% of composite names were distinct.

`combine` therefore takes no label. Agent-supplied names compounded across generations into
unreadable identifiers (`mx1a2b3c-mxf9e8d7`) and were untrusted text flowing into a display string.
Because the label is a pure function, the persisted value is a self-healing cache: `MaterialRecord`
re-derives it on read for anything with `derivedFrom`, so a name can never drift out of step with the
thing it names. Primordial materials keep their hand-authored names.

Labels are decoration and are never matched on — recipes are content-addressed by
`deriveRecipeKey(components)`, which is what makes it safe to rename every material in the world.

---

## 5. Structures

A structure records: `components`, `pattern`, `properties` (blended), `volume`, `integrity`,
`createdByAgentId` / `createdByLineageId` / `createdByOrganismId`, `createdAtTick`,
`lastChangedAtTick`, `position`, `regionId`, `label`, and a **bounded ring buffer** of `usage`
records (max 12, so the stored entity cannot grow without limit).

### Function is derived, never declared

This is the heart of the "agents propose, the world decides" invariant.

`deriveStructureFunctions(components, pattern, volume)` blends the component properties and then
evaluates 10 independent rules. Each rule states a physical requirement:

| Function    | Requires                                                             |
| ----------- | -------------------------------------------------------------------- |
| `shelter`   | pattern `shell`/`lattice`, `hardness ≥ 420`, `volume ≥ 120`          |
| `barrier`   | pattern `lattice`/`shell`/`anchor`, `hardness ≥ 600`, `volume ≥ 200` |
| `snare`     | pattern `snare`/`mesh`, `adhesion ≥ 600`                             |
| `conduit`   | pattern `conduit`/`lattice`, `conductivity ≥ 500`                    |
| `beacon`    | pattern `beacon`, `photosensitivity` threshold                       |
| `reservoir` | pattern `vessel`, `porosity` threshold                               |
| `filter`    | `porosity` and `flexibility` thresholds                              |
| `nursery`   | `shelter`-like properties plus low `toxicity`                        |
| `toxinWard` | `toxicity` threshold                                                 |
| `anchor`    | pattern `anchor`, `density` and `adhesion` thresholds                |

If the blended properties do not meet the requirement, **the function does not exist**, regardless
of what the builder intended, what the model said, or what the label claims. A model can propose
`build` with a `label` of "impregnable fortress"; if the components blend to `hardness: 180` the
structure has no `shelter` function and no `barrier` function, and the label is just a label.
Functions with zero magnitude are never recorded at all.

`MIN_STRUCTURE_VOLUME = 40 mu`: below that, a pile of matter is a pile of matter.

### What other agents can do with it

Structures are world objects, not private property. Another lineage may `inspect` it (learning its
components if their `memoryCapacity` allows), shelter in it, harvest from it, damage it, repair it,
or `repurpose` it into something else — subject entirely to their own evolved capabilities and
whether they can actually see it. `structureUsed`, `structureDamaged`, `structureRepurposed` and
`structureCollapsed` events record all of it against the lineage responsible.

---

## 6. Actions

14 action types. An agent proposes; the simulation resolves.

`move`, `consume`, `attack`, `signal`, `attach`, `share`, `reproduce`, `expressTrait`, `collect`,
`combine`, `build`, `inspect`, `repurpose`, `rest`.

### Capability gates

Seven actions are gated on evolved capability, checked before anything else:

| Action      | Requires                                                      |
| ----------- | ------------------------------------------------------------- |
| `collect`   | `manipulation ≥ 120`                                          |
| `combine`   | `manipulation ≥ 220`, ≥ 2 memory slots                        |
| `build`     | `manipulation ≥ 250`, ≥ 2 memory slots                        |
| `repurpose` | `manipulation ≥ 400`, ≥ 3 memory slots, `planningDepth ≥ 120` |
| `signal`    | signal radius ≥ 200 `cu` (derived from `signalStrength`)      |
| `inspect`   | ≥ 1 memory slot                                               |
| `reproduce` | maturity                                                      |

### Rejection

16 explicit rejection reasons, every one of which produces an `actionRejected` event with the reason
attached, so a rejected proposal is visible in the timeline rather than silently dropped:

`unknownTarget`, `outOfRange`, `notVisible`, `insufficientEnergy`, `insufficientMaterial`,
`capabilityNotEvolved`, `onCooldown`, `notMature`, `targetDead`, `selfTarget`, `staleWorldVersion`,
`inventoryFull`, `notOwner`, `malformed`, `rateLimited`, `actionUnavailable`.

`staleWorldVersion` deserves a note: a proposal is generated against an observation from tick _N_
and may not be resolved until tick _N+k_. If the world moved enough that the proposal no longer
makes sense, it is rejected rather than force-fitted. The agent's picture of the world is allowed to
be out of date, because that is what having limited perception means.

---

## 7. Observation

An agent never sees the world. It sees an `Observation`: its own state, and a bounded, filtered view
of what is within its perception radius.

- **Radius** comes from `perceptionRange`, modulated by which sense the organism actually has. A
  chemoreceptive organism perceives a different set of things than a photoreceptive one at the same
  radius, and neither perceives everything.
- **Camouflage** hides an organism from observers whose sensing does not beat it.
- **Caps.** `MAX_OBSERVED_RESOURCES` and equivalent caps on organisms, structures, signals and
  memories bound the observation regardless of how crowded the region is. This is both a prompt-cost
  control and a design statement: an agent cannot brute-force awareness.
- **No global state.** There is no world-wide organism count, no leaderboard, no "nearest food
  anywhere" in an observation. `packages/simulation/src/observe.ts` builds it from spatial queries
  only.

The observation is computed by the simulation during the tick and **embedded in the pending decision
record**. That is why `agent-think` never needs read access to world tables.

---

## 8. Memory

Memory slots are derived from `memoryCapacity`. Each slot holds one bounded memory: a location, a
material, a structure, an organism, or a learned design. When slots are full, the lowest-salience
memory is evicted — deterministically, by a documented ordering, never randomly.

`learningRate` controls how fast a memory's salience rises with reinforcement. High `learningRate`
with low `memoryCapacity` produces an organism that learns quickly and forgets quickly, which is a
real and sometimes viable strategy.

Memories are **not** inherited. A newborn starts empty. Knowledge crosses generations only through
the cultural channel — a `teach` signal received by an organism with a free slot — which is why
`signalStrength` and `sociality` matter far more than they look.

---

## 9. Evolution

Reproduction is the only heritable channel.

1. **Cost.** The parent pays energy proportional to `reproductiveInvestment`. High investment
   produces a better-provisioned offspring and can kill the parent outright.
2. **Inheritance.** The offspring genotype starts as a copy of the parent's.
3. **Mutation.** Each trait is perturbed by a seeded draw whose magnitude scales with the parent's
   `mutability`. Results are clamped to `[0, 1000]` — a regression test asserts no mutation escapes
   the per-mille range regardless of seed or generation depth.
4. **Lineage.** The offspring joins the parent's lineage and gets a `LineageNode` recording parent,
   generation and birth tick. `organismBorn` carries the generation number.
5. **Speciation.** If the offspring's genotype has drifted far enough from its lineage's _founding_
   genome, it founds a new lineage of its own instead — see below.
6. **Identity survives.** The _agent_ persists through descendants. When an individual organism
   dies, the agent continues in its living descendants. `lineageExtinct` fires only when the last
   organism of a lineage dies — and it is genuinely final.

`mutability` itself is heritable and suppresses `longevity`. A lineage that evolves high mutability
adapts faster and dies younger, which is a real evolutionary tradeoff rather than a dial.

### Speciation

Before the change that introduced it, lineage count was a **strict ratchet that only ever fell**:
worldgen created the founders and nothing in the simulation ever created another, so every extinction
was permanent loss. Measured over 3000 ticks, seeded worlds decayed 8 → 2 active lineages, and the
deployed world had reached a single lineage with nine extinct by tick 5774. Cross-lineage cultural
transmission was not merely rare there, it was definitionally impossible.

A newborn founds its own lineage when three gates pass together (`speciation.ts`):

1. Its genotype diverges from `parentLineage.foundingGenotype` by at least
   `speciationDivergence` — mean absolute per-trait difference on the 0–1000 scale.
2. The parent lineage holds at least `speciationMinParentPopulation` living members, so a
   collapsing lineage splits rather than survives.
3. Fewer than `maxActiveLineages` lineages currently hold living members.

**Divergence is measured against the founding genome, never the running mean.** `updateLineages`
recomputes `meanGenotype` from living members every tick, so the mean follows its own population: a
newborn sits a flat p50 = 9 / max = 27 from it whether the world has run 500 ticks or 3000, while
distance from a fixed founding genome grows steadily to 43–56 over the same span. A mean-relative
threshold is therefore unreachable at every point in the space — the same defect shape as
`decayPerTick` promising permanence. `meanGenotype` stays presentation-only.

A splinter gets its **own agent**, deep-copying the parent's knowledge so culture passes vertically
and then diverges. `maxDecisionsPerTick` is a global cap, so additional agents cost no model spend.
Ids derive from the child organism id, which is already deterministic in `(worldId, tick, ordinal)`,
so replay reconstructs the same lineage tree. The splinter is named for its furthest-drifted trait —
`Mending Grazers`, `Warded Hunters` — so the reason for the split is legible in the name.

---

## 10. Events

26 event kinds form the append-only world history:

`agentCreated`, `organismBorn`, `organismDied`, `organismMigrated`, `organismFed`,
`organismAttacked`, `energyShared`, `signalEmitted`, `traitExpressed`, `materialDiscovered`,
`materialCombined`, `structureBuilt`, `structureUsed`, `structureDamaged`, `structureRepaired`,
`structureRepurposed`, `structureCollapsed`, `knowledgeShared`, `goalSubmitted`, `goalConsidered`,
`environmentalPressure`, `decisionRequested`, `decisionResolved`, `actionRejected`,
`lineageExtinct`, `lineageFounded`.

Every event carries `id`, `version`, `worldId`, `regionId`, `tick`, `ordinal`, `kind`, an optional
`agentId` / `lineageId` / `organismId`, optional `causationId` / `correlationId`, a `summary` capped
at 180 characters, and a compact validated payload.

Three properties matter:

- **Idempotent.** `id = eventIdFor(worldId, tick, ordinal)` is pure, so replaying tick _N_ rewrites
  the same rows instead of duplicating history.
- **Totally ordered.** `(tick, ordinal)` gives a total order, which is what makes replay meaningful.
- **No hidden reasoning.** A model's chain of thought is never stored. `decisionResolved` records
  the action type, the outcome and a safe bounded summary. `observability.test.ts` asserts the
  redaction.

---

## 11. Drives and goals

Six drives, each weighted per agent at creation: `survive`, `forage`, `reproduce`, `explore`,
`cooperate`, `build`. Drives shape both the heuristic policy and the prompt.

A creator-submitted goal is a bounded string attached to the agent with a status. It enters the
prompt as an _unresolved aspiration_, and it enters the heuristic policy as a bias on drive weights.
It is never a command. `goalConsidered` records that the agent weighed it; the goal may remain
unresolved for its entire life, and an agent whose drives point elsewhere may simply never act on
it. Goals are immutable once submitted, rate-limited per creator per day, and recorded in the event
history as `goalSubmitted`.

Agent creation takes: `name`, `visualSeed`, one of 5 habitat preferences (`abyss`, `shallows`,
`shore`, `plain`, `highland`), drive weights, one of 5 temperaments (`cautious`, `balanced`, `bold`,
`gregarious`, `solitary`), one of 3 sensory biases (`light`, `chemical`, `balanced`), and a broad
aspiration string. All of it shapes the _starting nature_ of a basic cell. None of it guarantees
survival, and a badly matched habitat preference is a real way to lose a lineage in the first
hundred ticks.
