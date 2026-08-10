import { type MaterialId, asMaterialId } from './ids.js';
import { deriveMaterialName } from './naming.js';
import { type Mu, type PerMille, clampPerMille, toInt } from './units.js';

/**
 * Materials and their composable physical properties.
 *
 * Nothing in the world "is a tool". A structure's capabilities are *derived* from the
 * measured properties of the materials it is made from and the pattern it was assembled
 * in. A model can propose a combination; only {@link deriveStructureFunctions} decides
 * what the result can actually do.
 */
export const MATERIAL_PROPERTY_IDS = [
  'hardness',
  'flexibility',
  'adhesion',
  'conductivity',
  'toxicity',
  'photosensitivity',
  'porosity',
  'density',
] as const;

export type MaterialPropertyId = (typeof MATERIAL_PROPERTY_IDS)[number];

/** Property vector in per-mille. */
export type MaterialProperties = Readonly<Record<MaterialPropertyId, PerMille>>;

export type MaterialOrigin = 'mineral' | 'organic' | 'fluid' | 'composite';

export interface MaterialDefinition {
  readonly id: MaterialId;
  readonly label: string;
  readonly origin: MaterialOrigin;
  readonly properties: MaterialProperties;
  /** Energy released per `mu` when consumed as food, in `eu`. Zero for inedible matter. */
  readonly nutritionPerUnit: number;
  /** Ingredients, when this material was produced by combination rather than found. */
  readonly derivedFrom?: readonly MaterialComponent[];
  /** Tick at which a derived material first came into existence. */
  readonly discoveredAtTick?: number;
}

export interface MaterialComponent {
  readonly materialId: MaterialId;
  readonly quantity: Mu;
}

function props(partial: Partial<Record<MaterialPropertyId, number>>): MaterialProperties {
  const out: Partial<Record<MaterialPropertyId, PerMille>> = {};
  for (const id of MATERIAL_PROPERTY_IDS) {
    out[id] = clampPerMille(partial[id] ?? 0);
  }
  return Object.freeze(out as Record<MaterialPropertyId, PerMille>);
}

function material(
  id: string,
  label: string,
  origin: MaterialOrigin,
  nutritionPerUnit: number,
  partial: Partial<Record<MaterialPropertyId, number>>,
): MaterialDefinition {
  return Object.freeze({
    id: asMaterialId(id),
    label,
    origin,
    nutritionPerUnit,
    properties: props(partial),
  });
}

/** Materials present in a freshly generated world. */
export const BASE_MATERIALS: readonly MaterialDefinition[] = Object.freeze([
  material('water', 'Water', 'fluid', 0, { flexibility: 1000, porosity: 1000, density: 500 }),
  material('silt', 'Silt', 'mineral', 2, {
    hardness: 120,
    adhesion: 300,
    porosity: 700,
    density: 600,
  }),
  material('sand', 'Sand', 'mineral', 0, {
    hardness: 300,
    adhesion: 60,
    porosity: 800,
    density: 650,
  }),
  material('clay', 'Clay', 'mineral', 0, {
    hardness: 250,
    adhesion: 780,
    flexibility: 420,
    porosity: 200,
    density: 700,
  }),
  material('stone', 'Stone', 'mineral', 0, {
    hardness: 900,
    porosity: 80,
    conductivity: 120,
    density: 950,
  }),
  material('mineralSalt', 'Mineral salt', 'mineral', 4, {
    hardness: 400,
    conductivity: 820,
    porosity: 300,
    toxicity: 180,
    density: 700,
  }),
  material('lightCrystal', 'Light crystal', 'mineral', 0, {
    hardness: 820,
    photosensitivity: 900,
    conductivity: 640,
    porosity: 60,
    density: 800,
  }),
  material('biofilm', 'Biofilm', 'organic', 6, {
    adhesion: 900,
    flexibility: 800,
    porosity: 600,
    density: 350,
  }),
  material('fibre', 'Fibre', 'organic', 3, {
    hardness: 220,
    flexibility: 880,
    adhesion: 200,
    density: 300,
  }),
  material('chitin', 'Chitin', 'organic', 1, {
    hardness: 700,
    flexibility: 300,
    porosity: 120,
    density: 500,
  }),
  material('resin', 'Resin', 'organic', 2, {
    adhesion: 950,
    flexibility: 500,
    porosity: 60,
    density: 400,
  }),
  material('algaeMat', 'Algae mat', 'organic', 8, {
    photosensitivity: 800,
    flexibility: 700,
    porosity: 500,
    density: 320,
  }),
  material('toxinSac', 'Toxin sac', 'organic', 1, { toxicity: 950, porosity: 400, density: 380 }),
  material('carapaceShard', 'Carapace shard', 'organic', 1, {
    hardness: 780,
    flexibility: 120,
    porosity: 100,
    density: 700,
  }),
]);

