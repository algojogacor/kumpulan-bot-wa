import type { Client } from '@libsql/client';
import type {
  ReportSession,
  ReportSessionStatus,
  InboundMessage,
  MediaAsset,
} from '../shared/types/index.js';
import { getReportSessionById, mapRowToReportSession } from './session.js';
import { mapRowToInboundMessage } from './capture.js';

export interface ClaimedBatch {
  session: ReportSession;
  messages: InboundMessage[];
  mediaAssets: MediaAsset[];
}

function mapRowToMediaAsset(row: Record<string, unknown>): MediaAsset {
  return {
    id: String(row.id),
    storage_provider: row.storage_provider as MediaAsset['storage_provider'],
    storage_key: String(row.storage_key),
    media_role: row.media_role as MediaAsset['media_role'],
    mime_type: String(row.mime_type),
    byte_size: Number(row.byte_size),
    sha256: String(row.sha256),
    visibility: row.visibility as MediaAsset['visibility'],
    status: row.status as MediaAsset['status'],
    uploaded_by_delegate_id: row.uploaded_by_delegate_id
      ? String(row.uploaded_by_delegate_id)
      : null,
    source_message_id: String(row.source_message_id),
    created_at: String(row.created_at),
  };
}

/**
 * Resets the 5-second sliding quiet window for a specific report session (FR-ING-002/003).
 * Session isolation guaranteed: resetting Session A leaves Session B completely unaffected.
 */
export async function resetSessionDebounce(
  db: Client,
  sessionId: string,
  quietWindowMs = 5000,
  now = new Date()
): Promise<ReportSession> {
  const session = await getReportSessionById(db, sessionId);
  if (!session) {
    throw new Error(`Report session '${sessionId}' not found`);
  }

  const nowIso = now.toISOString();
  const newDebounceDueAt = new Date(now.getTime() + quietWindowMs).toISOString();
  const nextVersion = session.version + 1;

  await db.execute({
    sql: `UPDATE report_sessions
          SET status = 'COLLECTING', last_message_at = ?, debounce_due_at = ?, version = ?, updated_at = ?
          WHERE id = ?`,
    args: [nowIso, newDebounceDueAt, nextVersion, nowIso, sessionId],
  });

  const updated = await getReportSessionById(db, sessionId);
  if (!updated) {
    throw new Error(`Failed to retrieve updated report session '${sessionId}'`);
  }
  return updated;
}

/**
 * Checks whether a session's quiet window has elapsed and it is ready to be claimed.
 */
export function isDebounceReady(session: ReportSession, now = new Date()): boolean {
  if (session.status !== 'COLLECTING') return false;
  return new Date(session.debounce_due_at).getTime() <= now.getTime();
}

/**
 * Atomically claims an expired debounce batch using optimistic locking on session.version (FR-ING-005).
 * Prevents dual-processing across multiple workers or concurrent invocations.
 */
export async function claimDebounceBatch(
  db: Client,
  leaseOwner: string,
  leaseDurationMs = 30000,
  now = new Date()
): Promise<ClaimedBatch | null> {
  const nowIso = now.toISOString();

  // 1. Find candidate session ready for batching (status = 'COLLECTING' and quiet window has passed)
  const candidateResult = await db.execute({
    sql: `SELECT * FROM report_sessions
          WHERE status = 'COLLECTING'
            AND debounce_due_at <= ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          ORDER BY debounce_due_at ASC
          LIMIT 1`,
    args: [nowIso, nowIso],
  });

  if (candidateResult.rows.length === 0) {
    return null;
  }

  const candidate = mapRowToReportSession(
    candidateResult.rows[0] as unknown as Record<string, unknown>
  );

  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

  // 2. Atomic optimistic claim: update status and lease if and only if version has not changed
  const claimUpdate = await db.execute({
    sql: `UPDATE report_sessions
          SET lease_owner = ?, lease_expires_at = ?, status = 'PROCESSING', updated_at = ?
          WHERE id = ? AND version = ?`,
    args: [leaseOwner, leaseExpiresAt, nowIso, candidate.id, candidate.version],
  });

  if (claimUpdate.rowsAffected === 0) {
    // Another worker or late incoming message modified the version between query and claim
    return null;
  }

  // 3. Fetch linked inbound messages
  const messagesResult = await db.execute({
    sql: `SELECT * FROM inbound_messages WHERE report_session_id = ? ORDER BY message_timestamp ASC`,
    args: [candidate.id],
  });

  const messages = messagesResult.rows.map((r) =>
    mapRowToInboundMessage(r as unknown as Record<string, unknown>)
  );

  // 4. Fetch linked media assets (parameterized IN (...) — FIX2-SQL-001)
  const mediaAssets: MediaAsset[] = [];
  if (messages.length > 0) {
    const placeholders = messages.map(() => '?').join(',');
    const mediaResult = await db.execute({
      sql: `SELECT * FROM media_assets WHERE source_message_id IN (${placeholders}) ORDER BY created_at ASC`,
      args: messages.map((m) => m.id),
    });

    for (const r of mediaResult.rows) {
      mediaAssets.push(mapRowToMediaAsset(r as unknown as Record<string, unknown>));
    }
  }

  const updatedSession: ReportSession = {
    ...candidate,
    status: 'PROCESSING',
    lease_owner: leaseOwner,
    lease_expires_at: leaseExpiresAt,
    updated_at: nowIso,
  };

  return {
    session: updatedSession,
    messages,
    mediaAssets,
  };
}

