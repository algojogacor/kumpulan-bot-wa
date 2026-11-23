# Database Design
## Turso / libSQL

**Canonical database:** Turso Cloud (libSQL)  
**ORM option:** Drizzle ORM, subject to compatibility review at implementation time.

## 1. Design principles

- Human-inspectable records; no unnecessary field-level encryption.
- Store raw Unicode nickname unchanged.
- Store normalized/search forms separately.
- Do not put image binaries in the database.
- Use stable internal IDs, not WhatsApp JIDs, as relational keys.
- Preserve immutable versions and audit events.
- All timestamps are UTC ISO-8601 or integer epoch consistently; display in Asia/Jakarta.
- API keys and Baileys auth credentials do not belong in ordinary business tables.

## 2. Proposed entities

### tournaments
- `id` TEXT PK
- `name` TEXT
- `status` TEXT: DRAFT, REGISTRATION, ONBOARDING, DRAW_READY, ACTIVE, COMPLETED, ARCHIVED
- `timezone` TEXT default `Asia/Jakarta`
- `rules_version` TEXT
- `config_json` TEXT
- `created_at`, `updated_at`

### teams
- `id` TEXT PK
- `tournament_id` FK
- `organization_name` TEXT nullable
- `division_name` TEXT nullable
- `team_name` TEXT
- `team_code` TEXT nullable
- `delegate_id` FK nullable
- `registration_status` TEXT
- `created_at`, `updated_at`
- Unique `(tournament_id, team_name)` unless organizer explicitly permits same visible name under distinct divisions.

### delegates
- `id` TEXT PK
- `display_name` TEXT
- `status` TEXT
- `created_at`, `updated_at`

### whatsapp_identities
- `id` TEXT PK
- `delegate_id` FK
- `raw_address` TEXT
- `address_type` TEXT (JID, LID, PHONE, UNKNOWN)
- `is_primary` INTEGER
- `verified_at` TEXT nullable
- `source_chat_id` TEXT nullable
- `created_at`
- Unique `(raw_address)` where practical.
- Keep alias history; do not collapse JID and LID without verified mapping.

### bot_instances
- `id` TEXT PK
- `role` TEXT (BOT)
- `raw_address` TEXT
- `status` TEXT
- Never store auth secrets in this table.

### players
- `id` TEXT PK
- `tournament_id` FK
- `team_id` FK
- `nickname_raw` TEXT
- `nickname_nfc` TEXT
- `nickname_search_key` TEXT
- `position` TEXT: GOALKEEPER, OUTFIELD
- `roster_slot` INTEGER
- `roster_type` TEXT: STARTER, SUBSTITUTE
- `status` TEXT
- `created_at`, `updated_at`
- Preserve `nickname_raw`; derived fields are not display truth.

### group_draws
- `id` TEXT PK
- `tournament_id` FK
- `status` TEXT: PREPARED, REVEALING, COMPLETED, CANCELLED
- `group_config_json` TEXT
- `eligible_team_snapshot_json` TEXT
- `algorithm` TEXT
- `algorithm_version` TEXT
- `commitment_hash` TEXT nullable
- `seed_reveal` TEXT nullable (protect until reveal)
- `result_json` TEXT
- `next_reveal_index` INTEGER
- `created_at`, `completed_at`

### groups
- `id` TEXT PK
- `draw_id` FK
- `group_code` TEXT
- `display_order` INTEGER

### group_members
- `group_id` FK
- `team_id` FK
- `draw_position` INTEGER
- PK `(group_id, team_id)`
- Unique `(group_id, draw_position)`

