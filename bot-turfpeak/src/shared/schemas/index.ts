/**
 * Flash Peak TMS - Shared Zod Validation Schemas
 * 
 * Enforces runtime schema integrity at service boundaries.
 * All models align with DATA_MODEL.md, FRD.md, and DECISIONS.md.
 */

import { z } from 'zod';

// =============================================================================
// Common Primitives
// =============================================================================

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime({ offset: true });

// =============================================================================
// Tournaments
// =============================================================================

export const tournamentStatusSchema = z.enum([
  'DRAFT',
  'REGISTRATION',
  'ONBOARDING',
  'DRAW_READY',
  'ACTIVE',
  'COMPLETED',
  'ARCHIVED',
]);

export const tournamentConfigSchema = z.object({
  game_duration_minutes: z.number().int().positive().default(8),
  kickoff_time: z.string().default('21:00'),
  confirmation_deadline: z.string().default('20:00'),
  grace_period_minutes: z.number().int().nonnegative().default(10),
  report_window_minutes: z.number().int().positive().default(15),
  group_qualifiers_per_group: z.number().int().positive().default(2),
  points_win: z.number().int().default(3),
  points_draw: z.number().int().default(1),
  points_loss: z.number().int().default(0),
  wo_goals_winner: z.number().int().default(3),
  wo_goals_loser: z.number().int().default(0),
});