/**
 * Releases a lease back to COLLECTING (e.g. if extraction fails or batch needs more time).
 */
export async function releaseDebounceLease(
  db: Client,
  sessionId: string,
  newStatus: ReportSessionStatus = 'COLLECTING'
): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.execute({
    sql: `UPDATE report_sessions
          SET lease_owner = NULL, lease_expires_at = NULL, status = ?, updated_at = ?
          WHERE id = ?`,
    args: [newStatus, nowIso, sessionId],
  });
}

/**
 * Reschedules a claimed batch for an automatic AI retry after a provider outage
 * (AllProvidersFailedError). Reuses the existing debounce machinery instead of a
 * parallel queue: the session goes back to COLLECTING with its quiet window pushed
 * `retryDelayMs` into the future, so it re-enters the same FIFO claim order
 * (ORDER BY debounce_due_at ASC) behind sessions that are already waiting — normal
 * batches are never starved or reordered by retries.
 *
 * The version counter is incremented so any optimistic-lock races (a late inbound
 * message resetting the same session) are detected by claimDebounceBatch as usual.
 * Retry attempt number is tracked in ai_retry_count (migration 003).
 */
export async function rescheduleDebounceRetry(
  db: Client,
  sessionId: string,
  retryDelayMs = 60_000,
  now = new Date()
): Promise<ReportSession> {
  const session = await getReportSessionById(db, sessionId);
  if (!session) {
    throw new Error(`Report session '${sessionId}' not found`);
  }

  const nowIso = now.toISOString();
  const retryDueAt = new Date(now.getTime() + retryDelayMs).toISOString();
  const nextRetryCount = session.ai_retry_count + 1;
  const nextVersion = session.version + 1;

  await db.execute({
    sql: `UPDATE report_sessions
          SET status = 'COLLECTING',
              lease_owner = NULL,
              lease_expires_at = NULL,
              debounce_due_at = ?,
              ai_retry_count = ?,
              version = ?,
              updated_at = ?
          WHERE id = ?`,
    args: [retryDueAt, nextRetryCount, nextVersion, nowIso, sessionId],
  });

  const updated = await getReportSessionById(db, sessionId);
  if (!updated) {
    throw new Error(`Failed to retrieve rescheduled report session '${sessionId}'`);
  }
  return updated;
}

/**
 * Marks a batch processing complete and clears the worker lease.
 */
export async function completeDebounceBatch(
  db: Client,
  sessionId: string,
  targetStatus: ReportSessionStatus = 'DRAFT_READY'
): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.execute({
    sql: `UPDATE report_sessions
          SET lease_owner = NULL, lease_expires_at = NULL, status = ?, updated_at = ?
          WHERE id = ?`,
    args: [targetStatus, nowIso, sessionId],
  });
}

/**
 * Recovers orphaned leases on application restart / worker crash.
 * Restart-safe: resumes pending sessions without losing buffered messages.
 *
 * FIX2-LEASE-001: at boot the previous worker is gone by definition, so ALL
 * sessions stuck in PROCESSING are recovered immediately — including those
 * whose lease is nominally still alive (the lease owner no longer exists to
 * finish them). This avoids waiting out the remaining ~30s lease passively;
 * expired-lease reclaim by claimDebounceBatch remains as an extra safety net
 * during runtime.
 */
export async function recoverOrphanedLeases(
  db: Client,
  now = new Date()
): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db.execute({
    sql: `UPDATE report_sessions
          SET status = 'COLLECTING', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE status = 'PROCESSING'`,
    args: [nowIso],
  });

  return Number(result.rowsAffected);
}
