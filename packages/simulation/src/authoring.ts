import {
  Prng,
  clampPerMille,
  hashSeed,
  normaliseGenotype,
  seedGenotype,
  type CreateAgentRequest,
  type Drives,
  type Genotype,
  type TraitId,
} from '@autocosm/domain';

/**
 * Translate a creator's authoring request into a founding cell.
 *
 * A creator chooses *starting nature*, never an outcome. The result is deliberately modest:
 * a basic cell with small biases. Nothing here can produce a fully-formed builder or
 * predator — those capabilities have to be evolved.
 */

/** Maximum bias a creator's choices may apply to any single trait, in per-mille. */
export const MAX_AUTHORED_BIAS = 220;

export function foundingGenotypeFor(request: CreateAgentRequest, worldSeed: number): Genotype {
  const rng = new Prng(hashSeed('authoring', worldSeed, request.name, request.visualSeed));
  const base = seedGenotype();
  const biases: Partial<Record<TraitId, number>> = {};

  const add = (id: TraitId, amount: number): void => {
    biases[id] = clampPerMille((biases[id] ?? 0) + amount);
  };

  switch (request.habitat) {
    case 'abyss':
      add('toxinResistance', 120);
      add('thermalTolerance', 100);
      add('photosynthesis', -80);
      break;
    case 'shallows':
      add('buoyancy', 160);
      add('photosynthesis', 120);
      break;
    case 'shore':
      add('chemoreception', 100);
      add('manipulation', 60);
      break;
    case 'plain':
      add('motility', 140);
      add('perceptionRange', 80);
      break;
    case 'highland':
      add('armor', 120);
      add('thermalTolerance', 140);
      add('buoyancy', -120);
      break;
  }

  switch (request.temperament) {
    case 'cautious':
      add('camouflage', 120);
      add('armor', 60);
      break;
    case 'balanced':
      add('energyReserve', 80);
      break;
    case 'bold':
      add('aggression', 140);
      add('motility', 60);
      break;
    case 'gregarious':
      add('sociality', 160);
      add('signalStrength', 100);
      break;
    case 'solitary':
      add('longevity', 100);
      add('energyReserve', 100);
      break;
  }

  switch (request.sensoryBias) {
    case 'light':
      add('photoreception', 160);
      break;
    case 'chemical':
      add('chemoreception', 160);
      break;
    case 'balanced':
      add('photoreception', 70);
      add('chemoreception', 70);
      break;
  }

  // Drives nudge the body a little, so a build-focused creator starts marginally more
  // dexterous — but never enough to skip evolving the capability.
  add('manipulation', Math.trunc(request.drives.build / 10));
  add('sociality', Math.trunc(request.drives.cooperate / 12));
  add('motility', Math.trunc(request.drives.explore / 12));
  add('reproductiveInvestment', Math.trunc(request.drives.reproduce / 12));
  add('metabolicRate', Math.trunc(request.drives.forage / 14));
  add('energyReserve', Math.trunc(request.drives.survive / 14));

  const genotype: Partial<Record<TraitId, number>> = {};
  for (const [id, value] of Object.entries(base) as [TraitId, number][]) {
    const bias = Math.max(-MAX_AUTHORED_BIAS, Math.min(MAX_AUTHORED_BIAS, biases[id] ?? 0));
    // A small deterministic jitter means two identical requests still found distinct cells.
    genotype[id] = clampPerMille(value + bias + rng.nextRange(-15, 15));
  }
  return normaliseGenotype(genotype);
}

export function drivesFor(request: CreateAgentRequest): Drives {
  return Object.freeze({
    survive: clampPerMille(request.drives.survive),
    forage: clampPerMille(request.drives.forage),
    reproduce: clampPerMille(request.drives.reproduce),
    explore: clampPerMille(request.drives.explore),
    cooperate: clampPerMille(request.drives.cooperate),
    build: clampPerMille(request.drives.build),
  });
}