export const BASE_MATERIAL_IDS: readonly MaterialId[] = Object.freeze(
  BASE_MATERIALS.map((m) => m.id),
);

/** Lookup helper over an arbitrary material catalogue. */
export function indexMaterials(
  materials: readonly MaterialDefinition[],
): ReadonlyMap<MaterialId, MaterialDefinition> {
  return new Map(materials.map((m) => [m.id, m]));
}

/**
 * Volume-weighted mean of the component property vectors.
 *
 * This is the only route from "some stuff" to "measured properties". It is deliberately boring:
 * adhesion cannot appear from nowhere just because an agent called its creation a trap.
 *
 * Note what "boring" costs. A weighted mean is a *convex* combination, so the blend always lands
 * inside the convex hull of its inputs and never outside it. On its own that makes the reachable
 * property space closed and shrinking. {@link combineMaterials} therefore applies reaction rules on
 * top of this blend; see {@link REACTIONS} for why, and why the escape has to be earned.
 */
export function blendProperties(
  components: readonly MaterialComponent[],
  catalogue: ReadonlyMap<MaterialId, MaterialDefinition>,
): MaterialProperties {
  const totals: Record<MaterialPropertyId, number> = {
    hardness: 0,
    flexibility: 0,
    adhesion: 0,
    conductivity: 0,
    toxicity: 0,
    photosensitivity: 0,
    porosity: 0,
    density: 0,
  };
  let volume = 0;
  for (const component of components) {
    const definition = catalogue.get(component.materialId);
    if (!definition) continue;
    const q = Math.max(0, toInt(component.quantity));
    if (q === 0) continue;
    volume += q;
    for (const id of MATERIAL_PROPERTY_IDS) {
      totals[id] += definition.properties[id] * q;
    }
  }
  if (volume === 0) return props({});
  const out: Partial<Record<MaterialPropertyId, PerMille>> = {};
  for (const id of MATERIAL_PROPERTY_IDS) {
    out[id] = clampPerMille(Math.trunc(totals[id] / volume));
  }
  return Object.freeze(out as Record<MaterialPropertyId, PerMille>);
}

/**
 * Reduce a component list to its one canonical form: duplicates merged, then ordered by id.
 *
 * Content addressing is only stable if the input is canonical first, so every identity derived
 * from ingredients normalises before hashing.
 */
export function normaliseComponents(
  components: readonly MaterialComponent[],
): readonly MaterialComponent[] {
  const merged = new Map<MaterialId, number>();
  for (const component of components) {
    const quantity = Math.max(0, toInt(component.quantity));
    merged.set(component.materialId, (merged.get(component.materialId) ?? 0) + quantity);
  }
  return [...merged.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([materialId, quantity]) => ({ materialId, quantity }));
}

/**
 * Content-addressed identity for a derived material.
 *
 * The same ingredients always yield the same id, so a composite rediscovered independently by two
 * lineages converges on a single material rather than two indistinguishable ones. Ordering and
 * duplication in the proposal cannot change the result.
 */
export function deriveMaterialId(components: readonly MaterialComponent[]): MaterialId {
  const parts = normaliseComponents(components)
    .map((c) => `${c.materialId}x${c.quantity}`)
    .join('_');
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i += 1) {
    hash ^= parts.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return asMaterialId(`mx${(hash >>> 0).toString(36)}`);
}

/**
 * Stable identity for a recipe: a recipe is identified by what it produces.
 *
 * Recipes are matched, taught and deduplicated by this key and **never** by their label. A label is
 * display text that may be rewritten at any time; matching on it would silently sever knowledge
 * transmission and diverge replay the moment naming changed.
 */
export function deriveRecipeKey(components: readonly MaterialComponent[]): string {
  return deriveMaterialId(components);
}

