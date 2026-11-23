/**
 * Flash Peak TMS - Core Domain Model & Shared Types
 * 
 * Authoritative types based on DATA_MODEL.md, FRD.md, and DECISIONS.md.
 * Backend owns all business logic; types reflect deterministic state transitions.
 */

// =============================================================================
// Common & Identifier Primitives
// =============================================================================

export type UUID = string;
export type ISODateString = string; // UTC ISO-8601 (e.g. 2026-11-18T08:00:00.000Z)

// =============================================================================
// Tournaments
// =============================================================================

export type TournamentStatus =
  | 'DRAFT'
  | 'REGISTRATION'
  | 'ONBOARDING'
  | 'DRAW_READY'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'ARCHIVED';

export interface TournamentConfig {
  game_duration_minutes: number;
  kickoff_time: string; // e.g. "21:00"
  confirmation_deadline: string; // e.g. "20:00"
  grace_period_minutes: number;
  report_window_minutes: number;
  group_qualifiers_per_group: number; // default: 2 (FR-COMP-011)
  points_win: number; // default: 3
  points_draw: number; // default: 1
  points_loss: number; // default: 0
  wo_goals_winner: number; // default: 3
  wo_goals_loser: number; // default: 0
}

export interface Tournament {
  id: UUID;
  name: string;
  status: TournamentStatus;
  timezone: string; // default: "Asia/Jakarta"
  rules_version: string;
  config_json: string; // Serialized TournamentConfig
  created_at: ISODateString;
  updated_at: ISODateString;
}

// =============================================================================
// Teams & Registration
// =============================================================================

export type TeamRegistrationStatus =
  | 'PENDING'
  | 'VERIFIED'
  | 'DISQUALIFIED'
  | 'WITHDRAWN';

