import type {
  AgentDetailResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  CreatorIdentityResponse,
  EventHistoryResponse,
  GlossaryResponse,
  LineageDetailResponse,
  OrganismDetailResponse,
  SnapshotResponse,
  StructureDetailResponse,
  SubmitGoalResponse,
  WorldMetaResponse,
} from '@autocosm/domain';

/**
 * Convenience aliases for the API DTOs the client renders.
 *
 * These re-export the frozen `/api/v1` contract types rather than restating them, so a contract
 * change breaks the build here instead of producing a silently wrong screen.
 */
export type {
  AgentDetailResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  CreatorIdentityResponse,
  EventHistoryResponse,
  GlossaryResponse,
  LineageDetailResponse,
  OrganismDetailResponse,
  SnapshotResponse,
  StructureDetailResponse,
  SubmitGoalResponse,
  WorldMetaResponse,
};

export type RegionDto = SnapshotResponse['regions'][number];
export type OrganismDto = SnapshotResponse['organisms'][number];
export type StructureDto = SnapshotResponse['structures'][number];
export type ResourceDto = SnapshotResponse['resources'][number];
export type VisualDto = OrganismDto['visual'];
export type EventDto = EventHistoryResponse['events'][number];
export type AgentSummary = WorldMetaResponse['agents'][number];
export type MaterialDto = WorldMetaResponse['materials'][number];
export type LineageNodeDto = LineageDetailResponse['nodes'][number];
export type TraitDto = AgentDetailResponse['meanTraits'][number];
export type GlossaryEntryDto = GlossaryResponse['traits'][number];

/**
 * What the observer currently has selected, if anything.
 *
 * `region` and `resource` are resolved entirely from the snapshot the client already holds, so
 * clicking the ground costs no request.
 */
export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'organism'; readonly id: string }
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'structure'; readonly id: string }
  | { readonly kind: 'region'; readonly id: string }
  | { readonly kind: 'resource'; readonly id: string };

/** What a click in the 3D view landed on. */
export type PickHit =
  | { readonly kind: 'organism'; readonly id: string }
  | { readonly kind: 'structure'; readonly id: string }
  | { readonly kind: 'resource'; readonly id: string }
  | { readonly kind: 'region'; readonly id: string };