### fixtures
- `id` TEXT PK
- `tournament_id` FK
- `stage` TEXT: GROUP, KNOCKOUT
- `group_id` FK nullable
- `round_code` TEXT nullable
- `team_a_id`, `team_b_id` FKs
- `left_side_team_id` FK — assigned at fixture-generation time per FR-COMP-013's balancing rule; determines the default host recommendation. Not the same as `host_team_id`.
- `scheduled_at` TEXT nullable
- `timezone` TEXT
- `host_team_id` FK nullable — the team that actually hosts (equals `left_side_team_id` by default, but becomes the opposing team's ID if a FR-FIX-005 substitution occurred; recorded once host is confirmed, not at generation time)
- `host_assignment_reason` TEXT nullable: DEFAULT_LEFT_SIDE, OPPONENT_SUBSTITUTED, ORGANIZER_OVERRIDE
- `status` TEXT: SCHEDULED, READY, IN_PROGRESS, REPORT_PENDING, DISPUTED, COMPLETED, WALKOVER, CANCELLED
- `created_at`, `updated_at`

### series
- `id` TEXT PK
- `fixture_id` FK unique
- `format` TEXT: BO3, BO5
- `target_wins` INTEGER (2 or 3)
- `status` TEXT
- `winner_team_id` FK nullable
- `team_a_game_wins`, `team_b_game_wins` INTEGER default 0

### games
- `id` TEXT PK
- `fixture_id` FK
- `series_id` FK nullable
- `game_number` INTEGER
- `status` TEXT
- `team_a_score`, `team_b_score` INTEGER nullable
- `winner_team_id` FK nullable
- `is_draw` INTEGER
- `is_walkover` INTEGER
- `evidence_status` TEXT
- Unique `(fixture_id, game_number)`

### report_sessions
- `id` TEXT PK
- `fixture_id` FK
- `game_id` FK nullable (series-level intake can bind multiple games)
- `submitting_team_id` FK
- `status` TEXT: COLLECTING, PROCESSING, DRAFT_READY, INCOMPLETE, EXPIRED, FAILED
- `last_message_at` TEXT
- `debounce_due_at` TEXT
- `session_expires_at` TEXT nullable
- `version` INTEGER
- `created_at`, `updated_at`

### inbound_messages
- `id` TEXT PK
- `provider_message_key` TEXT UNIQUE
- `chat_id` TEXT
- `sender_raw_address` TEXT
- `delegate_id` FK nullable
- `message_timestamp` TEXT
- `received_at` TEXT
- `message_type` TEXT
- `text_body` TEXT nullable
- `caption` TEXT nullable
- `reply_to_key` TEXT nullable
- `report_session_id` FK nullable
- `raw_metadata_json` TEXT
- `created_at`

### media_assets
- `id` TEXT PK
- `storage_provider` TEXT (VERAX_VM_MEDIA)
- `storage_key` TEXT
- `media_role` TEXT: MAIN_MATCH, GOALKEEPER_DETAIL, OTHER
- `mime_type` TEXT
- `byte_size` INTEGER
- `sha256` TEXT
- `visibility` TEXT
- `status` TEXT
- `uploaded_by_delegate_id` FK nullable
- `source_message_id` FK
- `created_at`
- Do not store binary image content here.

### report_versions
- `id` TEXT PK
- `report_session_id` FK
- `fixture_id` FK
- `version_number` INTEGER
- `status` TEXT: DRAFT, NEEDS_CORRECTION, PENDING_APPROVAL, APPROVED, LOCKED, REJECTED
- `extraction_json` TEXT
- `validated_data_json` TEXT
- `provenance` TEXT: AI, MANUAL_ENTRY, MIXED
- `created_at`, `created_by`
- Unique `(report_session_id, version_number)`

### report_media
- `report_version_id` FK
- `media_asset_id` FK
- `game_id` FK nullable
- `media_role` TEXT
- PK `(report_version_id, media_asset_id)`

### player_game_stats
- `id` TEXT PK
- `game_id` FK
- `player_id` FK
- `team_id` FK
- `rating` REAL nullable
- `goals` INTEGER nullable
- `assists` INTEGER nullable
- `passes` INTEGER nullable
- `defense_raw` INTEGER nullable
- `goalkeeper_saves` INTEGER nullable
- `stats_json` TEXT
- `source_report_version_id` FK
- `is_award_eligible` INTEGER
- Unique `(game_id, player_id)`

### goalkeeper_reports
- `id` TEXT PK
- `game_id` FK
- `player_id` FK
- `team_id` FK
- `detail_media_asset_id` FK
- `score_left`, `score_right` INTEGER
- `screen_result_text` TEXT
- `summary_rating` REAL nullable
- `summary_goals`, `summary_assists`, `summary_passes` INTEGER nullable
- `raw_defense_value` INTEGER nullable
- `goalkeeper_saves` INTEGER nullable
- `visual_goalkeeper_cue` TEXT
- `cross_screen_match_status` TEXT: UNIQUE, AMBIGUOUS, UNMATCHED, MANUAL_CONFIRMED
- `award_eligible` INTEGER
- `created_at`

### corrections
- `id` TEXT PK
- `report_version_id` FK
- `inbound_message_id` FK
- `submitted_by_delegate_id` FK nullable
- `parsed_patch_json` TEXT
- `status` TEXT: PROPOSED, NEEDS_CLARIFICATION, ACCEPTED, REJECTED
- `organizer_reason` TEXT nullable
- `created_at`, `resolved_at`

### approvals
- `id` TEXT PK
- `report_version_id` FK
- `approver_type` TEXT: TEAM_A, TEAM_B, ORGANIZER
- `approver_id` TEXT
- `decision` TEXT: APPROVE, REJECT
- `created_at`
- Unique `(report_version_id, approver_type, approver_id)`

### standings
Prefer a deterministic query/materialized projection rebuildable from locked game records. If persisted:
- `tournament_id`, `group_id`, `team_id`
- played, wins, draws, losses, goals_for, goals_against, goal_difference, points
- `computed_at`, `source_revision`

### audit_events
- `id` TEXT PK
- `actor_type`, `actor_id`
- `event_type`
- `entity_type`, `entity_id`
- `before_json`, `after_json`
- `reason` TEXT nullable
- `correlation_id`
- `created_at`

### provider_usage
- `id` TEXT PK
- `provider`, `model`
- `task_type`
- `request_status`
- `input_units`, `output_units` nullable
- `latency_ms`
- `error_code` nullable
- `created_at`

### provider_usage
- `id` TEXT PK
- `provider`, `model`
- `task_type`
- `request_status`
- `input_units`, `output_units` nullable
- `latency_ms`
- `error_code` nullable
- `created_at`
- `task_type` CHECK expanded in migration 004 to include: `CHAT_OMAK_PEAK`, `PLAN_AGENT`, `EXTRACT_QNA`, `FORMAT_HYPE`, `GENERATE_PANTUN`, `REPHRASE_TRIVIA` (in addition to the original `CLASSIFY`, `EXTRACT_MATCH`, `EXTRACT_GOALKEEPER`, `PARSE_CORRECTION`, `PARSE_ROSTER`). The expansion was done via a table rebuild (rename-copy-drop) inside migration 004.

### ai_action_plans (migration 004, D-038)
- `id` TEXT PK
- `plan_code` TEXT UNIQUE NOT NULL — short human-readable code (e.g. `AGENT-7F3K`) used in `!agentconfirm <code>`
- `tournament_id` FK nullable
- `organizer_address` TEXT NOT NULL — sender_raw_address of the stager
- `organizer_delegate_id` FK nullable
- `instruction_text` TEXT NOT NULL — original NL instruction
- `plan_json` TEXT NOT NULL — `{ actions: [{ action_id, params, rationale, preview_summary }] }`
- `status` TEXT NOT NULL CHECK IN (`PENDING`, `EXECUTING`, `EXECUTED`, `EXPIRED`, `CANCELLED`, `FAILED`)
- `expires_at` TEXT NOT NULL — ~10 min after created_at
- `executed_at` TEXT nullable
- `execution_result_json` TEXT nullable — `{ actions: [{ action_id, ok, before, after, error? }] }`
- `failure_reason` TEXT nullable
- `created_at`, `updated_at`
- Idempotency invariant: the atomic claim `UPDATE status='EXECUTING' WHERE plan_code=? AND status='PENDING'` guarantees a double-confirm can never execute twice; the second confirm is explicitly rejected with the prior outcome + timestamp.

### qna_entries (migration 004, D-039)
- `id` TEXT PK
- `question` TEXT NOT NULL
- `answer` TEXT NOT NULL
- `category` TEXT nullable — free-form enum: `jadwal`, `aturan`, `teknis`, `wo`, `roster`, `hasil`, `umum`
- `source_message_ids_json` TEXT — JSON array of `inbound_messages.id` for traceability
- `created_by_delegate_id` FK nullable
- `created_by_organizer` INTEGER NOT NULL DEFAULT 0
- `is_active` INTEGER NOT NULL DEFAULT 1
- `created_at`, `updated_at`
- `UNIQUE(question, answer)` — final dedup guard alongside AI-side duplicate marking

## 3. Constraints and invariants

- Five starters exactly, including one goalkeeper and four outfield players.
- Maximum five substitutes.
- A player has one team per tournament.
- A delegate has one active team assignment per tournament unless explicitly represented as a separate delegate per division.
- A message key is ingested once.
- One game has one official locked result.
- One report version has at most one approval per required party.
- A locked report is immutable; corrections create a new version.
- Game score and series score are different data.
- A draw is a valid Group Stage result but not a completed KO game unless a tie-break process resolves it.
- Goalkeeper `DEFENSE` raw value and semantic saves are stored separately.
- Image file path supplied by a model is never trusted; storage key is generated by media service.

## 4. Unicode and nickname handling

- Database TEXT supports Unicode; use UTF-8 end-to-end.
- Preserve exact `nickname_raw`.
- Optionally derive NFC-normalized and case-folded search keys.
- Never overwrite raw text with normalized text.
- Do not strip symbols, combining marks, or clan tags from the canonical nickname.
- Fuzzy similarity is a candidate signal, not identity proof.
- Confusable-character detection may flag suspicious cases for review.

## 5. Migrations

- Use versioned migrations.
- Never modify production schema manually without recording migration.
- Backup before destructive migrations.
- Migration must be idempotent or safely detectable.
- Keep a documented restore and rebuild process.
