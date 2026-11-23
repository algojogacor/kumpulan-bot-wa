-- 005_quiz_leaderboard.sql
-- Community trivia quiz scores & leaderboard (pure fun, separate from tournament standings)

CREATE TABLE IF NOT EXISTS quiz_scores (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_raw_address TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(chat_id, sender_raw_address)
);

CREATE INDEX IF NOT EXISTS idx_quiz_scores_chat_score ON quiz_scores(chat_id, score DESC, updated_at ASC);
