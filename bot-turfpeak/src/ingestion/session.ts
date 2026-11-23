import crypto from 'node:crypto';
import type { Client } from '@libsql/client';
import type { ReportSession, ReportSessionStatus } from '../shared/types/index.js';

export interface FindOrCreateSessionParams {
  fixture_id: string;
  submitting_team_id: string;
  game_id?: string | null;
  baseExpiryWindowMs?: number; // Default: 10 minutes
  now?: Date;
}

export interface SessionResult {
  session: ReportSession;
  isNew: boolean;
}

export interface ExtendSessionResult {
  extended: boolean;
  extensionCount: number;
  newExpiry: string | null;
  reason?: string;
  requiresOrganizerReview: boolean;
}

export function mapRowToReportSession(row: Record<string, unknown>): ReportSession {
  return {
    id: String(row.id),
    fixture_id: String(row.fixture_id),
    game_id: row.game_id ? String(row.game_id) : null,
    submitting_team_id: String(row.submitting_team_id),
    status: row.status as ReportSessionStatus,
    last_message_at: String(row.last_message_at),
    debounce_due_at: String(row.debounce_due_at),
    session_expires_at: row.session_expires_at ? String(row.session_expires_at) : null,
    extension_count: Number(row.extension_count ?? 0),
    version: Number(row.version ?? 1),
    lease_owner: row.lease_owner ? String(row.lease_owner) : null,
    lease_expires_at: row.lease_expires_at ? String(row.lease_expires_at) : null,
    ai_retry_count: Number(row.ai_retry_count ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function getReportSessionById(
  db: Client,
  sessionId: string
): Promise<ReportSession | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM report_sessions WHERE id = ? LIMIT 1',
    args: [sessionId],
  });

  if (result.rows.length === 0) return null;
  return mapRowToReportSession(result.rows[0] as unknown as Record<string, unknown>);
}

/**
 * Finds an active open report session or creates a new one.
 * Late evidence attaches to existing open sessions, preventing duplicate reports (FR-ING-007).
 */
export async function findOrCreateReportSession(
  db: Client,
  params: FindOrCreateSessionParams
): Promise<SessionResult> {
  const currentDate = params.now || new Date();
  const nowIso = currentDate.toISOString();
  const expiryWindowMs = params.baseExpiryWindowMs || 10 * 60 * 1000; // 10 minutes default

  // 1. Look for existing active session for this fixture and submitting team
  const existingResult = await db.execute({
    sql: `SELECT * FROM report_sessions
          WHERE fixture_id = ?
            AND submitting_team_id = ?
            AND status IN ('COLLECTING', 'PROCESSING', 'DRAFT_READY')
          ORDER BY created_at DESC LIMIT 1`,
    args: [params.fixture_id, params.submitting_team_id],
  });

  if (existingResult.rows.length > 0) {
    const existing = mapRowToReportSession(
      existingResult.rows[0] as unknown as Record<string, unknown>
    );

    // Check if session has strictly expired
    if (existing.session_expires_at && new Date(existing.session_expires_at).getTime() < currentDate.getTime()) {
      // Mark expired in DB
      await db.execute({
        sql: `UPDATE report_sessions SET status = 'EXPIRED', updated_at = ? WHERE id = ?`,
        args: [nowIso, existing.id],
      });
      // Fall through to create fresh session below
    } else {
      // Attach to active open session (late evidence handling per FR-ING-007)
      return {
        session: existing,
        isNew: false,
      };
    }
  }

  // 2. Create new session
  const id = crypto.randomUUID();
  const debounceDueAt = new Date(currentDate.getTime() + 5000).toISOString();
  const sessionExpiresAt = new Date(currentDate.getTime() + expiryWindowMs).toISOString();

  const newSession: ReportSession = {
    id,
    fixture_id: params.fixture_id,
    game_id: params.game_id ?? null,
    submitting_team_id: params.submitting_team_id,
    status: 'COLLECTING',
    last_message_at: nowIso,
    debounce_due_at: debounceDueAt,
    session_expires_at: sessionExpiresAt,
    extension_count: 0,
    version: 1,
    lease_owner: null,
    lease_expires_at: null,
    ai_retry_count: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };

  await db.execute({
    sql: `INSERT INTO report_sessions (
      id, fixture_id, game_id, submitting_team_id,
      status, last_message_at, debounce_due_at, session_expires_at,
      extension_count, version, lease_owner, lease_expires_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newSession.id,
      newSession.fixture_id,
      newSession.game_id,
      newSession.submitting_team_id,
      newSession.status,
      newSession.last_message_at,
      newSession.debounce_due_at,
      newSession.session_expires_at,
      newSession.extension_count,
      newSession.version,
      newSession.lease_owner,
      newSession.lease_expires_at,
      newSession.created_at,
      newSession.updated_at,
    ],
  });

  return {
    session: newSession,
    isNew: true,
  };
}

/**
 * Links an inbound message to a report session.
 */
export async function attachMessageToSession(
  db: Client,
  messageId: string,
  sessionId: string
): Promise<void> {
  await db.execute({
    sql: 'UPDATE inbound_messages SET report_session_id = ? WHERE id = ?',
    args: [sessionId, messageId],
  });
}

/**
 * Extends session expiry upon new evidence / dispute with a strict cap of 3 extensions (FR-ING-008, D-033).
 * After the 3rd extension, route to organizer review.
 */
export async function extendSession(
  db: Client,
  sessionId: string,
  extensionDurationMs = 10 * 60 * 1000,
  now = new Date()
): Promise<ExtendSessionResult> {
  const session = await getReportSessionById(db, sessionId);
  if (!session) {
    throw new Error(`Report session '${sessionId}' not found`);
  }

  // Strict cap: maximum 3 extensions allowed
  if (session.extension_count >= 3) {
    return {
      extended: false,
      extensionCount: session.extension_count,
      newExpiry: session.session_expires_at,
      reason: 'MAX_EXTENSIONS_EXCEEDED',
      requiresOrganizerReview: true,
    };
  }

  const currentBase = session.session_expires_at
    ? Math.max(now.getTime(), new Date(session.session_expires_at).getTime())
    : now.getTime();

  const newExpiryIso = new Date(currentBase + extensionDurationMs).toISOString();
  const newCount = session.extension_count + 1;
  const nowIso = now.toISOString();

  await db.execute({
    sql: `UPDATE report_sessions
          SET extension_count = ?, session_expires_at = ?, updated_at = ?
          WHERE id = ?`,
    args: [newCount, newExpiryIso, nowIso, sessionId],
  });

  return {
    extended: true,
    extensionCount: newCount,
    newExpiry: newExpiryIso,
    requiresOrganizerReview: false,
  };
}

/**
 * Sweeps and marks expired sessions as 'EXPIRED'.
 */
export async function expireStaleSessions(
  db: Client,
  now = new Date()
): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db.execute({
    sql: `UPDATE report_sessions
          SET status = 'EXPIRED', updated_at = ?
          WHERE status IN ('COLLECTING', 'PROCESSING', 'DRAFT_READY')
            AND session_expires_at IS NOT NULL
            AND session_expires_at <= ?`,
    args: [nowIso, nowIso],
  });

  return Number(result.rowsAffected);
}
