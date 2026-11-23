/**
 * Flash Peak TMS - Admin Manual Report Engine (Task 5.5)
 * 
 * Implements the admin-only `!manualreport` command handler and AI recovery protection
 * (FR-FAIL-003, FR-FAIL-004, FR-FAIL-005, WORKFLOWS.md §11).
 * 
 * Rules:
 * 1. Admin-Only Gate: Strictly restricted to verified tournament organizers/administrators (FR-FAIL-003).
 * 2. Identical Validation: Manual data undergoes the exact same deterministic backend business
 *    validation as AI extraction (FR-FAIL-004).
 * 3. Provenance: Stored with provenance = `MANUAL_ENTRY` (FR-FAIL-005).
 * 4. Approval Lifecycle: Follows the same 3-party approval lifecycle (Team A, Team B, Organizer) (FR-FAIL-004).
 * 5. AI Protection: AI recovery workflows do NOT overwrite or discard manual data (WORKFLOWS.md §11).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  ReportVersion,
  ValidatedMatchData,
  UUID,
  ISODateString,
} from '../shared/types/index.js';
import {
  validateMatchReport,
  type RawPlayerMatchStat,
} from './validation.js';
import {
  createReportDraft,
} from './versioning.js';

export interface ManualReportInput {
  organizer_id: string;
  fixture_id: UUID;
  game_id?: UUID;
  team_a_score: number;
  team_b_score: number;
  team_a_players: RawPlayerMatchStat[];
  team_b_players: RawPlayerMatchStat[];
  evidence_media_ids?: UUID[];
  notes?: string;
  is_organizer?: boolean;
  correlation_id?: string;
  allow_unassigned_goals?: boolean;
}

export interface ManualReportResult {
  success: boolean;
  version?: ReportVersion;
  validatedData?: ValidatedMatchData;
  errors?: string[];
  warnings?: string[];
}

/**
 * Verifies that the actor is an authorized tournament organizer.
 * AUDIT-VERIFY-T12 (21 Nov 2026): the loose string patterns
 * (startsWith('org_') / includes('organizer')) are removed — they were the
 * exact pattern FIX2-APR-003 eliminated from approval.ts, and let arbitrary
 * ids like 'org_legit' or 'i-am-the-organizer-trust-me' pass the admin gate.
 * Authority is now: the explicit is_organizer flag (set only by the
 * ORGANIZER-role-gated command route / confirmPending), or the internal
 * system constant 'ORGANIZER' used by admin tooling.
 */
function isOrganizerAuthorized(organizerId: string, explicitFlag?: boolean): boolean {
  if (explicitFlag === true) return true;
  if (organizerId === 'ORGANIZER') return true;
  return false;
}

/**
 * Handles the admin `!manualreport` command.
 */