export const tournamentSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(255),
  status: tournamentStatusSchema,
  timezone: z.string().default('Asia/Jakarta'),
  rules_version: z.string().min(1),
  config_json: z.string(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

// =============================================================================
// Teams
// =============================================================================

export const teamRegistrationStatusSchema = z.enum([
  'PENDING',
  'VERIFIED',
  'DISQUALIFIED',
  'WITHDRAWN',
]);

export const teamSchema = z.object({
  id: uuidSchema,
  tournament_id: uuidSchema,
  organization_name: z.string().max(255).nullable(),
  division_name: z.string().max(255).nullable(),
  team_name: z.string().min(1).max(255),
  team_code: z.string().max(32).nullable(),
  delegate_id: uuidSchema.nullable(),
  registration_status: teamRegistrationStatusSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

// =============================================================================
// Delegates & WhatsApp Identities
// =============================================================================

export const delegateStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']);

export const delegateSchema = z.object({
  id: uuidSchema,
  display_name: z.string().min(1).max(255),
  status: delegateStatusSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

export const whatsappAddressTypeSchema = z.enum(['JID', 'LID', 'PHONE', 'UNKNOWN']);

export const whatsappIdentitySchema = z.object({
  id: uuidSchema,
  delegate_id: uuidSchema,
  raw_address: z.string().min(1).max(255),
  address_type: whatsappAddressTypeSchema,
  is_primary: z.number().int().min(0).max(1),
  verified_at: isoDateSchema.nullable(),
  source_chat_id: z.string().max(255).nullable(),
  created_at: isoDateSchema,
});

// =============================================================================
// Bot Instances
// =============================================================================

export const botRoleSchema = z.literal('BOT');
export const botInstanceStatusSchema = z.enum(['ONLINE', 'OFFLINE', 'DEGRADED']);

export const botInstanceSchema = z.object({
  id: uuidSchema,
  role: botRoleSchema,
  raw_address: z.string().min(1).max(255),
  status: botInstanceStatusSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

// =============================================================================
// Players & Roster
// =============================================================================

export const playerPositionSchema = z.enum(['GOALKEEPER', 'OUTFIELD']);
export const rosterTypeSchema = z.enum(['STARTER', 'SUBSTITUTE']);
export const playerStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'INELIGIBLE']);

export const playerSchema = z.object({
  id: uuidSchema,
  tournament_id: uuidSchema,
  team_id: uuidSchema,
  nickname_raw: z.string().min(1).max(255),
  nickname_nfc: z.string().min(1).max(255),
  nickname_search_key: z.string().min(1).max(255),
  position: playerPositionSchema,
  roster_slot: z.number().int().min(1).max(10),
  roster_type: rosterTypeSchema,
  status: playerStatusSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

// =============================================================================
// Group Draw
// =============================================================================

export const drawStatusSchema = z.enum(['PREPARED', 'REVEALING', 'COMPLETED', 'CANCELLED']);

export const groupConfigJsonSchema = z.object({
  total_teams: z.number().int().min(4),
  num_groups: z.number().int().min(1),
  group_sizes: z.array(z.number().int().min(4).max(5)), // Only 4 or 5 allowed (FR-COMP-010)
  group_codes: z.array(z.string().min(1)),
  qualifiers_per_group: z.number().int().default(2),
});

export const eligibleTeamSnapshotItemSchema = z.object({
  team_id: uuidSchema,
  team_name: z.string(),
  organization_name: z.string().nullable(),
  division_name: z.string().nullable(),
  delegate_id: uuidSchema,
});

export const drawResultGroupAssignmentSchema = z.object({
  group_code: z.string(),
  teams: z.array(
    z.object({
      team_id: uuidSchema,
      team_name: z.string(),
      draw_position: z.number().int().positive(),
    })
  ),
});

export const groupDrawSchema = z.object({
  id: uuidSchema,
  tournament_id: uuidSchema,
  status: drawStatusSchema,
  group_config_json: z.string(),
  eligible_team_snapshot_json: z.string(),
  algorithm: z.string(),
  algorithm_version: z.string(),
  commitment_hash: z.string().nullable(),
  seed_reveal: z.string().nullable(),
  result_json: z.string().nullable(),
  next_reveal_index: z.number().int().nonnegative(),
  created_at: isoDateSchema,
  completed_at: isoDateSchema.nullable(),
});

export const groupSchema = z.object({
  id: uuidSchema,
  draw_id: uuidSchema,
  group_code: z.string().min(1).max(32),
  display_order: z.number().int().positive(),
});

export const groupMemberSchema = z.object({
  group_id: uuidSchema,
  team_id: uuidSchema,
  draw_position: z.number().int().positive(),
});

// =============================================================================
// Fixtures & Scheduling
// =============================================================================

export const competitionStageSchema = z.enum(['GROUP', 'KNOCKOUT']);

export const hostAssignmentReasonSchema = z.enum([
  'DEFAULT_LEFT_SIDE',
  'OPPONENT_SUBSTITUTED',
  'ORGANIZER_OVERRIDE',
]);

export const fixtureStatusSchema = z.enum([
  'SCHEDULED',
  'READY',
  'IN_PROGRESS',
  'REPORT_PENDING',
  'DISPUTED',
  'COMPLETED',
  'WALKOVER',
  'CANCELLED',
]);

export const fixtureSchema = z.object({
  id: uuidSchema,
  tournament_id: uuidSchema,
  stage: competitionStageSchema,
  group_id: uuidSchema.nullable(),
  round_code: z.string().max(32).nullable(),
  team_a_id: uuidSchema,
  team_b_id: uuidSchema,
  left_side_team_id: uuidSchema,
  scheduled_at: isoDateSchema.nullable(),
  timezone: z.string().default('Asia/Jakarta'),
  host_team_id: uuidSchema.nullable(),
  host_assignment_reason: hostAssignmentReasonSchema.nullable(),
  status: fixtureStatusSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

// =============================================================================
// Series
// =============================================================================

export const seriesFormatSchema = z.enum(['BO3', 'BO5']);
export const seriesStatusSchema = z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']);

export const seriesSchema = z.object({
  id: uuidSchema,
  fixture_id: uuidSchema,
  format: seriesFormatSchema,
  target_wins: z.number().int().min(2).max(3),
  status: seriesStatusSchema,
  winner_team_id: uuidSchema.nullable(),
  team_a_game_wins: z.number().int().nonnegative(),
  team_b_game_wins: z.number().int().nonnegative(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

// =============================================================================
// Games
// =============================================================================

export const gameStatusSchema = z.enum([
  'SCHEDULED',
  'IN_PROGRESS',
  'REPORT_PENDING',
  'DISPUTED',
  'COMPLETED',
  'WALKOVER',
]);

export const walkoverTypeSchema = z.enum([
  'NONE',
  'SINGLE_FORFEIT',
  'DOUBLE_ROOM_CARD_UNAVAILABLE',
  'DOUBLE_ABSENT',
]);

export const gameEvidenceStatusSchema = z.enum([
  'PENDING',
  'RECEIVED',
  'VERIFIED',
  'MISSING',
]);

export const gameSchema = z.object({
  id: uuidSchema,
  fixture_id: uuidSchema,
  series_id: uuidSchema.nullable(),
  game_number: z.number().int().positive(),
  status: gameStatusSchema,
  team_a_score: z.number().int().nonnegative().nullable(),
  team_b_score: z.number().int().nonnegative().nullable(),
  winner_team_id: uuidSchema.nullable(),
  is_draw: z.number().int().min(0).max(1),
  is_walkover: z.number().int().min(0).max(1),
  walkover_type: walkoverTypeSchema.nullable(),
  evidence_status: gameEvidenceStatusSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

// =============================================================================
// Inbound & Debounce Sessions
// =============================================================================

export const reportSessionStatusSchema = z.enum([
  'COLLECTING',
  'PROCESSING',
  'DRAFT_READY',
  'INCOMPLETE',
  'EXPIRED',
  'FAILED',
]);

export const reportSessionSchema = z.object({
  id: uuidSchema,
  fixture_id: uuidSchema,
  game_id: uuidSchema.nullable(),
  submitting_team_id: uuidSchema,
  status: reportSessionStatusSchema,
  last_message_at: isoDateSchema,
  debounce_due_at: isoDateSchema,
  session_expires_at: isoDateSchema.nullable(),
  extension_count: z.number().int().min(0).max(3),
  version: z.number().int().positive(),
  lease_owner: z.string().nullable(),
  lease_expires_at: isoDateSchema.nullable(),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

export const inboundMessageTypeSchema = z.enum([
  'TEXT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'DOCUMENT',
  'OTHER',
]);

export const inboundMessageSchema = z.object({
  id: uuidSchema,
  provider_message_key: z.string().min(1).max(255),
  chat_id: z.string().min(1).max(255),
  sender_raw_address: z.string().min(1).max(255),
  delegate_id: uuidSchema.nullable(),
  message_timestamp: isoDateSchema,
  received_at: isoDateSchema,
  message_type: inboundMessageTypeSchema,
  text_body: z.string().nullable(),
  caption: z.string().nullable(),
  reply_to_key: z.string().nullable(),
  report_session_id: uuidSchema.nullable(),
  raw_metadata_json: z.string(),
  created_at: isoDateSchema,
});

// =============================================================================
// Media Storage
// =============================================================================

export const mediaStorageProviderSchema = z.enum(['VERAX_VM_MEDIA', 'FLASHPEAK_VM_MEDIA']);

export const mediaRoleSchema = z.enum([
  'MAIN_MATCH',
  'GOALKEEPER_DETAIL',
  'SUPPORTING_EVIDENCE',
  'MANUAL_REVIEW',
  'OTHER',
]);

export const mediaVisibilitySchema = z.enum(['PRIVATE', 'PUBLIC']);
export const mediaAssetStatusSchema = z.enum(['STORED', 'QUARANTINED', 'DELETED']);

export const mediaAssetSchema = z.object({
  id: uuidSchema,
  storage_provider: mediaStorageProviderSchema,
  storage_key: z.string().min(1),
  media_role: mediaRoleSchema,
  mime_type: z.string().min(1),
  byte_size: z.number().int().positive(),
  sha256: z.string().length(64),
  visibility: mediaVisibilitySchema,
  status: mediaAssetStatusSchema,
  uploaded_by_delegate_id: uuidSchema.nullable(),
  source_message_id: uuidSchema,
  created_at: isoDateSchema,
});

// =============================================================================
// Report Versions & Extracted Data
// =============================================================================

export const reportVersionStatusSchema = z.enum([
  'DRAFT',
  'NEEDS_CORRECTION',
  'PENDING_APPROVAL',
  'APPROVED',
  'LOCKED',
  'REJECTED',
]);

export const reportProvenanceSchema = z.enum(['AI', 'MANUAL_ENTRY', 'MIXED']);

export const extractedPlayerStatsSchema = z.object({
  nickname_raw: z.string(),
  rating: z.number().nullable(),
  goals: z.number().int().nonnegative().nullable(),
  assists: z.number().int().nonnegative().nullable(),
  passes: z.number().int().nonnegative().nullable(),
  defense: z.number().int().nonnegative().nullable(),
});

export const extractedMatchSummaryDataSchema = z.object({
  team_a_score: z.number().int().nonnegative().nullable(),
  team_b_score: z.number().int().nonnegative().nullable(),
  team_a_players: z.array(extractedPlayerStatsSchema),
  team_b_players: z.array(extractedPlayerStatsSchema),
  confidence: z.number().min(0).max(1),
  unreadable_fields: z.array(z.string()),
});

export const reportVersionSchema = z.object({
  id: uuidSchema,
  report_session_id: uuidSchema,
  fixture_id: uuidSchema,
  version_number: z.number().int().positive(),
  status: reportVersionStatusSchema,
  extraction_json: z.string(),
  validated_data_json: z.string(),
  provenance: reportProvenanceSchema,
  created_by: z.string(),
  created_at: isoDateSchema,
});

export const reportMediaSchema = z.object({
  report_version_id: uuidSchema,
  media_asset_id: uuidSchema,
  game_id: uuidSchema.nullable(),
  media_role: mediaRoleSchema,
});

// =============================================================================
// Player Statistics & Goalkeeper Reports
// =============================================================================

export const playerGameStatsSchema = z.object({
  id: uuidSchema,
  game_id: uuidSchema,
  player_id: uuidSchema,
  team_id: uuidSchema,
  rating: z.number().nullable(),
  goals: z.number().int().nonnegative().nullable(),
  assists: z.number().int().nonnegative().nullable(),
  passes: z.number().int().nonnegative().nullable(),
  defense_raw: z.number().int().nonnegative().nullable(),
  goalkeeper_saves: z.number().int().nonnegative().nullable(),
  stats_json: z.string().nullable(),
  source_report_version_id: uuidSchema,
  is_award_eligible: z.number().int().min(0).max(1),
  created_at: isoDateSchema,
});

export const crossScreenMatchStatusSchema = z.enum([
  'UNIQUE',
  'AMBIGUOUS',
  'UNMATCHED',
  'MANUAL_CONFIRMED',
]);

export const goalkeeperReportSchema = z.object({
  id: uuidSchema,
  game_id: uuidSchema,
  player_id: uuidSchema,
  team_id: uuidSchema,
  detail_media_asset_id: uuidSchema,
  score_left: z.number().int().nonnegative(),
  score_right: z.number().int().nonnegative(),
  screen_result_text: z.string().nullable(),
  summary_rating: z.number().nullable(),
  summary_goals: z.number().int().nonnegative().nullable(),
  summary_assists: z.number().int().nonnegative().nullable(),
  summary_passes: z.number().int().nonnegative().nullable(),
  raw_defense_value: z.number().int().nonnegative().nullable(),
  goalkeeper_saves: z.number().int().nonnegative().nullable(),
  visual_goalkeeper_cue: z.string().nullable(),
  cross_screen_match_status: crossScreenMatchStatusSchema,
  award_eligible: z.number().int().min(0).max(1),
  created_at: isoDateSchema,
});

// =============================================================================
// Corrections & Approvals
// =============================================================================

export const correctionStatusSchema = z.enum([
  'PROPOSED',
  'NEEDS_CLARIFICATION',
  'ACCEPTED',
  'REJECTED',
]);

export const structuredCorrectionPatchSchema = z.object({
  target_report_version_id: uuidSchema,
  team_side: z.enum(['TEAM_A', 'TEAM_B']).optional(),
  team_name: z.string().optional(),
  player_ordinal: z.number().int().positive().optional(),
  player_nickname: z.string().optional(),
  metric: z.enum(['goals', 'assists', 'passes', 'defense', 'rating', 'score']),
  stated_old_value: z.union([z.number(), z.string()]).nullable(),
  new_value: z.union([z.number(), z.string()]),
  reason: z.string().optional(),
  ambiguity_flags: z.array(z.string()),
});

export const correctionSchema = z.object({
  id: uuidSchema,
  report_version_id: uuidSchema,
  inbound_message_id: uuidSchema,
  submitted_by_delegate_id: uuidSchema.nullable(),
  parsed_patch_json: z.string(),
  status: correctionStatusSchema,
  organizer_reason: z.string().nullable(),
  created_at: isoDateSchema,
  resolved_at: isoDateSchema.nullable(),
});

export const approverTypeSchema = z.enum(['TEAM_A', 'TEAM_B', 'ORGANIZER']);
export const approvalDecisionSchema = z.enum(['APPROVE', 'REJECT']);

export const approvalSchema = z.object({
  id: uuidSchema,
  report_version_id: uuidSchema,
  approver_type: approverTypeSchema,
  approver_id: z.string().min(1),
  decision: approvalDecisionSchema,
  created_at: isoDateSchema,
});

// =============================================================================
// Standings Projection
// =============================================================================

export const standingSchema = z.object({
  tournament_id: uuidSchema,
  group_id: uuidSchema,
  team_id: uuidSchema,
  played: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  goals_for: z.number().int().nonnegative(),
  goals_against: z.number().int().nonnegative(),
  goal_difference: z.number().int(),
  points: z.number().int().nonnegative(),
  head_to_head_points: z.number().int().nonnegative().default(0),
  computed_at: isoDateSchema,
  source_revision: z.string(),
});

// =============================================================================
// Audit & Telemetry
// =============================================================================

export const auditActorTypeSchema = z.enum(['SYSTEM', 'DELEGATE', 'ORGANIZER']);

export const auditEventSchema = z.object({
  id: uuidSchema,
  actor_type: auditActorTypeSchema,
  actor_id: z.string().min(1),
  event_type: z.string().min(1),
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  before_json: z.string().nullable(),
  after_json: z.string().nullable(),
  reason: z.string().nullable(),
  correlation_id: z.string().min(1),
  created_at: isoDateSchema,
});

export const aiProviderNameSchema = z.enum(['GROQ', 'GEMINI', 'OLLAMA_CLOUD']);

export const aiTaskTypeSchema = z.enum([
  'CLASSIFY',
  'EXTRACT_MATCH',
  'EXTRACT_GOALKEEPER',
  'PARSE_CORRECTION',
]);

export const aiRequestStatusSchema = z.enum([
  'SUCCESS',
  'ERROR',
  'RATE_LIMITED',
  'TIMEOUT',
]);

export const providerUsageSchema = z.object({
  id: uuidSchema,
  provider: aiProviderNameSchema,
  model: z.string().min(1),
  task_type: aiTaskTypeSchema,
  request_status: aiRequestStatusSchema,
  input_units: z.number().int().nonnegative().nullable(),
  output_units: z.number().int().nonnegative().nullable(),
  latency_ms: z.number().int().nonnegative(),
  error_code: z.string().nullable(),
  created_at: isoDateSchema,
});
