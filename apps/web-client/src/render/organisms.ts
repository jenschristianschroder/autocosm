import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { PBRMetallicRoughnessMaterial } from '@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import type { OrganismDto, VisualDto } from '../types';
import { SCENE_SCALE, sceneX, sceneY, sceneZ } from './coords';

/**
 * Organism rendering.
 *
 * Organisms of one agent share inherited traits, so they share one procedurally built mesh and are
 * drawn as thin instances of it — one draw call per lineage regardless of population. Per-organism
 * variation that mutation actually produces (size, hue) rides in the instance matrix and the
 * instance colour buffer.
 *
 * Positions are interpolated between snapshots purely for smoothness. The renderer never advances
 * an organism past its last authoritative position: it eases from where the previous snapshot put
 * it to where the current one does, and stops.
 */

/** Instance rows are 16 floats (a 4×4 matrix) and 4 floats of colour. */
const MATRIX_STRIDE = 16;
const COLOUR_STRIDE = 4;

/** Beyond this many scene units an organism is culled entirely; it is sub-pixel by then. */
const CULL_DISTANCE = 260;
/** Inside this distance the detailed mesh is used; outside it, the low-detail one. */
const LOD_DISTANCE = 55;

interface Tracked {
  readonly dto: OrganismDto;
  readonly fromX: number;
  readonly fromY: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toY: number;
  readonly toZ: number;
  /** Deterministic per-organism phase so idle bobbing is not synchronised across a lineage. */
  readonly phase: number;
}

interface LineageGroup {
  readonly detailed: Mesh;
  readonly simple: Mesh;
  readonly material: PBRMetallicRoughnessMaterial;
  members: Tracked[];
}

export interface OrganismRendererHandle {
  /** Replace the authoritative set. Returns the number of organisms now tracked. */
  update(organisms: readonly OrganismDto[]): number;
  /** Advance interpolation. `alpha` is 0..1 progress toward the newest snapshot. */
  render(alpha: number, elapsedSeconds: number, cameraPosition: Vector3): void;
  /** Scene-space position of a tracked organism, for camera follow and picking. */
  positionOf(organismId: string, alpha: number): Vector3 | undefined;
  dispose(): void;
}