/** Total volume of a component list, in `mu`. */
export function totalVolume(components: readonly MaterialComponent[]): Mu {
  let volume = 0;
  for (const component of components) {
    volume += Math.max(0, toInt(component.quantity));
  }
  return volume;
}

export const REACTION_IDS = [
  'sintering',
  'tempering',
  'vitrifying',
  'concentrating',
  'phosphorescing',
  'rendering',
] as const;

export type ReactionId = (typeof REACTION_IDS)[number];

interface PropertyReactionRule {
  readonly id: ReactionId;
  readonly label: string;
  readonly summary: string;
  readonly requirement: string;
  readonly first: MaterialPropertyId;
  readonly firstThreshold: number;
  readonly second: MaterialPropertyId;
  readonly secondThreshold: number;
  readonly target: MaterialPropertyId;
  /** Applied to the *smaller* of the two excesses, in per-mille of it. */
  readonly gainPerMille: number;
}

/**
 * Reactions: the only route by which a composite can exceed its own ingredients.
 *
 * {@link blendProperties} is a volume-weighted mean, and a weighted mean is a convex combination:
 * its result always lies inside the convex hull of its inputs. Because composites feed composites,
 * that made the reachable property space a closed set that could only ever shrink toward its own
 * centroid. A property carried by a small minority of materials — conductivity by 3 of the 14 base
 * materials, toxicity by 2, photosensitivity by 2 — was therefore *annihilated* by the first
 * blending step and could never return. Three of the ten structure functions (`conduit`, `beacon`,
 * `toxinWard`) require exactly those properties above 500, so crafting made a species strictly less
 * capable than gathering: no composite could ever qualify for them.
 *
 * A reaction fires on a *pair* of properties and pays out on the smaller of the two excesses. That
 * shape is the whole design:
 *
 * - Both drivers must genuinely be present, so diluting a potent ingredient destroys the reaction
 *   rather than spreading it. Concentration is the only way to profit.
 * - The gain is proportional to the excess, not a step at the threshold, so the gradient is
 *   discoverable by hill-climbing rather than being a cliff that must be hit exactly.
 * - The payout can exceed the maximum of the inputs, which is what lets the reachable set *grow*.
 *   Escaping typically demands a prior composite that already combines two traits no base material
 *   holds together, so open-endedness comes from building on earlier discoveries.
 *
 * Every rule reads the same immutable blend, so the set is commutative and order-independent.
 *
 * **Measured, and only half of this table is live.** Seed 7 over 2000 ticks produced 500 composites;
 * 67% of them carry at least one reaction, so hull escape genuinely happens rather than being a
 * theoretical property. But the firings are concentrated in two rules, and three never fire at all:
 *
 *     rendering 221 · sintering 115 · tempering 3 · vitrifying 0 · concentrating 0 · phosphorescing 0
 *
 * That is *not* unreachability. Sweeping all ordered base-material pairs across six quantity ratios
 * (1092 combinations) fires every rule: vitrifying 103, phosphorescing 97, concentrating 10. The
 * three dead rules are reachable and simply never reached, because combination is blind — the
 * heuristic takes `self.inventory[0]` and `[1]`, whichever two materials gather order happened to
 * leave in the first slots, at half of each. It never selects a pair *for* what the pair would
 * produce, even though every inventory entry already carries `hardness` and `density` for exactly
 * that kind of choice.
 *
 * So reactions widen the reachable space and the world then samples it by accident. Directed
 * combination is the follow-up that would make the other half of this table matter; until then,
 * expect roughly two live reactions rather than six.
 */
