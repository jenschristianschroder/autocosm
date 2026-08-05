import { type MaterialId, asMaterialId } from './ids.js';
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
 * This is the only route from "some stuff" to "measured properties". It is deliberately
 * boring: adhesion cannot appear from nowhere just because an agent called its creation
 * a trap.
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

/** Total volume of a component list, in `mu`. */
export function totalVolume(components: readonly MaterialComponent[]): Mu {
  let volume = 0;
  for (const component of components) {
    volume += Math.max(0, toInt(component.quantity));
  }
  return volume;
}

/**
 * Combine materials into a new composite definition.
 *
 * Combination is lossy and non-magical: the composite inherits the blended property vector
 * with a small structural bonus to hardness and adhesion (particles bind) and a penalty to
 * porosity (voids are filled). Nutrition is the volume-weighted mean, never more.
 */
export function combineMaterials(
  id: MaterialId,
  label: string,
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
  const bindingBonus = Math.trunc(blended.adhesion / 8);
  return Object.freeze({
    id,
    label,
    origin: 'composite' as const,
    nutritionPerUnit: Math.trunc(nutrition / volume / 2),
    discoveredAtTick,
    derivedFrom: Object.freeze([...components]),
    properties: props({
      hardness: blended.hardness + bindingBonus,
      flexibility: blended.flexibility - Math.trunc(bindingBonus / 2),
      adhesion: blended.adhesion,
      conductivity: blended.conductivity,
      toxicity: blended.toxicity,
      photosensitivity: blended.photosensitivity,
      porosity: Math.max(0, blended.porosity - Math.trunc(blended.adhesion / 4)),
      density: blended.density,
    }),
  });
}