export function createOrganismRenderer(scene: Scene): OrganismRendererHandle {
  const groups = new Map<string, LineageGroup>();
  const tracked = new Map<string, Tracked>();

  const detailedMatrices: number[] = [];
  const simpleMatrices: number[] = [];
  const detailedColours: number[] = [];
  const simpleColours: number[] = [];

  function update(organisms: readonly OrganismDto[]): number {
    const seen = new Set<string>();
    const byAgent = new Map<string, OrganismDto[]>();

    for (const dto of organisms) {
      seen.add(dto.id);
      const list = byAgent.get(dto.agentId);
      if (list) list.push(dto);
      else byAgent.set(dto.agentId, [dto]);
    }

    for (const [id] of tracked) if (!seen.has(id)) tracked.delete(id);

    for (const [agentId, members] of byAgent) {
      let group = groups.get(agentId);
      if (!group) {
        const representative = members.at(0)?.visual;
        if (!representative) continue;
        group = {
          detailed: buildOrganismMesh(scene, `organism-${agentId}`, representative, true),
          simple: buildOrganismMesh(scene, `organism-lod-${agentId}`, representative, false),
          material: buildOrganismMaterial(scene, agentId, representative),
          members: [],
        };
        group.detailed.material = group.material;
        group.simple.material = group.material;
        groups.set(agentId, group);
      }

      const next: Tracked[] = [];
      for (const dto of members) {
        const previous = tracked.get(dto.id);
        const toX = sceneX(dto.x);
        const toY = sceneY(dto.elevation) + bodyRadius(dto.visual) * 0.9;
        const toZ = sceneZ(dto.z);
        const entry: Tracked = {
          dto,
          fromX: previous?.toX ?? toX,
          fromY: previous?.toY ?? toY,
          fromZ: previous?.toZ ?? toZ,
          toX,
          toY,
          toZ,
          phase: previous?.phase ?? hashPhase(dto.id),
        };
        tracked.set(dto.id, entry);
        next.push(entry);
      }
      group.members = next;
    }

    for (const [agentId, group] of groups) {
      if (byAgent.has(agentId)) continue;
      group.members = [];
      group.detailed.thinInstanceCount = 0;
      group.simple.thinInstanceCount = 0;
    }

    return tracked.size;
  }

  function render(alpha: number, elapsedSeconds: number, cameraPosition: Vector3): void {
    const t = clamp01(alpha);
    for (const group of groups.values()) {
      detailedMatrices.length = 0;
      simpleMatrices.length = 0;
      detailedColours.length = 0;
      simpleColours.length = 0;

      for (const member of group.members) {
        const x = member.fromX + (member.toX - member.fromX) * t;
        const y = member.fromY + (member.toY - member.fromY) * t;
        const z = member.fromZ + (member.toZ - member.fromZ) * t;

        const dx = x - cameraPosition.x;
        const dy = y - cameraPosition.y;
        const dz = z - cameraPosition.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance > CULL_DISTANCE) continue;

        const visual = member.dto.visual;
        // A slow bob and yaw so a living world does not look like a spreadsheet of dots. It is
        // decoration only: it never changes the authoritative position reported by the API.
        const bob = Math.sin(elapsedSeconds * 1.4 + member.phase) * bodyRadius(visual) * 0.12;
        const yaw = Math.sin(elapsedSeconds * 0.5 + member.phase) * 0.4 + member.phase;
        const vitality = member.dto.maxHealth > 0 ? member.dto.health / member.dto.maxHealth : 1;
        const size = 1 * (0.55 + 0.45 * clamp01(vitality));

        const matrix = Matrix.Compose(
          new Vector3(size, size, size),
          Quaternion.FromEulerAngles(0, yaw, 0),
          new Vector3(x, y + bob, z),
        );

        const energyRatio =
          member.dto.maxEnergy > 0 ? clamp01(member.dto.energy / member.dto.maxEnergy) : 1;
        // Starving organisms desaturate toward grey; this reads at a glance from a distance.
        const shade = 0.45 + 0.55 * energyRatio;

        if (distance <= LOD_DISTANCE) {
          matrix.copyToArray(detailedMatrices, detailedMatrices.length);
          detailedColours.push(shade, shade, shade, 1);
        } else {
          matrix.copyToArray(simpleMatrices, simpleMatrices.length);
          simpleColours.push(shade, shade, shade, 1);
        }
      }

      applyInstances(group.detailed, detailedMatrices, detailedColours);
      applyInstances(group.simple, simpleMatrices, simpleColours);
    }
  }

  function positionOf(organismId: string, alpha: number): Vector3 | undefined {
    const member = tracked.get(organismId);
    if (!member) return undefined;
    const t = clamp01(alpha);
    return new Vector3(
      member.fromX + (member.toX - member.fromX) * t,
      member.fromY + (member.toY - member.fromY) * t,
      member.fromZ + (member.toZ - member.fromZ) * t,
    );
  }

  function dispose(): void {
    for (const group of groups.values()) {
      group.detailed.dispose(false, false);
      group.simple.dispose(false, false);
      group.material.dispose();
    }
    groups.clear();
    tracked.clear();
  }

  return { update, render, positionOf, dispose };
}

function applyInstances(mesh: Mesh, matrices: readonly number[], colours: readonly number[]): void {
  const count = matrices.length / MATRIX_STRIDE;
  if (count === 0) {
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
    return;
  }
  mesh.setEnabled(true);
  mesh.thinInstanceSetBuffer('matrix', Float32Array.from(matrices), MATRIX_STRIDE, false);
  mesh.thinInstanceSetBuffer('color', Float32Array.from(colours), COLOUR_STRIDE, false);
  mesh.thinInstanceCount = count;
}

/**
 * Build a body from inherited visual traits.
 *
 * Every visible feature maps to one trait-derived field so an observer can read evolution off the
 * silhouette: spiky means defended, long means fast, many appendages means mobile, big eyes mean
 * it senses well.
 */
