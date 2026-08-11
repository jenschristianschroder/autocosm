import { describe, expect, it } from 'vitest';
import { asMaterialId } from './ids.js';
import {
  BASE_MATERIALS,
  combineMaterials,
  MATERIAL_PROPERTY_IDS,
  type MaterialDefinition,
  type MaterialOrigin,
  type MaterialPropertyId,
} from './materials.js';
import { deriveMaterialName, NAMING_PROPERTY_ORDER, NAMING_VERSION } from './naming.js';
import { MaterialRecordSchema } from './records.js';

const ORIGINS: readonly MaterialOrigin[] = ['mineral', 'organic', 'fluid', 'composite'];

function vector(
  overrides: Partial<Record<MaterialPropertyId, number>>,
): Record<MaterialPropertyId, number> {
  const out = {} as Record<MaterialPropertyId, number>;
  for (const id of MATERIAL_PROPERTY_IDS) out[id] = overrides[id] ?? 0;
  return out;
}

function nameOf(
  id: string,
  properties: Partial<Record<MaterialPropertyId, number>>,
  origin: MaterialOrigin = 'composite',
  nutritionPerUnit = 0,
) {
  return deriveMaterialName({
    id: asMaterialId(id),
    origin,
    properties: vector(properties),
    nutritionPerUnit,
  });
}