const REACTIONS: readonly PropertyReactionRule[] = [
  {
    id: 'sintering',
    label: 'Sintering',
    summary: 'Dense hard grains fuse under their own weight into something harder than either.',
    requirement: 'Blended hardness above 450 and density above 450.',
    first: 'hardness',
    firstThreshold: 450,
    second: 'density',
    secondThreshold: 450,
    target: 'hardness',
    gainPerMille: 900,
  },
  {
    id: 'tempering',
    label: 'Tempering',
    summary: 'A springy matrix around a hard filler keeps the give that blending would flatten.',
    requirement: 'Blended hardness above 350 and flexibility above 350.',
    first: 'hardness',
    firstThreshold: 350,
    second: 'flexibility',
    secondThreshold: 350,
    target: 'flexibility',
    gainPerMille: 800,
  },
  {
    id: 'vitrifying',
    label: 'Vitrifying',
    summary: 'Light-bearing crystal locked into a hard body carries a current along its lattice.',
    requirement: 'Blended hardness above 400 and photosensitivity above 250.',
    first: 'hardness',
    firstThreshold: 400,
    second: 'photosensitivity',
    secondThreshold: 250,
    target: 'conductivity',
    gainPerMille: 1400,
  },
  {
    id: 'concentrating',
    label: 'Concentrating',
    summary: 'A binder holds toxin in place instead of letting the mixture thin it away.',
    requirement: 'Blended toxicity above 250 and adhesion above 300.',
    first: 'toxicity',
    firstThreshold: 250,
    second: 'adhesion',
    secondThreshold: 300,
    target: 'toxicity',
    gainPerMille: 1400,
  },
  {
    id: 'phosphorescing',
    label: 'Phosphorescing',
    summary: 'A conductive path feeds the light-sensitive fraction until the whole body glows.',
    requirement: 'Blended photosensitivity above 250 and conductivity above 250.',
    first: 'photosensitivity',
    firstThreshold: 250,
    second: 'conductivity',
    secondThreshold: 250,
    target: 'photosensitivity',
    gainPerMille: 1400,
  },
];

/** Public projection for the glossary. Formulas stay private; requirements do not. */
export const MATERIAL_REACTION_RULES: readonly {
  readonly id: ReactionId;
  readonly label: string;
  readonly summary: string;
  readonly requirement: string;
}[] = Object.freeze([
  ...REACTIONS.map((rule) => ({
    id: rule.id,
    label: rule.label,
    summary: rule.summary,
    requirement: rule.requirement,
  })),
  {
    id: 'rendering' as const,
    label: 'Rendering',
    summary:
      'Edible matter kept edible: a mild, open composite retains the food value it was made from.',
    requirement: 'Finished toxicity at most 150 and porosity at least 200.',
  },
]);

/** Per-property boost produced by the reaction set, and which reactions produced it. */
function deriveReactionBoosts(blend: MaterialProperties): {
  readonly boosts: Readonly<Partial<Record<MaterialPropertyId, number>>>;
  readonly fired: readonly ReactionId[];
} {
  const boosts: Partial<Record<MaterialPropertyId, number>> = {};
  const fired: ReactionId[] = [];
  for (const rule of REACTIONS) {
    const firstExcess = blend[rule.first] - rule.firstThreshold;
    const secondExcess = blend[rule.second] - rule.secondThreshold;
    if (firstExcess <= 0 || secondExcess <= 0) continue;
    const gain = Math.trunc((Math.min(firstExcess, secondExcess) * rule.gainPerMille) / 1000);
    if (gain <= 0) continue;
    boosts[rule.target] = (boosts[rule.target] ?? 0) + gain;
    fired.push(rule.id);
  }
  return { boosts, fired };
}

/**
 * Which reactions a set of ingredients would trigger.
 *
 * Recomputed from the ingredients rather than stored, so a material's explanation can never drift
 * out of step with the rules that actually produced it.
 */
export function reactionsForComponents(
  components: readonly MaterialComponent[],
  catalogue: ReadonlyMap<MaterialId, MaterialDefinition>,
): readonly ReactionId[] {
  if (totalVolume(components) <= 0 || components.length < 2) return Object.freeze([]);
  const blend = blendProperties(components, catalogue);
  const { boosts, fired } = deriveReactionBoosts(blend);
  const properties = finishProperties(blend, boosts);
  const out = [...fired];
  if (retainsNutrition(properties)) out.push('rendering');
  return Object.freeze(out);
}

/**
 * The reactions that actually produced a stored material, or none when that cannot be established.
 *
 * Materials persist and are content-addressed by their ingredients, so a world can hold composites
 * created before reactions existed. Recomputing from ingredients alone would happily attribute a
 * reaction to a material it never applied to — an explanation that is confidently wrong, which is
 * worse than no explanation at all. So the attribution is only made when recombining the stored
 * ingredients reproduces the properties the material actually carries. Anything else is legacy, and
 * the honest answer there is silence.
 */
