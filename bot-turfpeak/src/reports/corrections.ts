/**
 * Flash Peak TMS - Correction Orchestration Engine (Task 5.3)
 * 
 * Implements authoritative correction handling (FR-COR-001 through FR-COR-007, FR-APR-003).
 * 
 * Rules:
 * 1. Authority check: Only Team A delegate, Team B delegate, or Organizer may submit corrections (FR-COR-006).
 * 2. Immutability: Rejects corrections on LOCKED reports unless explicitly reopened by organizer.
 * 3. Disambiguation: Verifies target report version, team, player (ordinal / nickname), and metric.
 * 4. Staging & Validation: Stages proposed patch and re-evaluates deterministic validation.
 * 5. Versioning & Approval Reset: Creates a NEW report version (v+1) and RESETS all approvals (FR-APR-003).
 * 6. Audit Trail: Persists record in `corrections` and `audit_events`.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  StructuredCorrectionPatch,
  ReportVersion,
  Correction,
  CorrectionStatus,
  ValidatedMatchData,
  UUID,
  ISODateString,
} from '../shared/types/index.js';
import {
  getReportVersion,
  createNextReportVersion,
} from './versioning.js';
import {
  validateMatchReport,
} from './validation.js';

export interface ApplyCorrectionInput {
  target_report_version_id: UUID;
  sender_id: UUID; // delegate_id or organizer identifier
  inbound_message_id: UUID;
  patch: StructuredCorrectionPatch;
  is_organizer?: boolean;
  correlation_id?: string;
}

export interface CorrectionResult {
  success: boolean;
  status: CorrectionStatus;
  newVersion?: ReportVersion;
  correction?: Correction;
  error?: string;
  clarification_reason?: string;
}

/**
 * Validates sender authority: must be Team A delegate, Team B delegate, or Organizer.
 */
async function verifyCorrectionAuthority(
  db: Client,
  fixtureId: UUID,
  senderId: UUID,
  isOrganizerExplicit?: boolean
): Promise<{ authorized: boolean; role: 'TEAM_A' | 'TEAM_B' | 'ORGANIZER' | 'UNAUTHORIZED' }> {
  if (isOrganizerExplicit || senderId === 'ORGANIZER') {
    return { authorized: true, role: 'ORGANIZER' };
  }

  // Look up fixture and registered delegates for Team A and Team B
  const fixtureRes = await db.execute({
    sql: `
      SELECT f.id, f.team_a_id, f.team_b_id,
             ta.delegate_id AS delegate_a,
             tb.delegate_id AS delegate_b
      FROM fixtures f
      LEFT JOIN teams ta ON f.team_a_id = ta.id
      LEFT JOIN teams tb ON f.team_b_id = tb.id
      WHERE f.id = ?
    `,
    args: [fixtureId],
  });

  if (fixtureRes.rows.length === 0) {
    return { authorized: false, role: 'UNAUTHORIZED' };
  }

  const row = fixtureRes.rows[0];
  const delegateA = row[3] ? String(row[3]) : null;
  const delegateB = row[4] ? String(row[4]) : null;

  if (delegateA && senderId === delegateA) {
    return { authorized: true, role: 'TEAM_A' };
  }

  if (delegateB && senderId === delegateB) {
    return { authorized: true, role: 'TEAM_B' };
  }

  return { authorized: false, role: 'UNAUTHORIZED' };
}

/**
 * Orchestrates a correction submission against an existing report version.
 */
