-- 004_ai_native_features.sql
-- AI-native feature expansion (task: flash-peak-tms-ai-native-expansion-v1):
--   1. ai_action_plans  — persistent plan/confirm/execute state for the organizer AI agent
--   2. qna_entries      — living FAQ list surfaced via !qna, populated by !saveqna (AI-extracted)
--
-- Design notes:
--   * Plans are PERSISTED (not in-memory like WoClaim) because the organizer AI agent
--     must survive restarts without losing a pending confirmation, and idempotency
--     requires durable state transitions (PENDING -> EXECUTED must be atomic and
--     observable across restarts). See DECISIONS D-038 (per task brief 2026-11-22).
--   * Each plan has a short human-readable plan_code (e.g. AGENT-7F3K) used in the
--     confirmation command (!agentconfirm AGENT-7F3K) so the organizer can
--     unambiguously identify WHICH plan they are confirming.
--   * Expiry is enforced both at confirm-time (status check) and lazily by a
--     background sweep (so abandoned plans do not accumulate as PENDING).
--   * qna_entries.source_message_ids_json records which inbound_messages the AI
--     extracted the Q&A from, for traceability/curation.

CREATE TABLE IF NOT EXISTS ai_action_plans (
    id TEXT PRIMARY KEY,
    plan_code TEXT NOT NULL UNIQUE,                       -- short human-readable code, e.g. 'AGENT-7F3K'
    tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE,
    organizer_address TEXT NOT NULL,                      -- sender_raw_address of the organizer who requested
    organizer_delegate_id TEXT REFERENCES delegates(id) ON DELETE SET NULL,
    instruction_text TEXT NOT NULL,                       -- original natural-language instruction
    plan_json TEXT NOT NULL,                              -- structured plan: { actions: [{action_id, params, summary}] }
    status TEXT NOT NULL CHECK (status IN ('PENDING','EXECUTING','EXECUTED','EXPIRED','CANCELLED','FAILED')) DEFAULT 'PENDING',
    expires_at TEXT NOT NULL,                             -- ISO-8601; ~10 min after created_at
    executed_at TEXT,
    execution_result_json TEXT,                           -- { actions: [{action_id, ok, before, after, error?}] }
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_action_plans_status ON ai_action_plans(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_action_plans_organizer ON ai_action_plans(organizer_address, status);

CREATE TABLE IF NOT EXISTS qna_entries (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT,                                        -- free-form: 'jadwal', 'aturan', 'teknis', 'umum', ...
    source_message_ids_json TEXT,                         -- JSON array of inbound_messages.id (traceability)
    created_by_delegate_id TEXT REFERENCES delegates(id) ON DELETE SET NULL,
    created_by_organizer INTEGER NOT NULL DEFAULT 0,      -- 1 if created by organizer (manual or !saveqna)
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(question, answer)                              -- prevent exact-duplicate Q&A pairs
);

CREATE INDEX IF NOT EXISTS idx_qna_entries_active ON qna_entries(is_active, created_at DESC);

-- Extend provider_usage task_type CHECK to cover the new AI-native task types so
-- telemetry is consistent. SQLite cannot ALTER a CHECK constraint in-place, so we
-- rebuild the table via the standard rename-copy-drop pattern. Safe inside a
-- migration transaction; preserves all existing rows and indexes.
CREATE TABLE IF NOT EXISTS provider_usage_new (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('GROQ', 'GEMINI', 'OLLAMA_CLOUD', 'NVIDIA_NIM', 'DEEPSEEK', 'COHERE', 'MISTRAL')),
    model TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK (task_type IN (
        'CLASSIFY', 'EXTRACT_MATCH', 'EXTRACT_GOALKEEPER', 'PARSE_CORRECTION', 'PARSE_ROSTER',
        'CHAT_OMAK_PEAK', 'PLAN_AGENT', 'EXTRACT_QNA', 'FORMAT_HYPE', 'GENERATE_PANTUN', 'REPHRASE_TRIVIA'
    )),
    request_status TEXT NOT NULL CHECK (request_status IN ('SUCCESS', 'ERROR', 'RATE_LIMITED', 'TIMEOUT')),
    input_units INTEGER,
    output_units INTEGER,
    latency_ms INTEGER NOT NULL,
    error_code TEXT,
    created_at TEXT NOT NULL
);

INSERT INTO provider_usage_new
    (id, provider, model, task_type, request_status, input_units, output_units, latency_ms, error_code, created_at)
SELECT id, provider, model, task_type, request_status, input_units, output_units, latency_ms, error_code, created_at
FROM provider_usage;

DROP TABLE provider_usage;
ALTER TABLE provider_usage_new RENAME TO provider_usage;

CREATE INDEX IF NOT EXISTS idx_provider_usage_provider ON provider_usage(provider, created_at);
