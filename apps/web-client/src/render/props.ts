import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { PBRMetallicRoughnessMaterial } from '@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import type { ResourceDto, StructureDto } from '../types';
import { SCENE_SCALE, sceneX, sceneY, sceneZ } from './coords';

/**
 * Structures and resource nodes.
 *
 * A structure's silhouette comes from its authoritative `pattern`, and its condition from
 * `integrity` — a crumbling shelter visibly sags and darkens. Nothing here invents a capability:
 * the derived `functions` list is shown in the inspector, not implied by the geometry.
 */

const MATRIX_STRIDE = 16;
const COLOUR_STRIDE = 4;

type Pattern = StructureDto['pattern'];

const PATTERN_COLOUR: Record<Pattern, [number, number, number]> = {
  lattice: [0.5, 0.48, 0.4],
  shell: [0.52, 0.42, 0.3],
  mesh: [0.4, 0.5, 0.42],
  conduit: [0.28, 0.46, 0.55],
  vessel: [0.35, 0.4, 0.32],
  anchor: [0.46, 0.46, 0.5],
  beacon: [0.72, 0.62, 0.28],
  snare: [0.4, 0.2, 0.22],
};

export interface StructureRendererHandle {
  update(structures: readonly StructureDto[]): void;
  positionOf(structureId: string): Vector3 | undefined;
  dispose(): void;
}

export function createStructureRenderer(scene: Scene): StructureRendererHandle {
  const meshes = new Map<string, Mesh>();
  const materials = new Map<string, PBRMetallicRoughnessMaterial>();
  const positions = new Map<string, Vector3>();

  function meshFor(pattern: Pattern): Mesh {
    const existing = meshes.get(pattern);
    if (existing) return existing;

    const mesh = buildStructureMesh(scene, pattern);
    const material = new PBRMetallicRoughnessMaterial(`structureMaterial-${pattern}`, scene);
    const [r, g, b] = PATTERN_COLOUR[pattern];
    material.baseColor = new Color3(r, g, b);
    material.metallic = 0.06;
    material.roughness = 0.78;
    if (pattern === 'beacon') material.emissiveColor = new Color3(r, g, b).scale(0.55);
    mesh.material = material;
    mesh.receiveShadows = true;
    mesh.thinInstanceCount = 0;

    meshes.set(pattern, mesh);
    materials.set(pattern, material);
    return mesh;
  }

  function update(structures: readonly StructureDto[]): void {
    const byPattern = new Map<Pattern, StructureDto[]>();
    positions.clear();

    for (const structure of structures) {
      const list = byPattern.get(structure.pattern);
      if (list) list.push(structure);
      else byPattern.set(structure.pattern, [structure]);
    }

    for (const mesh of meshes.values()) mesh.thinInstanceCount = 0;

    for (const [pattern, list] of byPattern) {
      const mesh = meshFor(pattern);
      const matrices: number[] = [];
      const colours: number[] = [];

      for (const structure of list) {
        const x = sceneX(structure.x);
        const y = sceneY(structure.elevation);
        const z = sceneZ(structure.z);
        positions.set(structure.id, new Vector3(x, y, z));

        // Volume drives footprint; a bigger build really is bigger in the world.
        const size = Math.cbrt(Math.max(1, structure.volume)) * SCENE_SCALE * 3.2;
        const integrity = structure.integrity / 1000;
        // Damaged structures sag rather than shrink, so a ruin still occupies its ground.
        const matrix = Matrix.Compose(
          new Vector3(size, size * (0.45 + 0.55 * integrity), size),
          Quaternion.FromEulerAngles(0, hashAngle(structure.id), 0),
          new Vector3(x, y, z),
        );
        matrix.copyToArray(matrices, matrices.length);
        const shade = 0.4 + 0.6 * integrity;
        colours.push(shade, shade, shade, 1);
      }

      if (matrices.length === 0) {
        mesh.setEnabled(false);
        continue;
      }
      mesh.setEnabled(true);
      mesh.thinInstanceSetBuffer('matrix', Float32Array.from(matrices), MATRIX_STRIDE, false);
      mesh.thinInstanceSetBuffer('color', Float32Array.from(colours), COLOUR_STRIDE, false);
      mesh.thinInstanceCount = matrices.length / MATRIX_STRIDE;
    }
  }

  return {
    update,
    positionOf: (id) => positions.get(id),
    dispose() {
      for (const mesh of meshes.values()) mesh.dispose(false, false);
      for (const material of materials.values()) material.dispose();
      meshes.clear();
      materials.clear();
      positions.clear();
    },
  };
}

