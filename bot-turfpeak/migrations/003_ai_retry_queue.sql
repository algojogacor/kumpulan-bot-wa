-- 003_ai_retry_queue.sql
-- AI resilience (v3): automatic retry queue for evidence batches that failed with
-- AllProvidersFailedError. Reuses the existing debounce/lease machinery instead of
-- a parallel queue system: a failed batch is rescheduled back to COLLECTING with
-- debounce_due_at pushed 60s into the future, and this column tracks how many AI
-- retries have already been attempted for the session (0 = never retried).
--
-- Invariants preserved:
-- - Normal (non-retry) FIFO ordering is untouched: claimDebounceBatch still picks
--   sessions ORDER BY debounce_due_at ASC, so a retried session simply re-enters
--   the same queue at the back (due later than sessions already waiting).
-- - The retry counter only ever increments for AllProvidersFailedError outcomes;
--   validation/NEEDS_CORRECTION failures never enter the retry loop.
ALTER TABLE report_sessions ADD COLUMN ai_retry_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_report_sessions_retry
    ON report_sessions(status, ai_retry_count, debounce_due_at);
