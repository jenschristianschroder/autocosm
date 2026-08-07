import type { Mesh } from '@babylonjs/core/Meshes/mesh';

/**
 * Making the world clickable.
 *
 * Everything except the terrain is drawn as thin instances — one mesh per lineage or per structure
 * pattern — so a pick returns a mesh and an instance index, not an entity. Each renderer tags its
 * meshes with what they draw and keeps an ordered list of the ids in each instance slot, and this
 * module holds the tag so the two sides cannot drift apart.
 */

export type PickKind = 'organism' | 'structure' | 'resource' | 'terrain';

export interface PickMetadata {
  readonly autocosmPick: PickKind;
}

/** Tag a mesh as pickable and enable per-instance picking where instances are used. */
export function markPickable(mesh: Mesh, kind: PickKind, instanced: boolean): void {
  mesh.isPickable = true;
  if (instanced) mesh.thinInstanceEnablePicking = true;
  const metadata: PickMetadata = { autocosmPick: kind };
  mesh.metadata = metadata;
}

/** Read the tag back, tolerating meshes Babylon created for its own purposes. */
export function pickKindOf(metadata: unknown): PickKind | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const kind = (metadata as { autocosmPick?: unknown }).autocosmPick;
  return kind === 'organism' || kind === 'structure' || kind === 'resource' || kind === 'terrain'
    ? kind
    : undefined;
}