function buildStructureMesh(scene: Scene, pattern: Pattern): Mesh {
  const name = `structure-${pattern}`;
  switch (pattern) {
    case 'shell': {
      const dome = CreateSphere(name, { diameter: 1, segments: 10, slice: 0.55 }, scene);
      dome.scaling = new Vector3(1, 0.9, 1);
      return dome;
    }
    case 'anchor': {
      const wall = CreateBox(name, { width: 1.6, height: 0.9, depth: 0.28 }, scene);
      wall.bakeCurrentTransformIntoVertices();
      return wall;
    }
    case 'snare': {
      const ring = CreateTorus(name, { diameter: 1.2, thickness: 0.22, tessellation: 12 }, scene);
      ring.scaling = new Vector3(1, 0.5, 1);
      return ring;
    }
    case 'conduit': {
      const tube = CreateCylinder(
        name,
        { height: 1.4, diameterTop: 0.24, diameterBottom: 0.3, tessellation: 8 },
        scene,
      );
      tube.rotation = new Vector3(0, 0, Math.PI / 2.6);
      return tube;
    }
    case 'beacon': {
      const spire = CreateCylinder(
        name,
        { height: 2.2, diameterTop: 0.04, diameterBottom: 0.4, tessellation: 8 },
        scene,
      );
      return spire;
    }
    case 'vessel': {
      return CreateBox(name, { width: 0.9, height: 0.6, depth: 0.9 }, scene);
    }
    case 'mesh': {
      const net = CreateTorus(name, { diameter: 1.3, thickness: 0.4, tessellation: 14 }, scene);
      net.scaling = new Vector3(1, 0.55, 1);
      return net;
    }
    case 'lattice':
    default: {
      const frame = CreateBox(name, { width: 1.1, height: 1.4, depth: 1.1 }, scene);
      return frame;
    }
  }
}

export interface ResourceRendererHandle {
  update(resources: readonly ResourceDto[]): void;
  dispose(): void;
}

/**
 * Resource nodes.
 *
 * One instanced crystal cluster, tinted by material id and scaled by remaining quantity, so a
 * depleting patch visibly shrinks. Depleted nodes still render faintly: an observer should be able
 * to see that a place was stripped, not just that it is empty.
 */
export function createResourceRenderer(scene: Scene): ResourceRendererHandle {
  const mesh = CreateCylinder(
    'resourceNode',
    { height: 1, diameterTop: 0.08, diameterBottom: 0.5, tessellation: 6 },
    scene,
  );
  mesh.isPickable = false;
  mesh.thinInstanceCount = 0;

  const material = new PBRMetallicRoughnessMaterial('resourceMaterial', scene);
  material.baseColor = new Color3(1, 1, 1);
  material.metallic = 0.25;
  material.roughness = 0.4;
  mesh.material = material;

  return {
    update(resources) {
      const matrices: number[] = [];
      const colours: number[] = [];

      for (const resource of resources) {
        const fill = resource.capacity > 0 ? resource.quantity / resource.capacity : 0;
        const height = 0.35 + fill * 1.5;
        const matrix = Matrix.Compose(
          new Vector3(0.9, height, 0.9),
          Quaternion.FromEulerAngles(0, hashAngle(resource.id), 0),
          new Vector3(
            sceneX(resource.x),
            sceneY(resource.elevation) + height * 0.5,
            sceneZ(resource.z),
          ),
        );
        matrix.copyToArray(matrices, matrices.length);
        const [r, g, b] = materialColour(resource.materialId);
        const dim = 0.3 + 0.7 * fill;
        colours.push(r * dim, g * dim, b * dim, 1);
      }

      if (matrices.length === 0) {
        mesh.thinInstanceCount = 0;
        mesh.setEnabled(false);
        return;
      }
      mesh.setEnabled(true);
      mesh.thinInstanceSetBuffer('matrix', Float32Array.from(matrices), MATRIX_STRIDE, false);
      mesh.thinInstanceSetBuffer('color', Float32Array.from(colours), COLOUR_STRIDE, false);
      mesh.thinInstanceCount = matrices.length / MATRIX_STRIDE;
    },
    dispose() {
      material.dispose();
      mesh.dispose(false, false);
    },
  };
}

/** Stable colour per material id so the same mineral always looks the same across sessions. */
function materialColour(materialId: string): [number, number, number] {
  const h = hash(materialId);
  const hue = (h % 360) / 360;
  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const q = 1 - f;
  switch (i % 6) {
    case 0:
      return [1, f, 0.15];
    case 1:
      return [q, 1, 0.15];
    case 2:
      return [0.15, 1, f];
    case 3:
      return [0.15, q, 1];
    case 4:
      return [f, 0.15, 1];
    default:
      return [1, 0.15, q];
  }
}

function hashAngle(id: string): number {
  return ((hash(id) % 3600) / 3600) * Math.PI * 2;
}

function hash(value: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}
