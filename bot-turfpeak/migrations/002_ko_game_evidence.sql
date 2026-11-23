-- 002_ko_game_evidence.sql
-- FIX2-KO-002 (knockout pipeline v2): per-game evidence journal for the
-- interactive knockout evidence pipeline. Every screenshot submitted for a
-- knockout series game is journaled here so that out-of-order, duplicate and
-- revised submissions can be reconciled deterministically, and ambiguous
-- conflicts can be flagged for organizer review.
CREATE TABLE IF NOT EXISTS ko_game_evidence (
    id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
    series_id TEXT REFERENCES series(id) ON DELETE SET NULL,
    game_number INTEGER NOT NULL,
    media_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
    source_message_id TEXT REFERENCES inbound_messages(id) ON DELETE SET NULL,
    submitted_by_delegate_id TEXT REFERENCES delegates(id) ON DELETE SET NULL,
    extracted_team_a_score INTEGER,
    extracted_team_b_score INTEGER,
    extracted_winner_team_id TEXT,
    extraction_json TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'APPLIED',        -- extraction was recorded into games/series as the game result
        'SUPERSEDED',     -- replaced by a newer photo for the same game (kept for audit)
        'IGNORED',        -- not applied: series already complete when this photo arrived
        'NEEDS_REVIEW'    -- conflicts with the already-recorded result of the same game
    )),
    resolution_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ko_game_evidence_fixture
    ON ko_game_evidence(fixture_id, game_number);
CREATE INDEX IF NOT EXISTS idx_ko_game_evidence_status
    ON ko_game_evidence(status);
