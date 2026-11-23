-- =============================================================================
-- Migration: 001_initial.sql
-- Description: Full initial relational schema for Flash Peak TMS
-- Dialect: SQLite / Turso libSQL
-- Invariants: Foreign keys enabled, stable UUID keys, immutable versions, audit trails
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 0. Migrations Meta Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 1. Tournaments
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'REGISTRATION', 'ONBOARDING', 'DRAW_READY', 'ACTIVE', 'COMPLETED', 'ARCHIVED')),
    timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    rules_version TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);

-- -----------------------------------------------------------------------------
-- 2. Delegates
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delegates (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 3. WhatsApp Identities (JID, LID, Phone aliases tied to delegate)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_identities (
    id TEXT PRIMARY KEY,
    delegate_id TEXT NOT NULL REFERENCES delegates(id) ON DELETE CASCADE,
    raw_address TEXT NOT NULL UNIQUE,
    address_type TEXT NOT NULL CHECK (address_type IN ('JID', 'LID', 'PHONE', 'UNKNOWN')),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    verified_at TEXT,
    source_chat_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_identities_delegate ON whatsapp_identities(delegate_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_identities_address ON whatsapp_identities(raw_address);

-- -----------------------------------------------------------------------------
-- 4. Teams
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    organization_name TEXT,
    division_name TEXT,
    team_name TEXT NOT NULL,
    team_code TEXT,
    delegate_id TEXT REFERENCES delegates(id) ON DELETE SET NULL,
    registration_status TEXT NOT NULL CHECK (registration_status IN ('PENDING', 'VERIFIED', 'DISQUALIFIED', 'WITHDRAWN')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT uq_team_tournament_name UNIQUE (tournament_id, team_name)
);

CREATE INDEX IF NOT EXISTS idx_teams_tournament ON teams(tournament_id);
CREATE INDEX IF NOT EXISTS idx_teams_delegate ON teams(delegate_id);

-- -----------------------------------------------------------------------------
-- 5. Bot Instances
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_instances (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'BOT' CHECK (role = 'BOT'),
    raw_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE', 'DEGRADED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 6. Players
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    nickname_raw TEXT NOT NULL,
    nickname_nfc TEXT NOT NULL,
    nickname_search_key TEXT NOT NULL,
    position TEXT NOT NULL CHECK (position IN ('GOALKEEPER', 'OUTFIELD')),
    roster_slot INTEGER NOT NULL CHECK (roster_slot BETWEEN 1 AND 10),
    roster_type TEXT NOT NULL CHECK (roster_type IN ('STARTER', 'SUBSTITUTE')),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'INELIGIBLE')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT uq_player_team_slot UNIQUE (team_id, roster_slot),
    CONSTRAINT uq_player_tournament_nickname UNIQUE (tournament_id, nickname_nfc)
);

CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_players_search_key ON players(tournament_id, nickname_search_key);

-- -----------------------------------------------------------------------------
-- 7. Group Draws
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_draws (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('PREPARED', 'REVEALING', 'COMPLETED', 'CANCELLED')),
    group_config_json TEXT NOT NULL,
    eligible_team_snapshot_json TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    commitment_hash TEXT,
    seed_reveal TEXT,
    result_json TEXT,
    next_reveal_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_group_draws_tournament ON group_draws(tournament_id);

-- -----------------------------------------------------------------------------
-- 8. Groups
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    draw_id TEXT NOT NULL REFERENCES group_draws(id) ON DELETE CASCADE,
    group_code TEXT NOT NULL,
    display_order INTEGER NOT NULL,
    CONSTRAINT uq_groups_draw_code UNIQUE (draw_id, group_code)
);

-- -----------------------------------------------------------------------------
-- 9. Group Members
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    draw_position INTEGER NOT NULL,
    PRIMARY KEY (group_id, team_id),
    CONSTRAINT uq_group_draw_position UNIQUE (group_id, draw_position)
);

CREATE INDEX IF NOT EXISTS idx_group_members_team ON group_members(team_id);