function buildOrganismMesh(scene: Scene, name: string, visual: VisualDto, detailed: boolean): Mesh {
  const parts: Mesh[] = [];
  const radius = bodyRadius(visual);
  const elongation = 1 + (visual.elongation / 1000) * 1.8;
  const segments = detailed ? 12 : 5;

  const body = CreateSphere(`${name}-body`, { diameter: radius * 2, segments }, scene);
  body.scaling = new Vector3(1, 1 / Math.sqrt(elongation), elongation);
  parts.push(body);

  if (detailed) {
    const appendages = Math.min(8, Math.round((visual.appendages / 1000) * 8));
    for (let i = 0; i < appendages; i += 1) {
      const angle = (i / Math.max(1, appendages)) * Math.PI * 2;
      const limb = CreateCylinder(
        `${name}-limb-${i}`,
        {
          height: radius * 1.5,
          diameterTop: radius * 0.12,
          diameterBottom: radius * 0.26,
          tessellation: 6,
        },
        scene,
      );
      limb.rotation = new Vector3(Math.PI / 2.4, angle, 0);
      limb.position = new Vector3(
        Math.cos(angle) * radius * 0.85,
        -radius * 0.35,
        Math.sin(angle) * radius * 0.85,
      );
      parts.push(limb);
    }

    const spines = Math.min(10, Math.round((visual.spines / 1000) * 10));
    for (let i = 0; i < spines; i += 1) {
      const angle = (i / Math.max(1, spines)) * Math.PI * 2 + 0.3;
      const spine = CreateCylinder(
        `${name}-spine-${i}`,
        { height: radius * 1.1, diameterTop: 0, diameterBottom: radius * 0.2, tessellation: 5 },
        scene,
      );
      spine.rotation = new Vector3(0, angle, -Math.PI / 5);
      spine.position = new Vector3(
        Math.cos(angle) * radius * 0.7,
        radius * 0.7,
        Math.sin(angle) * radius * 0.7,
      );
      parts.push(spine);
    }

    if (visual.plating > 320) {
      const shell = CreateSphere(`${name}-plate`, { diameter: radius * 2.1, segments: 10 }, scene);
      shell.scaling = new Vector3(1.02, 0.55, elongation * 0.92);
      shell.position = new Vector3(0, radius * 0.28, 0);
      parts.push(shell);
    }

    const eyes = Math.min(4, Math.round((visual.eyes / 1000) * 4));
    for (let i = 0; i < eyes; i += 1) {
      const offset = (i - (eyes - 1) / 2) * radius * 0.42;
      const eye = CreateBox(`${name}-eye-${i}`, { size: radius * 0.24 }, scene);
      eye.position = new Vector3(offset, radius * 0.42, radius * elongation * 0.8);
      parts.push(eye);
    }
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!merged) {
    // MergeMeshes only returns null when handed an empty list, which cannot happen here, but the
    // body mesh is a valid fallback rather than a crash.
    body.name = name;
    return body;
  }
  merged.name = name;
  merged.isPickable = false;
  merged.alwaysSelectAsActiveMesh = true;
  merged.thinInstanceCount = 0;
  return merged;
}

function buildOrganismMaterial(
  scene: Scene,
  agentId: string,
  visual: VisualDto,
): PBRMetallicRoughnessMaterial {
  const material = new PBRMetallicRoughnessMaterial(`organismMaterial-${agentId}`, scene);
  const colour = hslToColor3(visual.hue / 1000, visual.saturation / 1000, visual.luminance / 1000);
  material.baseColor = colour;
  material.metallic = clamp01(visual.plating / 1400);
  material.roughness = 0.35 + 0.6 * (1 - visual.plating / 1000);
  material.emissiveColor = colour.scale(clamp01(visual.glow / 1000) * 0.85);
  const translucency = clamp01(visual.translucency / 1000);
  if (translucency > 0.05) {
    material.alpha = 1 - translucency * 0.55;
    material.transparencyMode = 2;
  }
  material.backFaceCulling = translucency < 0.05;
  return material;
}

/** Scene-space radius. `scale` is a per-mille trait, mapped to a modest legible size range. */
function bodyRadius(visual: VisualDto): number {
  const cu = 22 + (visual.scale / 1000) * 130;
  return cu * SCENE_SCALE;
}

function hashPhase(id: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return ((h >>> 0) / 4_294_967_295) * Math.PI * 2;
}

export function hslToColor3(h: number, s: number, l: number): Color3 {
  const saturation = clamp01(s) * 0.85 + 0.1;
  const lightness = 0.22 + clamp01(l) * 0.55;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = (((h % 1) + 1) % 1) * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = lightness - c / 2;
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  return new Color3(r + m, g + m, b + m);
}

export function hslToColor4(h: number, s: number, l: number, a: number): Color4 {
  const c = hslToColor3(h, s, l);
  return new Color4(c.r, c.g, c.b, a);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