export async function handleManualReport(
  db: Client,
  input: ManualReportInput
): Promise<ManualReportResult> {
  const correlationId = input.correlation_id || randomUUID();
  const now: ISODateString = new Date().toISOString();

  // 1. Admin Authorization Gate (FR-FAIL-003)
  if (!isOrganizerAuthorized(input.organizer_id, input.is_organizer)) {
    throw new Error(
      'Unauthorized: !manualreport is restricted to tournament organizers/administrators.'
    );
  }

  // 2. Resolve Fixture and Game
  const fixtureRes = await db.execute({
    sql: 'SELECT id, tournament_id, stage, team_a_id, team_b_id, status FROM fixtures WHERE id = ?',
    args: [input.fixture_id],
  });

  if (fixtureRes.rows.length === 0) {
    return {
      success: false,
      errors: [`Fixture not found: ${input.fixture_id}`],
    };
  }

  const fixture = fixtureRes.rows[0];
  const fixtureStage = String(fixture[2] ?? (fixture as Record<string, unknown>).stage);
  const teamAId = String(fixture[3]);
  const teamBId = String(fixture[4]);

  // AUDIT-VERIFY-T16 (21 Nov 2026): !manualreport creates a BO1 group-style
  // report draft; a KNOCKOUT fixture belongs to a BO3/BO5 series managed by
  // !kogame / !kores. A manual BO1 draft on a knockout series created a
  // parallel, conflicting report path (dry-run reproduced: success=true on a
  // SEMI_FINAL fixture).
  if (fixtureStage === 'KNOCKOUT') {
    return {
      success: false,
      errors: [
        'Fixture ini pertandingan KNOCKOUT (BO3/BO5 series). Gunakan !kores <fixture_id> <game_no> <skor_a>-<skor_b> untuk mencatat/mengoreksi hasil game knockout.',
      ],
    };
  }

  let gameId = input.game_id;
  if (!gameId) {
    const gameRes = await db.execute({
      sql: 'SELECT id FROM games WHERE fixture_id = ? ORDER BY game_number ASC LIMIT 1',
      args: [input.fixture_id],
    });
    if (gameRes.rows.length === 0) {
      return {
        success: false,
        errors: [`No games found for fixture: ${input.fixture_id}`],
      };
    }
    gameId = String(gameRes.rows[0][0]);
  }

  // 3. Deterministic Validation (FR-FAIL-004)
  const validation = await validateMatchReport(db, {
    fixture_id: input.fixture_id,
    game_id: gameId,
    team_a_id: teamAId,
    team_b_id: teamBId,
    team_a_score: input.team_a_score,
    team_b_score: input.team_b_score,
    team_a_players: input.team_a_players,
    team_b_players: input.team_b_players,
    allow_unassigned_goals: input.allow_unassigned_goals,
  });

  if (!validation.isValid || !validation.validatedData) {
    return {
      success: false,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }

  // 4. Resolve or create Report Session
  const sessionRes = await db.execute({
    sql: 'SELECT id, status FROM report_sessions WHERE fixture_id = ? AND (game_id = ? OR game_id IS NULL) LIMIT 1',
    args: [input.fixture_id, gameId],
  });

  let sessionId: UUID;
  if (sessionRes.rows.length > 0) {
    sessionId = String(sessionRes.rows[0][0]);
  } else {
    sessionId = randomUUID();
    await db.execute({
      sql: `
        INSERT INTO report_sessions (
          id, fixture_id, game_id, submitting_team_id, status,
          last_message_at, debounce_due_at, session_expires_at,
          extension_count, version, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'DRAFT_READY', ?, ?, NULL, 0, 1, ?, ?)
      `,
      args: [
        sessionId,
        input.fixture_id,
        gameId,
        teamAId,
        now,
        now,
        now,
        now,
      ],
    });
  }

  // 5. Create Report Version with provenance = MANUAL_ENTRY (FR-FAIL-005)
  const mediaList = (input.evidence_media_ids || []).map((mId) => ({
    media_asset_id: mId,
    media_role: 'MANUAL_REVIEW' as const,
    game_id: gameId,
  }));

  const extractionPayload = JSON.stringify({
    notes: input.notes || 'Admin manual report submission via !manualreport',
    admin_id: input.organizer_id,
    submitted_at: now,
  });

  const version = await createReportDraft(db, {
    report_session_id: sessionId,
    fixture_id: input.fixture_id,
    extraction_json: extractionPayload,
    validated_data_json: JSON.stringify(validation.validatedData),
    provenance: 'MANUAL_ENTRY',
    created_by: input.organizer_id,
    status: 'PENDING_APPROVAL',
    media_assets: mediaList,
  });

  // 6. Record Audit Event
  await db.execute({
    sql: `
      INSERT INTO audit_events (
        id, actor_type, actor_id, event_type, entity_type, entity_id,
        before_json, after_json, reason, correlation_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      'ORGANIZER',
      input.organizer_id,
      'MANUAL_REPORT_CREATED',
      'report_versions',
      version.id,
      null,
      version.validated_data_json,
      input.notes || 'Created via !manualreport',
      correlationId,
      now,
    ],
  });

  return {
    success: true,
    version,
    validatedData: validation.validatedData,
    warnings: validation.warnings,
  };
}

/**
 * Checks whether a report session is protected by existing manual entry data.
 * WORKFLOWS.md §11: AI recovery does not automatically overwrite manual data.
 */
export async function isSessionManualProtected(
  db: Client,
  sessionId: UUID
): Promise<boolean> {
  const res = await db.execute({
    sql: `
      SELECT COUNT(*) as manual_count
      FROM report_versions
      WHERE report_session_id = ? AND provenance = 'MANUAL_ENTRY'
    `,
    args: [sessionId],
  });

  const count = Number(res.rows[0]?.[0] ?? (res.rows[0] as { manual_count?: unknown })?.manual_count ?? 0);
  return count > 0;
}