describe('deriveMaterialName', () => {
  it('is deterministic for identical input', () => {
    const a = nameOf('mx1a2b3c', { adhesion: 720, flexibility: 400 });
    const b = nameOf('mx1a2b3c', { adhesion: 720, flexibility: 400 });
    expect(a).toEqual(b);
  });

  it('gives different identities different names', () => {
    // Same physics, different material: the hash slot varies so the world is not full of
    // identically-named things a spectator cannot tell apart.
    const names = new Set(
      ['mx000001', 'mx000002', 'mx000003', 'mx000004'].map(
        (id) => nameOf(id, { adhesion: 720, flexibility: 400 }).label,
      ),
    );
    expect(names.size).toBeGreaterThan(1);
  });

  it('never emits an id fragment or a separator into the label', () => {
    // The bug this replaces produced labels like `mx1a2b3c-mx4d5e6f`.
    for (let i = 0; i < 200; i += 1) {
      const id = `mx${i.toString(16).padStart(6, '0')}`;
      const { label } = nameOf(id, {
        hardness: (i * 37) % 1001,
        adhesion: (i * 91) % 1001,
        toxicity: (i * 13) % 1001,
      });
      expect(label).not.toContain('-');
      expect(label).not.toContain(id);
      expect(label).not.toMatch(/mx[0-9a-f]{6}/);
      expect(label.length).toBeGreaterThan(2);
      expect(label.length).toBeLessThanOrEqual(64);
    }
  });

  it('covers every property and origin bucket without falling through', () => {
    for (const property of MATERIAL_PROPERTY_IDS) {
      for (const origin of ORIGINS) {
        const { label, subtitle } = nameOf(`mx${property}${origin}`, { [property]: 900 }, origin);
        expect(label).toMatch(/^[A-Z][a-z-]+ [A-Z][a-z]+$/);
        expect(subtitle).toContain(origin);
        expect(subtitle.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('ranks by value and breaks ties by canonical order', () => {
    // Two properties at exactly the same value must resolve the same way every time, or replay
    // diverges. `hardness` precedes `density` in canonical order, so it takes the noun slot.
    const first = nameOf('mxtie', { hardness: 800, density: 800 });
    const second = nameOf('mxtie', { density: 800, hardness: 800 });
    expect(first).toEqual(second);
    expect(first.subtitle.indexOf('hard')).toBeLessThan(first.subtitle.indexOf('dense'));
  });

  it('falls back to a featureless name when nothing stands out', () => {
    const { label, subtitle } = nameOf('mxdull', { hardness: 40 }, 'mineral');
    expect(label).toMatch(
      /^(Dull|Inert|Plain|Muted|Drab|Blank|Listless|Nondescript) (Form|Grit|Bed|Crust|Shard|Slag|Seam|Rock)$/,
    );
    expect(subtitle).toBe('Unremarkable mineral material. Low porosity and density. Not edible.');
  });

  it('describes strengths, lows and edibility from the actual thresholds', () => {
    const strong = nameOf('mxstrong', { adhesion: 900, flexibility: 700 }, 'organic', 12);
    expect(strong.subtitle).toContain('Very adhesive and flexible organic material.');
    expect(strong.subtitle).toContain('Edible (12eu per mu).');

    // Below the `very` threshold the intensifier is dropped.
    const moderate = nameOf('mxmoderate', { adhesion: 700 }, 'organic');
    expect(moderate.subtitle.startsWith('Adhesive organic material.')).toBe(true);
    expect(moderate.subtitle).toContain('Not edible.');
  });

  it('lists at most three strengths', () => {
    const { subtitle } = nameOf('mxmany', {
      hardness: 900,
      flexibility: 880,
      adhesion: 860,
      conductivity: 840,
      toxicity: 820,
    });
    expect(subtitle).not.toContain('toxic');
    expect(subtitle.split(',').length).toBeLessThanOrEqual(3);
  });

  it('uses the runner-up property as the adjective when it is informative', () => {
    // A material that is mostly hard but also notably toxic should say so in its name rather than
    // wasting the slot on an intensity word.
    const informative = nameOf('mxpair', { hardness: 900, toxicity: 400 });
    const bare = nameOf('mxpair', { hardness: 900, toxicity: 20 });
    expect(informative.label).not.toBe(bare.label);
    expect(bare.label.startsWith('Pure ')).toBe(true);
  });

  it('keeps NAMING_PROPERTY_ORDER in step with MATERIAL_PROPERTY_IDS', () => {
    // The namer declares its own order to avoid a runtime import cycle with `materials.ts`.
    // This is the guard that keeps the duplicate honest.
    expect(NAMING_PROPERTY_ORDER).toEqual([...MATERIAL_PROPERTY_IDS]);
  });

  it('spreads names widely across materials that share the same physics', () => {
    // Composites cluster hard on a few property pairs, so the id hash is what actually separates
    // them. This guards the distribution: indexing a word list with FNV-1a's weak low bits once
    // collapsed a real world to 23% distinct labels, which is its own kind of illegibility.
    const labels = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      labels.add(
        nameOf(`mx${i.toString(36).padStart(6, '0')}`, { adhesion: 720, density: 400 }).label,
      );
    }
    // 8 stems x 8 adjectives x 8 suffixes = 512 possible names for this property pair.
    expect(labels.size).toBeGreaterThan(120);
  });

  it('never builds a name by doubling a word', () => {
    // Stems and origin suffixes are concatenated, so the two vocabularies must stay disjoint or a
    // material ends up called `Stonestone`.
    for (const property of MATERIAL_PROPERTY_IDS) {
      for (const origin of ORIGINS) {
        for (let i = 0; i < 40; i += 1) {
          const { label } = nameOf(`mx${property}${origin}${i}`, { [property]: 900 }, origin);
          const noun = label.split(' ')[1] ?? '';
          expect(noun).not.toMatch(/^(.{3,})\1$/i);
        }
      }
    }
  });

  it('exposes a version so a word-table change is a deliberate act', () => {
    expect(NAMING_VERSION).toBe(2);
  });
});

describe('MaterialRecordSchema label re-derivation', () => {
  const base = {
    rv: 1,
    id: 'mx1a2b3c',
    worldId: 'w-1',
    origin: 'composite' as const,
    properties: vector({ adhesion: 900, flexibility: 700 }),
    nutritionPerUnit: 0,
  };

  it('heals a label written before naming was deterministic', () => {
    // Production carries composites labelled `mx1a2b3c-mxf9e8d7`. The label is derived, never
    // matched on, so the stored value is a cache that is repaired on read rather than migrated.
    const parsed = MaterialRecordSchema.parse({
      ...base,
      label: 'mx1a2b3c-mxf9e8d7',
      derivedFrom: [
        { materialId: 'sand', quantity: 60 },
        { materialId: 'resin', quantity: 40 },
      ],
      discoveredAtTick: 12,
    });
    expect(parsed.label).not.toContain('-');
    expect(parsed.label).toBe(
      deriveMaterialName({
        id: asMaterialId(base.id),
        origin: base.origin,
        properties: base.properties,
        nutritionPerUnit: base.nutritionPerUnit,
      }).label,
    );
    // Nothing else about the record moves.
    expect(parsed.derivedFrom).toHaveLength(2);
    expect(parsed.discoveredAtTick).toBe(12);
  });

  it('leaves primordial materials with their authored names', () => {
    // `Water` and `Silt` are hand-written and meaningful; only produced materials are renamed.
    const parsed = MaterialRecordSchema.parse({ ...base, origin: 'fluid', label: 'Water' });
    expect(parsed.label).toBe('Water');
  });

  it('is idempotent, so a re-read never renames again', () => {
    const record = {
      ...base,
      label: 'nonsense',
      derivedFrom: [{ materialId: 'sand', quantity: 60 }],
    };
    const once = MaterialRecordSchema.parse(record);
    const twice = MaterialRecordSchema.parse(once);
    expect(twice).toEqual(once);
  });
});

describe('combineMaterials naming', () => {
  const catalogue = new Map<ReturnType<typeof asMaterialId>, MaterialDefinition>(
    BASE_MATERIALS.map((m) => [m.id, m] as const),
  );

  it('names a composite after what it turned out to be', () => {
    const [first, second] = BASE_MATERIALS;
    expect(first && second).toBeTruthy();
    if (!first || !second) return;
    const composite = combineMaterials(
      [
        { materialId: first.id, quantity: 60 },
        { materialId: second.id, quantity: 40 },
      ],
      catalogue,
      7,
    );
    expect(composite).not.toBeNull();
    if (!composite) return;
    expect(composite.label).toBe(deriveMaterialName(composite).label);
    expect(composite.label).not.toContain(first.id);
    expect(composite.label).not.toContain('-');
  });

  it('produces readable names for chained composites', () => {
    // The original failure mode was second- and third-generation composites, so exercise the
    // recursion rather than a single combination.
    const [first, second] = BASE_MATERIALS;
    if (!first || !second) return;
    const working = new Map(catalogue);
    let previous = first.id;
    for (let generation = 0; generation < 4; generation += 1) {
      const composite = combineMaterials(
        [
          { materialId: previous, quantity: 50 },
          { materialId: second.id, quantity: 50 },
        ],
        working,
        generation,
      );
      expect(composite).not.toBeNull();
      if (!composite) return;
      expect(composite.label).toMatch(/^[A-Z][a-z-]+ [A-Z][a-z]+$/);
      working.set(composite.id, composite);
      previous = composite.id;
    }
  });
});