-- -----------------------------------------------------------------------------
-- 10. Fixtures
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixtures (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('GROUP', 'KNOCKOUT')),
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    round_code TEXT,
    team_a_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    team_b_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    left_side_team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    scheduled_at TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    host_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    host_assignment_reason TEXT CHECK (host_assignment_reason IN ('DEFAULT_LEFT_SIDE', 'OPPONENT_SUBSTITUTED', 'ORGANIZER_OVERRIDE')),
    status TEXT NOT NULL CHECK (status IN ('SCHEDULED', 'READY', 'IN_PROGRESS', 'REPORT_PENDING', 'DISPUTED', 'COMPLETED', 'WALKOVER', 'CANCELLED')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fixtures_tournament ON fixtures(tournament_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_stage_group ON fixtures(stage, group_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_teams ON fixtures(team_a_id, team_b_id);

-- -----------------------------------------------------------------------------
-- 11. Series (BO3 / BO5)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL UNIQUE REFERENCES fixtures(id) ON DELETE CASCADE,
    format TEXT NOT NULL CHECK (format IN ('BO3', 'BO5')),
    target_wins INTEGER NOT NULL CHECK (target_wins IN (2, 3)),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')),
    winner_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    team_a_game_wins INTEGER NOT NULL DEFAULT 0,
    team_b_game_wins INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 12. Games
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
    series_id TEXT REFERENCES series(id) ON DELETE CASCADE,
    game_number INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'REPORT_PENDING', 'DISPUTED', 'COMPLETED', 'WALKOVER')),
    team_a_score INTEGER,
    team_b_score INTEGER,
    winner_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    is_draw INTEGER NOT NULL DEFAULT 0 CHECK (is_draw IN (0, 1)),
    is_walkover INTEGER NOT NULL DEFAULT 0 CHECK (is_walkover IN (0, 1)),
    walkover_type TEXT CHECK (walkover_type IN ('NONE', 'SINGLE_FORFEIT', 'DOUBLE_ROOM_CARD_UNAVAILABLE', 'DOUBLE_ABSENT')),
    evidence_status TEXT NOT NULL CHECK (evidence_status IN ('PENDING', 'RECEIVED', 'VERIFIED', 'MISSING')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT uq_games_fixture_number UNIQUE (fixture_id, game_number)
);

CREATE INDEX IF NOT EXISTS idx_games_series ON games(series_id);

-- -----------------------------------------------------------------------------
-- 13. Report Sessions (Debounce & Intake)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_sessions (
    id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
    game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
    submitting_team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('COLLECTING', 'PROCESSING', 'DRAFT_READY', 'INCOMPLETE', 'EXPIRED', 'FAILED')),
    last_message_at TEXT NOT NULL,
    debounce_due_at TEXT NOT NULL,
    session_expires_at TEXT,
    extension_count INTEGER NOT NULL DEFAULT 0 CHECK (extension_count BETWEEN 0 AND 3),
    version INTEGER NOT NULL DEFAULT 1,
    lease_owner TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_sessions_debounce ON report_sessions(status, debounce_due_at);
CREATE INDEX IF NOT EXISTS idx_report_sessions_fixture ON report_sessions(fixture_id);

-- -----------------------------------------------------------------------------
-- 14. Inbound Messages
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbound_messages (
    id TEXT PRIMARY KEY,
    provider_message_key TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    sender_raw_address TEXT NOT NULL,
    delegate_id TEXT REFERENCES delegates(id) ON DELETE SET NULL,
    message_timestamp TEXT NOT NULL,
    received_at TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'OTHER')),
    text_body TEXT,
    caption TEXT,
    reply_to_key TEXT,
    report_session_id TEXT REFERENCES report_sessions(id) ON DELETE SET NULL,
    raw_metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_session ON inbound_messages(report_session_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_key ON inbound_messages(provider_message_key);

-- -----------------------------------------------------------------------------
-- 15. Media Assets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    storage_provider TEXT NOT NULL CHECK (storage_provider IN ('VERAX_VM_MEDIA', 'FLASHPEAK_VM_MEDIA')),
    storage_key TEXT NOT NULL,
    media_role TEXT NOT NULL CHECK (media_role IN ('MAIN_MATCH', 'GOALKEEPER_DETAIL', 'SUPPORTING_EVIDENCE', 'MANUAL_REVIEW', 'OTHER')),
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('PRIVATE', 'PUBLIC')),
    status TEXT NOT NULL CHECK (status IN ('STORED', 'QUARANTINED', 'DELETED')),
    uploaded_by_delegate_id TEXT REFERENCES delegates(id) ON DELETE SET NULL,
    source_message_id TEXT NOT NULL REFERENCES inbound_messages(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_assets_hash ON media_assets(sha256);
CREATE INDEX IF NOT EXISTS idx_media_assets_message ON media_assets(source_message_id);

-- -----------------------------------------------------------------------------
-- 16. Report Versions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_versions (
    id TEXT PRIMARY KEY,
    report_session_id TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    fixture_id TEXT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'NEEDS_CORRECTION', 'PENDING_APPROVAL', 'APPROVED', 'LOCKED', 'REJECTED')),
    extraction_json TEXT NOT NULL,
    validated_data_json TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('AI', 'MANUAL_ENTRY', 'MIXED')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT uq_report_versions_session_number UNIQUE (report_session_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_report_versions_fixture ON report_versions(fixture_id);

-- -----------------------------------------------------------------------------
-- 17. Report Media Junction
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_media (
    report_version_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
    media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
    media_role TEXT NOT NULL CHECK (media_role IN ('MAIN_MATCH', 'GOALKEEPER_DETAIL', 'SUPPORTING_EVIDENCE', 'MANUAL_REVIEW', 'OTHER')),
    PRIMARY KEY (report_version_id, media_asset_id)
);

-- -----------------------------------------------------------------------------
-- 18. Player Game Stats
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_game_stats (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    rating REAL,
    goals INTEGER DEFAULT 0,
    assists INTEGER DEFAULT 0,
    passes INTEGER DEFAULT 0,
    defense_raw INTEGER DEFAULT 0,
    goalkeeper_saves INTEGER,
    stats_json TEXT,
    source_report_version_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE RESTRICT,
    is_award_eligible INTEGER NOT NULL DEFAULT 1 CHECK (is_award_eligible IN (0, 1)),
    created_at TEXT NOT NULL,
    CONSTRAINT uq_player_game_stats UNIQUE (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_player_game_stats_player ON player_game_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_player_game_stats_team ON player_game_stats(team_id);

-- -----------------------------------------------------------------------------
-- 19. Goalkeeper Reports
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goalkeeper_reports (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    detail_media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    score_left INTEGER NOT NULL,
    score_right INTEGER NOT NULL,
    screen_result_text TEXT,
    summary_rating REAL,
    summary_goals INTEGER,
    summary_assists INTEGER,
    summary_passes INTEGER,
    raw_defense_value INTEGER,
    goalkeeper_saves INTEGER,
    visual_goalkeeper_cue TEXT,
    cross_screen_match_status TEXT NOT NULL CHECK (cross_screen_match_status IN ('UNIQUE', 'AMBIGUOUS', 'UNMATCHED', 'MANUAL_CONFIRMED')),
    award_eligible INTEGER NOT NULL DEFAULT 1 CHECK (award_eligible IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goalkeeper_reports_game ON goalkeeper_reports(game_id);
CREATE INDEX IF NOT EXISTS idx_goalkeeper_reports_player ON goalkeeper_reports(player_id);

-- -----------------------------------------------------------------------------
-- 20. Corrections
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corrections (
    id TEXT PRIMARY KEY,
    report_version_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
    inbound_message_id TEXT NOT NULL REFERENCES inbound_messages(id) ON DELETE CASCADE,
    submitted_by_delegate_id TEXT REFERENCES delegates(id) ON DELETE SET NULL,
    parsed_patch_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'NEEDS_CLARIFICATION', 'ACCEPTED', 'REJECTED')),
    organizer_reason TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_corrections_version ON corrections(report_version_id);

-- -----------------------------------------------------------------------------
-- 21. Approvals (Three-party: Team A, Team B, Organizer)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    report_version_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
    approver_type TEXT NOT NULL CHECK (approver_type IN ('TEAM_A', 'TEAM_B', 'ORGANIZER')),
    approver_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
    created_at TEXT NOT NULL,
    CONSTRAINT uq_approvals_version_approver UNIQUE (report_version_id, approver_type, approver_id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_version ON approvals(report_version_id);

-- -----------------------------------------------------------------------------
-- 22. Standings (Persisted projection rebuildable from locked games)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS standings (
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    goals_for INTEGER NOT NULL DEFAULT 0,
    goals_against INTEGER NOT NULL DEFAULT 0,
    goal_difference INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    head_to_head_points INTEGER NOT NULL DEFAULT 0,
    computed_at TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    PRIMARY KEY (tournament_id, group_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_standings_group_rank ON standings(group_id, points DESC, goal_difference DESC, goals_for DESC);

-- -----------------------------------------------------------------------------
-- 23. Audit Events
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'DELEGATE', 'ORGANIZER')),
    actor_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation ON audit_events(correlation_id);

-- -----------------------------------------------------------------------------
-- 24. Provider Usage (Telemetry & Quota Tracking)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_usage (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('GROQ', 'GEMINI', 'OLLAMA_CLOUD')),
    model TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK (task_type IN ('CLASSIFY', 'EXTRACT_MATCH', 'EXTRACT_GOALKEEPER', 'PARSE_CORRECTION')),
    request_status TEXT NOT NULL CHECK (request_status IN ('SUCCESS', 'ERROR', 'RATE_LIMITED', 'TIMEOUT')),
    input_units INTEGER,
    output_units INTEGER,
    latency_ms INTEGER NOT NULL,
    error_code TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_provider ON provider_usage(provider, created_at);