export async function applyReportCorrection(
  db: Client,
  input: ApplyCorrectionInput
): Promise<CorrectionResult> {
  const correlationId = input.correlation_id || randomUUID();
  const correctionId: UUID = randomUUID();
  const now: ISODateString = new Date().toISOString();

  // 1. Fetch target report version
  const targetVersion = await getReportVersion(db, input.target_report_version_id);
  if (!targetVersion) {
    return {
      success: false,
      status: 'REJECTED',
      error: `Target report version not found: ${input.target_report_version_id}`,
    };
  }

  // 2. Immutability check: Reject corrections on LOCKED report unless reopened
  if (targetVersion.status === 'LOCKED') {
    const errorMsg =
      'Cannot apply correction to a LOCKED report. The report must be reopened by an organizer first.';
    
    await recordCorrection(db, {
      id: correctionId,
      report_version_id: targetVersion.id,
      inbound_message_id: input.inbound_message_id,
      submitted_by_delegate_id: input.sender_id,
      parsed_patch_json: JSON.stringify(input.patch),
      status: 'REJECTED',
      organizer_reason: errorMsg,
      created_at: now,
      resolved_at: now,
    });

    return {
      success: false,
      status: 'REJECTED',
      error: errorMsg,
    };
  }

  // 3. Sender authority check (FR-COR-006)
  const auth = await verifyCorrectionAuthority(
    db,
    targetVersion.fixture_id,
    input.sender_id,
    input.is_organizer
  );

  if (!auth.authorized) {
    const errorMsg =
      'Unauthorized sender: only Team A delegate, Team B delegate, or Organizer can submit corrections.';

    await recordCorrection(db, {
      id: correctionId,
      report_version_id: targetVersion.id,
      inbound_message_id: input.inbound_message_id,
      submitted_by_delegate_id: input.sender_id,
      parsed_patch_json: JSON.stringify(input.patch),
      status: 'REJECTED',
      organizer_reason: errorMsg,
      created_at: now,
      resolved_at: now,
    });

    return {
      success: false,
      status: 'REJECTED',
      error: errorMsg,
    };
  }

  // 4. Parse current validated data
  let currentData: ValidatedMatchData;
  try {
    currentData = JSON.parse(targetVersion.validated_data_json) as ValidatedMatchData;
  } catch (err) {
    return {
      success: false,
      status: 'REJECTED',
      error: `Failed to parse validated data in target version: ${String(err)}`,
    };
  }

  // Deep clone data to stage patch
  const stagedData: ValidatedMatchData = JSON.parse(JSON.stringify(currentData));

  // 5. Disambiguate and Apply Patch
  const patch = input.patch;

  // Resolve team side
  let targetSide: 'TEAM_A' | 'TEAM_B' | null = patch.team_side || null;
  if (!targetSide && patch.team_name) {
    const teamRes = await db.execute({
      sql: 'SELECT id, team_name FROM teams WHERE id IN (?, ?)',
      args: [stagedData.team_a_id, stagedData.team_b_id],
    });
    for (const r of teamRes.rows) {
      const id = String(r[0]);
      const name = String(r[1]).toLowerCase();
      if (patch.team_name.toLowerCase().includes(name) || name.includes(patch.team_name.toLowerCase())) {
        targetSide = id === stagedData.team_a_id ? 'TEAM_A' : 'TEAM_B';
        break;
      }
    }
  }

  // If metric is 'score'
  if (patch.metric === 'score') {
    if (!targetSide) {
      const reason = 'Ambiguous score correction: specify which team (Team A or Team B) score to update.';
      await recordCorrection(db, {
        id: correctionId,
        report_version_id: targetVersion.id,
        inbound_message_id: input.inbound_message_id,
        submitted_by_delegate_id: input.sender_id,
        parsed_patch_json: JSON.stringify(patch),
        status: 'NEEDS_CLARIFICATION',
        organizer_reason: reason,
        created_at: now,
        resolved_at: now,
      });
      return {
        success: false,
        status: 'NEEDS_CLARIFICATION',
        clarification_reason: reason,
      };
    }

    const newScore = Number(patch.new_value);
    if (isNaN(newScore) || newScore < 0 || !Number.isInteger(newScore)) {
      return {
        success: false,
        status: 'REJECTED',
        error: `Invalid new score value: ${patch.new_value}`,
      };
    }

    if (targetSide === 'TEAM_A') {
      stagedData.team_a_score = newScore;
    } else {
      stagedData.team_b_score = newScore;
    }
  } else {
    // Player metric correction ('goals' | 'assists' | 'passes' | 'defense' | 'rating')
    if (!targetSide) {
      // If team side not specified, try to find player by nickname across teams
      if (patch.player_nickname) {
        const foundInA = stagedData.team_a_players.filter((p) =>
          p.nickname_raw.toLowerCase().includes(patch.player_nickname!.toLowerCase())
        );
        const foundInB = stagedData.team_b_players.filter((p) =>
          p.nickname_raw.toLowerCase().includes(patch.player_nickname!.toLowerCase())
        );

        if (foundInA.length === 1 && foundInB.length === 0) {
          targetSide = 'TEAM_A';
        } else if (foundInB.length === 1 && foundInA.length === 0) {
          targetSide = 'TEAM_B';
        } else {
          const reason =
            `Ambiguous player target "${patch.player_nickname}": please specify team name or team side.`;
          await recordCorrection(db, {
            id: correctionId,
            report_version_id: targetVersion.id,
            inbound_message_id: input.inbound_message_id,
            submitted_by_delegate_id: input.sender_id,
            parsed_patch_json: JSON.stringify(patch),
            status: 'NEEDS_CLARIFICATION',
            organizer_reason: reason,
            created_at: now,
            resolved_at: now,
          });
          return {
            success: false,
            status: 'NEEDS_CLARIFICATION',
            clarification_reason: reason,
          };
        }
      } else {
        const reason = 'Ambiguous correction: missing team specification and player identifier.';
        await recordCorrection(db, {
          id: correctionId,
          report_version_id: targetVersion.id,
          inbound_message_id: input.inbound_message_id,
          submitted_by_delegate_id: input.sender_id,
          parsed_patch_json: JSON.stringify(patch),
          status: 'NEEDS_CLARIFICATION',
          organizer_reason: reason,
          created_at: now,
          resolved_at: now,
        });
        return {
          success: false,
          status: 'NEEDS_CLARIFICATION',
          clarification_reason: reason,
        };
      }
    }

    const playerList = targetSide === 'TEAM_A' ? stagedData.team_a_players : stagedData.team_b_players;

    // Resolve player within playerList
    let targetPlayer: (typeof playerList)[0] | undefined;
    if (patch.player_ordinal !== undefined) {
      const idx = patch.player_ordinal - 1;
      if (idx >= 0 && idx < playerList.length) {
        targetPlayer = playerList[idx];
      } else {
        const reason = `Player ordinal ${patch.player_ordinal} out of range for team lineup (size ${playerList.length}).`;
        await recordCorrection(db, {
          id: correctionId,
          report_version_id: targetVersion.id,
          inbound_message_id: input.inbound_message_id,
          submitted_by_delegate_id: input.sender_id,
          parsed_patch_json: JSON.stringify(patch),
          status: 'NEEDS_CLARIFICATION',
          organizer_reason: reason,
          created_at: now,
          resolved_at: now,
        });
        return {
          success: false,
          status: 'NEEDS_CLARIFICATION',
          clarification_reason: reason,
        };
      }
    } else if (patch.player_nickname) {
      targetPlayer = playerList.find((p) =>
        p.nickname_raw.toLowerCase().includes(patch.player_nickname!.toLowerCase())
      );
      if (!targetPlayer) {
        const reason = `Player "${patch.player_nickname}" not found in ${targetSide} lineup.`;
        await recordCorrection(db, {
          id: correctionId,
          report_version_id: targetVersion.id,
          inbound_message_id: input.inbound_message_id,
          submitted_by_delegate_id: input.sender_id,
          parsed_patch_json: JSON.stringify(patch),
          status: 'NEEDS_CLARIFICATION',
          organizer_reason: reason,
          created_at: now,
          resolved_at: now,
        });
        return {
          success: false,
          status: 'NEEDS_CLARIFICATION',
          clarification_reason: reason,
        };
      }
    } else {
      const reason = 'Correction must specify player ordinal or player nickname.';
      await recordCorrection(db, {
        id: correctionId,
        report_version_id: targetVersion.id,
        inbound_message_id: input.inbound_message_id,
        submitted_by_delegate_id: input.sender_id,
        parsed_patch_json: JSON.stringify(patch),
        status: 'NEEDS_CLARIFICATION',
        organizer_reason: reason,
        created_at: now,
        resolved_at: now,
      });
      return {
        success: false,
        status: 'NEEDS_CLARIFICATION',
        clarification_reason: reason,
      };
    }

    // Apply metric update
    const numVal = Number(patch.new_value);
    if (isNaN(numVal) || numVal < 0) {
      return {
        success: false,
        status: 'REJECTED',
        error: `Invalid non-negative value for metric ${patch.metric}: ${patch.new_value}`,
      };
    }

    if (patch.metric === 'goals') {
      targetPlayer.goals = numVal;
      // Re-sum team score if score needs updating
      const newTeamScore = playerList.reduce((sum, p) => sum + p.goals, 0);
      if (targetSide === 'TEAM_A') {
        stagedData.team_a_score = newTeamScore;
      } else {
        stagedData.team_b_score = newTeamScore;
      }
    } else if (patch.metric === 'assists') {
      targetPlayer.assists = numVal;
    } else if (patch.metric === 'passes') {
      targetPlayer.passes = numVal;
    } else if (patch.metric === 'defense') {
      targetPlayer.defense_raw = numVal;
      if (targetPlayer.goalkeeper_saves !== null) {
        targetPlayer.goalkeeper_saves = numVal;
      }
    } else if (patch.metric === 'rating') {
      targetPlayer.rating = numVal;
    }
  }

  // 6. Run Deterministic Backend Validation on Staged Data
  const validationResult = await validateMatchReport(db, {
    fixture_id: stagedData.fixture_id,
    game_id: stagedData.game_id,
    team_a_id: stagedData.team_a_id,
    team_b_id: stagedData.team_b_id,
    team_a_score: stagedData.team_a_score,
    team_b_score: stagedData.team_b_score,
    team_a_players: stagedData.team_a_players,
    team_b_players: stagedData.team_b_players,
  });

  if (!validationResult.isValid) {
    return {
      success: false,
      status: 'REJECTED',
      error: `Staged correction failed validation: ${validationResult.errors.join('; ')}`,
    };
  }

  // 7. Applying patch creates NEW version and RESETS ALL APPROVALS (FR-APR-003, FR-COR-006)
  // Since approvals are bound to immutable report_version_id, creating the new version
  // inherently resets approvals for the active draft.
  const newVersion = await createNextReportVersion(db, {
    previous_version_id: targetVersion.id,
    validated_data_json: JSON.stringify(validationResult.validatedData!),
    provenance: targetVersion.provenance === 'MANUAL_ENTRY' ? 'MANUAL_ENTRY' : 'MIXED',
    created_by: input.sender_id,
    status: 'PENDING_APPROVAL',
  });

  // 8. Record correction in `corrections` table
  const correction: Correction = {
    id: correctionId,
    report_version_id: newVersion.id,
    inbound_message_id: input.inbound_message_id,
    submitted_by_delegate_id: input.sender_id,
    parsed_patch_json: JSON.stringify(patch),
    status: 'ACCEPTED',
    organizer_reason: patch.reason || null,
    created_at: now,
    resolved_at: now,
  };

  await recordCorrection(db, correction);

  // 9. Record audit event
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
      auth.role === 'ORGANIZER' ? 'ORGANIZER' : 'DELEGATE',
      input.sender_id,
      'REPORT_CORRECTION_APPLIED',
      'report_versions',
      newVersion.id,
      targetVersion.validated_data_json,
      newVersion.validated_data_json,
      patch.reason || 'Correction applied creating new version',
      correlationId,
      now,
    ],
  });

  return {
    success: true,
    status: 'ACCEPTED',
    newVersion,
    correction,
  };
}