export function explainedReactions(
  material: MaterialDefinition,
  catalogue: ReadonlyMap<MaterialId, MaterialDefinition>,
): readonly ReactionId[] {
  const components = material.derivedFrom;
  if (!components || components.length < 2) return Object.freeze([]);
  const recomputed = combineMaterials(
    material.id,
    components,
    catalogue,
    material.discoveredAtTick ?? 0,
  );
  if (!recomputed) return Object.freeze([]);
  if (recomputed.nutritionPerUnit !== material.nutritionPerUnit) return Object.freeze([]);
  for (const property of MATERIAL_PROPERTY_IDS) {
    if (recomputed.properties[property] !== material.properties[property]) return Object.freeze([]);
  }
  return reactionsForComponents(components, catalogue);
}

/** Structural terms that apply to every combination, plus any reaction boosts. */
function finishProperties(
  blend: MaterialProperties,
  boosts: Readonly<Partial<Record<MaterialPropertyId, number>>>,
): MaterialProperties {
  const bindingBonus = Math.trunc(blend.adhesion / 8);
  return props({
    hardness: blend.hardness + bindingBonus + (boosts.hardness ?? 0),
    flexibility: blend.flexibility - Math.trunc(bindingBonus / 2) + (boosts.flexibility ?? 0),
    adhesion: blend.adhesion + (boosts.adhesion ?? 0),
    conductivity: blend.conductivity + (boosts.conductivity ?? 0),
    toxicity: blend.toxicity + (boosts.toxicity ?? 0),
    photosensitivity: blend.photosensitivity + (boosts.photosensitivity ?? 0),
    porosity: Math.max(0, blend.porosity - Math.trunc(blend.adhesion / 4) + (boosts.porosity ?? 0)),
    density: blend.density + (boosts.density ?? 0),
  });
}

/**
 * Whether a composite keeps the food value of its ingredients instead of halving it.
 *
 * Halving unconditionally meant nutrition decayed geometrically with every generation of
 * processing, so no sequence of combinations could ever produce food worth making — a cooking or
 * farming tech tree was arithmetically impossible. Nutrition is still capped at the volume-weighted
 * mean and can never exceed the best ingredient, so this removes a dead end without creating an
 * energy source. Concentrating toxin into a mixture takes it back out of the food category, which
 * is the intended tension: the same binder that makes a weapon ruins a meal.
 */
function retainsNutrition(properties: MaterialProperties): boolean {
  return properties.toxicity <= 150 && properties.porosity >= 200;
}

/**
 * Combine materials into a new composite definition.
 *
 * Combination is non-magical: the composite inherits the blended property vector with a small
 * structural bonus to hardness (particles bind) and a penalty to porosity (voids are filled).
 * Adhesion still cannot appear from nowhere because an agent called its creation a trap.
 *
 * It is no longer purely lossy. See {@link REACTIONS}: a pair of properties held strongly enough
 * *together* can pay out beyond the ingredients, which is what stops the reachable property space
 * collapsing toward its own centroid. Nutrition is the volume-weighted mean, never more, and is
 * halved unless the result is mild and open enough to still be food.
 *
 * The label is derived from the finished properties rather than supplied by the caller. A name is
 * a consequence of what the material turned out to be, so an agent cannot call its creation
 * anything it likes, and a name can never drift out of step with the thing it names.
 */
export function combineMaterials(
  id: MaterialId,
  components: readonly MaterialComponent[],
  catalogue: ReadonlyMap<MaterialId, MaterialDefinition>,
  discoveredAtTick: number,
): MaterialDefinition | null {
  const volume = totalVolume(components);
  if (volume <= 0 || components.length < 2) return null;
  const blended = blendProperties(components, catalogue);
  let nutrition = 0;
  for (const component of components) {
    const definition = catalogue.get(component.materialId);
    if (!definition) return null;
    nutrition += definition.nutritionPerUnit * Math.max(0, toInt(component.quantity));
  }
  const origin = 'composite' as const;
  const { boosts } = deriveReactionBoosts(blended);
  const properties = finishProperties(blended, boosts);
  const meanNutrition = nutrition / volume;
  const nutritionPerUnit = Math.trunc(
    retainsNutrition(properties) ? meanNutrition : meanNutrition / 2,
  );
  return Object.freeze({
    id,
    label: deriveMaterialName({ id, origin, properties, nutritionPerUnit }).label,
    origin,
    nutritionPerUnit,
    discoveredAtTick,
    derivedFrom: Object.freeze([...components]),
    properties,
  });
}
