import {
  CAPABILITY_REQUIREMENTS,
  type AgentActionType,
  type Organism,
  type Phenotype,
  derivePhenotype,
} from '@autocosm/domain';

/**
 * Capability gating.
 *
 * An action exists for an organism only when its evolved body supports it. This is applied
 * both when composing an observation (so a model never sees an impossible option) and again
 * when resolving a proposal (so a model that ignores the observation is still refused).
 */
export function meetsRequirement(
  action: AgentActionType,
  phenotype: Phenotype,
  mature: boolean,
): boolean {
  const requirement = CAPABILITY_REQUIREMENTS.find((r) => r.action === action);
  if (!requirement) return true;
  if (
    requirement.minManipulation !== undefined &&
    phenotype.manipulationScore < requirement.minManipulation
  ) {
    return false;
  }
  if (
    requirement.minSignalRadiusCu !== undefined &&
    phenotype.signalRadiusCu < requirement.minSignalRadiusCu
  ) {
    return false;
  }
  if (
    requirement.minMemorySlots !== undefined &&
    phenotype.memorySlots < requirement.minMemorySlots
  ) {
    return false;
  }
  if (
    requirement.minPlanning !== undefined &&
    phenotype.effectivePlanning < requirement.minPlanning
  ) {
    return false;
  }
  if (requirement.requiresMaturity === true && !mature) {
    return false;
  }
  return true;
}

/** Actions currently available to an organism, in stable order. */
export function availableActions(organism: Organism, phenotype?: Phenotype): AgentActionType[] {
  const p = phenotype ?? derivePhenotype(organism.genotype);
  const mature = organism.ageTicks >= p.maturityAgeTicks;
  const all: AgentActionType[] = [
    'move',
    'consume',
    'attack',
    'signal',
    'attach',
    'share',
    'reproduce',
    'expressTrait',
    'collect',
    'combine',
    'build',
    'inspect',
    'repurpose',
    'repair',
    'rest',
  ];
  return all.filter((action) => meetsRequirement(action, p, mature));
}

export function isMature(organism: Organism, phenotype?: Phenotype): boolean {
  const p = phenotype ?? derivePhenotype(organism.genotype);
  return organism.ageTicks >= p.maturityAgeTicks;
}