export interface Team {
  id: UUID;
  tournament_id: UUID;
  organization_name: string | null;
  division_name: string | null;
  team_name: string;
  team_code: string | null;
  delegate_id: UUID | null;
  registration_status: TeamRegistrationStatus;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// =============================================================================
// Delegates & WhatsApp Identities
// =============================================================================

export type DelegateStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

export interface Delegate {
  id: UUID;
  display_name: string;
  status: DelegateStatus;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export type WhatsAppAddressType = 'JID' | 'LID' | 'PHONE' | 'UNKNOWN';

export interface WhatsAppIdentity {
  id: UUID;
  delegate_id: UUID;
  raw_address: string;
  address_type: WhatsAppAddressType;
  is_primary: number; // 0 | 1
  verified_at: ISODateString | null;
  source_chat_id: string | null;
  created_at: ISODateString;
}

// =============================================================================
// Bot Instances
// =============================================================================

export type BotRole = 'BOT';
export type BotInstanceStatus = 'ONLINE' | 'OFFLINE' | 'DEGRADED';

export interface BotInstance {
  id: UUID;
  role: BotRole;
  raw_address: string;
  status: BotInstanceStatus;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// =============================================================================
// Players & Roster
// =============================================================================

export type PlayerPosition = 'GOALKEEPER' | 'OUTFIELD';
export type RosterType = 'STARTER' | 'SUBSTITUTE';
export type PlayerStatus = 'ACTIVE' | 'SUSPENDED' | 'INELIGIBLE';

export interface Player {
  id: UUID;
  tournament_id: UUID;
  team_id: UUID;
  nickname_raw: string; // Exact raw Unicode string (canonical display)
  nickname_nfc: string; // Derived NFC normalized string
  nickname_search_key: string; // Derived case-folded search string
  position: PlayerPosition;
  roster_slot: number; // 1..10
  roster_type: RosterType;
  status: PlayerStatus;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// =============================================================================
// Group Draw
// =============================================================================

export type DrawStatus = 'PREPARED' | 'REVEALING' | 'COMPLETED' | 'CANCELLED';

export interface GroupConfigJson {
  total_teams: number;
  num_groups: number;
  group_sizes: number[]; // e.g. [5, 5, 5, 4, 4] (FR-COMP-010)
  group_codes: string[]; // e.g. ["A", "B", "C", "D", "E"]
  qualifiers_per_group: number; // 2
}

export interface EligibleTeamSnapshotItem {
  team_id: UUID;
  team_name: string;
  organization_name: string | null;
  division_name: string | null;
  delegate_id: UUID;
}

export interface DrawResultGroupAssignment {
  group_code: string;
  teams: {
    team_id: UUID;
    team_name: string;
    draw_position: number;
  }[];
}

export interface GroupDraw {
  id: UUID;
  tournament_id: UUID;
  status: DrawStatus;
  group_config_json: string; // Serialized GroupConfigJson
  eligible_team_snapshot_json: string; // Serialized EligibleTeamSnapshotItem[]
  algorithm: string; // e.g. "FISHER_YATES_CRYPTO"
  algorithm_version: string; // e.g. "1.0.0"
  commitment_hash: string | null; // SHA-256 pre-reveal commitment
  seed_reveal: string | null; // Random seed disclosed after completion
  result_json: string | null; // Serialized DrawResultGroupAssignment[]
  next_reveal_index: number; // Tracks progressive reveal progress (FR-COMP-005)
  created_at: ISODateString;
  completed_at: ISODateString | null;
}

export interface Group {
  id: UUID;
  draw_id: UUID;
  group_code: string;
  display_order: number;
}

export interface GroupMember {
  group_id: UUID;
  team_id: UUID;
  draw_position: number;
}

// =============================================================================
// Fixtures & Scheduling
// =============================================================================

export type CompetitionStage = 'GROUP' | 'KNOCKOUT';

export type HostAssignmentReason =
  | 'DEFAULT_LEFT_SIDE'
  | 'OPPONENT_SUBSTITUTED'
  | 'ORGANIZER_OVERRIDE';

export type FixtureStatus =
  | 'SCHEDULED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'REPORT_PENDING'
  | 'DISPUTED'
  | 'COMPLETED'
  | 'WALKOVER'
  | 'CANCELLED';

export interface Fixture {
  id: UUID;
  tournament_id: UUID;
  stage: CompetitionStage;
  group_id: UUID | null;
  round_code: string | null; // e.g. "RO16", "QF", "SF", "FINAL", "3RD_PLACE"
  team_a_id: UUID;
  team_b_id: UUID;
  /**
   * left_side_team_id: Assigned at fixture-generation time under the fairness balancing rule (FR-COMP-013).
   * Determines the default recommended room host.
   */
  left_side_team_id: UUID;
  scheduled_at: ISODateString | null;
  timezone: string; // "Asia/Jakarta"
  /**
   * host_team_id: The team that actually hosted the match. Recorded once confirmed.
   */
  host_team_id: UUID | null;
  host_assignment_reason: HostAssignmentReason | null;
  status: FixtureStatus;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// =============================================================================
// Series (Knockout BO3 / BO5)
// =============================================================================

export type SeriesFormat = 'BO3' | 'BO5';
export type SeriesStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';

export interface Series {
  id: UUID;
  fixture_id: UUID; // 1-to-1 unique mapping to fixture
  format: SeriesFormat;
  target_wins: number; // 2 for BO3, 3 for BO5
  status: SeriesStatus;
  winner_team_id: UUID | null;
  team_a_game_wins: number;
  team_b_game_wins: number;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// =============================================================================
// Games (Individual Matches within Fixture / Series)
// =============================================================================

export type GameStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'REPORT_PENDING'
  | 'DISPUTED'
  | 'COMPLETED'
  | 'WALKOVER';

export type WalkoverType =
  | 'NONE'
  | 'SINGLE_FORFEIT'
  | 'DOUBLE_ROOM_CARD_UNAVAILABLE'
  | 'DOUBLE_ABSENT';

export type GameEvidenceStatus =
  | 'PENDING'
  | 'RECEIVED'
  | 'VERIFIED'
  | 'MISSING';

export interface Game {
  id: UUID;
  fixture_id: UUID;
  series_id: UUID | null;
  game_number: number; // 1 for Group Stage; 1..n for BO3/BO5. Replayed tied game reuses same slot (FR-CALC-005).
  status: GameStatus;
  team_a_score: number | null;
  team_b_score: number | null;
  winner_team_id: UUID | null;
  is_draw: number; // 0 | 1 (Genuine in-game draw, 1 pt each in Group Stage per FR-CALC-001)
  is_walkover: number; // 0 | 1
  walkover_type: WalkoverType | null; // Explicit separation of genuine draw vs double walkover (D-031)
  evidence_status: GameEvidenceStatus;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// =============================================================================
// Inbound Ingestion & Debounce Sessions
// =============================================================================

export type ReportSessionStatus =
  | 'COLLECTING'
  | 'PROCESSING'
  | 'DRAFT_READY'
  | 'INCOMPLETE'
  | 'EXPIRED'
  | 'FAILED';

export interface ReportSession {
  id: UUID;
  fixture_id: UUID;
  game_id: UUID | null;
  submitting_team_id: UUID;
  status: ReportSessionStatus;
  last_message_at: ISODateString;
  debounce_due_at: ISODateString; // Sliding window: now + 5s (FR-ING-003)
  session_expires_at: ISODateString | null; // Base window (e.g. 10m) + extensions
  extension_count: number; // Capped at 3 extensions max (FR-ING-008 / D-033)
  version: number; // Incremented on every reset for lease validation
  lease_owner: string | null; // Worker ID claiming the batch
  lease_expires_at: ISODateString | null;
  ai_retry_count: number; // AI retries used so far (AllProvidersFailedError only, migration 003)
  created_at: ISODateString;
  updated_at: ISODateString;
}

export type InboundMessageType =
  | 'TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'AUDIO'
  | 'DOCUMENT'
  | 'OTHER';

export interface InboundMessage {
  id: UUID;
  provider_message_key: string; // Stable unique Baileys key for deduplication
  chat_id: string; // WhatsApp chat JID (e.g. group JID)
  sender_raw_address: string; // JID or LID of participant
  delegate_id: UUID | null;
  message_timestamp: ISODateString;
  received_at: ISODateString;
  message_type: InboundMessageType;
  text_body: string | null;
  caption: string | null;
  reply_to_key: string | null;
  report_session_id: UUID | null;
  raw_metadata_json: string;
  created_at: ISODateString;
}

// =============================================================================
// Media Storage
// =============================================================================

export type MediaStorageProvider = 'VERAX_VM_MEDIA' | 'FLASHPEAK_VM_MEDIA';

export type MediaRole =
  | 'MAIN_MATCH'
  | 'GOALKEEPER_DETAIL'
  | 'SUPPORTING_EVIDENCE'
  | 'MANUAL_REVIEW'
  | 'OTHER';

export type MediaVisibility = 'PRIVATE' | 'PUBLIC';
export type MediaAssetStatus = 'STORED' | 'QUARANTINED' | 'DELETED';

export interface MediaAsset {
  id: UUID;
  storage_provider: MediaStorageProvider;
  storage_key: string; // Relative path generated by media service
  media_role: MediaRole;
  mime_type: string;
  byte_size: number;
  sha256: string; // Verification hash
  visibility: MediaVisibility; // Default: PRIVATE (INFRASTRUCTURE.md §4)
  status: MediaAssetStatus;
  uploaded_by_delegate_id: UUID | null;
  source_message_id: UUID;
  created_at: ISODateString;
}

// =============================================================================
// Report Versioning & Extraction Lifecycles
// =============================================================================

export type ReportVersionStatus =
  | 'DRAFT'
  | 'NEEDS_CORRECTION'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'LOCKED'
  | 'REJECTED';

export type ReportProvenance = 'AI' | 'MANUAL_ENTRY' | 'MIXED';

export interface ExtractedPlayerStats {
  nickname_raw: string;
  rating: number | null;
  goals: number | null;
  assists: number | null;
  passes: number | null;
  defense: number | null; // Raw DEFENSE metric from summary
}

export interface ExtractedMatchSummaryData {
  team_a_score: number | null;
  team_b_score: number | null;
  team_a_players: ExtractedPlayerStats[];
  team_b_players: ExtractedPlayerStats[];
  confidence: number;
  unreadable_fields: string[];
}

export interface ValidatedMatchData {
  fixture_id: UUID;
  game_id: UUID;
  team_a_id: UUID;
  team_b_id: UUID;
  team_a_score: number;
  team_b_score: number;
  team_a_players: {
    player_id: UUID;
    nickname_raw: string;
    rating: number | null;
    goals: number;
    assists: number;
    passes: number;
    defense_raw: number;
    goalkeeper_saves: number | null;
  }[];
  team_b_players: {
    player_id: UUID;
    nickname_raw: string;
    rating: number | null;
    goals: number;
    assists: number;
    passes: number;
    defense_raw: number;
    goalkeeper_saves: number | null;
  }[];
}

export interface ReportVersion {
  id: UUID;
  report_session_id: UUID;
  fixture_id: UUID;
  version_number: number;
  status: ReportVersionStatus;
  extraction_json: string; // Raw AI extraction payload
  validated_data_json: string; // Deterministically validated payload
  provenance: ReportProvenance;
  created_by: string; // 'AI_PIPELINE' or organizer user ID
  created_at: ISODateString;
}

export interface ReportMedia {
  report_version_id: UUID;
  media_asset_id: UUID;
  game_id: UUID | null;
  media_role: MediaRole;
}

// =============================================================================
// Player Statistics & Awards
// =============================================================================

export interface PlayerGameStats {
  id: UUID;
  game_id: UUID;
  player_id: UUID;
  team_id: UUID;
  rating: number | null;
  goals: number | null;
  assists: number | null;
  passes: number | null;
  defense_raw: number | null;
  goalkeeper_saves: number | null; // Extracted & confirmed saves (FR-GK-003)
  stats_json: string | null;
  source_report_version_id: UUID;
  is_award_eligible: number; // 0 | 1 (Walkover games ineligible per FR-CALC-006)
  created_at: ISODateString;
}

export type CrossScreenMatchStatus =
  | 'UNIQUE'
  | 'AMBIGUOUS'
  | 'UNMATCHED'
  | 'MANUAL_CONFIRMED';

export interface GoalkeeperReport {
  id: UUID;
  game_id: UUID;
  player_id: UUID;
  team_id: UUID;
  detail_media_asset_id: UUID;
  score_left: number;
  score_right: number;
  screen_result_text: string | null;
  summary_rating: number | null;
  summary_goals: number | null;
  summary_assists: number | null;
  summary_passes: number | null;
  raw_defense_value: number | null;
  goalkeeper_saves: number | null;
  visual_goalkeeper_cue: string | null; // "CAP_GLOVES_BALL_HELD" (FR-GK-001)
  cross_screen_match_status: CrossScreenMatchStatus;
  award_eligible: number; // 0 | 1 (All submitted winning GK records are eligible per FR-GK-008)
  created_at: ISODateString;
}

// =============================================================================
// Corrections & Three-Party Approvals
// =============================================================================

export type CorrectionStatus =
  | 'PROPOSED'
  | 'NEEDS_CLARIFICATION'
  | 'ACCEPTED'
  | 'REJECTED';

export interface StructuredCorrectionPatch {
  target_report_version_id: UUID;
  team_side?: 'TEAM_A' | 'TEAM_B';
  team_name?: string;
  player_ordinal?: number; // 1-based index in team lineup
  player_nickname?: string;
  metric: 'goals' | 'assists' | 'passes' | 'defense' | 'rating' | 'score';
  stated_old_value: number | string | null;
  new_value: number | string;
  reason?: string;
  ambiguity_flags: string[];
}

export interface Correction {
  id: UUID;
  report_version_id: UUID;
  inbound_message_id: UUID;
  submitted_by_delegate_id: UUID | null;
  parsed_patch_json: string; // Serialized StructuredCorrectionPatch
  status: CorrectionStatus;
  organizer_reason: string | null;
  created_at: ISODateString;
  resolved_at: ISODateString | null;
}

export type ApproverType = 'TEAM_A' | 'TEAM_B' | 'ORGANIZER';
export type ApprovalDecision = 'APPROVE' | 'REJECT';

export interface Approval {
  id: UUID;
  report_version_id: UUID; // Bound to immutable version (FR-APR-002)
  approver_type: ApproverType;
  approver_id: string; // delegate_id or organizer identifier
  decision: ApprovalDecision;
  created_at: ISODateString;
}

// =============================================================================
// Standings Projection
// =============================================================================

export interface Standing {
  tournament_id: UUID;
  group_id: UUID;
  team_id: UUID;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goals_for: number;
  goals_against: number;
  goal_difference: number;
  points: number;
  head_to_head_points: number;
  computed_at: ISODateString;
  source_revision: string;
}

// =============================================================================
// Audit & Telemetry
// =============================================================================

export type AuditActorType = 'SYSTEM' | 'DELEGATE' | 'ORGANIZER';

export interface AuditEvent {
  id: UUID;
  actor_type: AuditActorType;
  actor_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  correlation_id: string;
  created_at: ISODateString;
}

export type AIProviderName =
  | 'GROQ'
  | 'GEMINI'
  | 'OLLAMA_CLOUD'
  | 'NVIDIA_NIM'
  | 'DEEPSEEK'
  | 'COHERE'
  | 'MISTRAL';

export type AITaskType =
  | 'CLASSIFY'
  | 'EXTRACT_MATCH'
  | 'EXTRACT_GOALKEEPER'
  | 'PARSE_CORRECTION'
  | 'PARSE_ROSTER'
  // AI-native expansion (D-037..D-040, per task brief 2026-11-22):
  | 'CHAT_OMAK_PEAK'      // !ai — read-only chat with Omak Peak persona
  | 'PLAN_AGENT'          // organizer AI agent — interpret NL instruction -> typed action plan
  | 'EXTRACT_QNA'         // !saveqna — extract Q&A pairs from group chat history
  | 'FORMAT_HYPE'         // engagement — hype recap / standings commentary from real data
  | 'GENERATE_PANTUN'     // engagement — pantun generator (no factual claims)
  | 'REPHRASE_TRIVIA';    // engagement — rephrase verified trivia fact for variety

export type AIRequestStatus =
  | 'SUCCESS'
  | 'ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT';

export interface ProviderUsage {
  id: UUID;
  provider: AIProviderName;
  model: string;
  task_type: AITaskType;
  request_status: AIRequestStatus;
  input_units: number | null;
  output_units: number | null;
  latency_ms: number;
  error_code: string | null;
  created_at: ISODateString;
}