/**
 * Helper to record correction entry.
 */
async function recordCorrection(
  db: Client,
  correction: {
    id: UUID;
    report_version_id: UUID;
    inbound_message_id: UUID;
    submitted_by_delegate_id: UUID | null;
    parsed_patch_json: string;
    status: CorrectionStatus;
    organizer_reason?: string | null;
    created_at: ISODateString;
    resolved_at?: ISODateString | null;
  }
): Promise<void> {
  // Check if submitted_by_delegate_id is a registered delegate (foreign key check)
  let validDelegateId: string | null = null;
  if (correction.submitted_by_delegate_id) {
    const delCheck = await db.execute({
      sql: 'SELECT id FROM delegates WHERE id = ?',
      args: [correction.submitted_by_delegate_id],
    });
    if (delCheck.rows.length > 0) {
      validDelegateId = correction.submitted_by_delegate_id;
    }
  }

  await db.execute({
    sql: `
      INSERT INTO corrections (
        id, report_version_id, inbound_message_id, submitted_by_delegate_id,
        parsed_patch_json, status, organizer_reason, created_at, resolved_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      correction.id,
      correction.report_version_id,
      correction.inbound_message_id,
      validDelegateId,
      correction.parsed_patch_json,
      correction.status,
      correction.organizer_reason || null,
      correction.created_at,
      correction.resolved_at || null,
    ],
  });
}
