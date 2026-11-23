/**
 * Flash Peak TMS - Three-Party Approval Engine (Task 5.4)
 * 
 * Manages the authoritative three-party approval lifecycle (FR-APR-001 to FR-APR-004).
 * 
 * Rules:
 * 1. Three-Party Consensus: Requires approval from TEAM_A delegate, TEAM_B delegate,
 *    and ORGANIZER (FR-APR-001).
 * 2. Immutable Binding: Approvals are bound strictly to immutable report_version_id (FR-APR-002).
 * 3. Invalidation: Any new version creates a fresh version with 0 approvals (FR-APR-003).
 * 4. Lock on Full Consensus: When all 3 approve the same version -> transitions to `LOCKED`
 *    and triggers player statistics writing (Task 5.6).
 * 5. Rejection Flow: A rejection transitions report status to `NEEDS_CORRECTION` / `REJECTED`.
 * 6. Organizer Override: Organizer may unilaterally lock, reopen, or override with audit log (FR-APR-004).
 * 7. Immutability: Once `LOCKED`, no new approvals can be submitted unless reopened.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  Approval,
  ApproverType,
  ApprovalDecision,
  ReportVersion,
  ReportVersionStatus,
  UUID,
  ISODateString,
} from '../shared/types/index.js';
import { getReportVersion, updateReportVersionStatus } from './versioning.js';
import { onReportLocked } from './stats.js';

export interface SubmitApprovalInput {
  report_version_id: UUID;
  approver_type: ApproverType;
  approver_id: string; // delegate_id or organizer identifier
  decision: ApprovalDecision; // 'APPROVE' | 'REJECT'
  is_organizer?: boolean;
  rejection_reason?: string;
  correlation_id?: string;
  /**
   * FIX2-APR-003 (audit temuan 3.3): configured organizer identities
   * (normalized JIDs / phone digits, from WA_ORGANIZER_JID / WA_ORGANIZER_PHONE).
   * Required for ORGANIZER-type approvals so authority is verified against
   * configuration instead of loose string patterns on the approver id.
   */
  allowed_organizer_ids?: string[];
}

export interface ApprovalOutcome {
  report_version_id: UUID;
  status: ReportVersionStatus;
  isLocked: boolean;
  approvals: Approval[];
  missingApprovers: ApproverType[];
  message: string;
}

export interface OrganizerOverrideLockInput {
  report_version_id: UUID;
  organizer_id: string;
  reason: string;
  correlation_id?: string;
}

export interface OrganizerReopenInput {
  report_version_id: UUID;
  organizer_id: string;
  reason: string;
  correlation_id?: string;
}

/**
 * Validates whether the approver has authority for the claimed ApproverType.
 */
async function verifyApproverAuthority(
  db: Client,
  fixtureId: UUID,
  approverType: ApproverType,
  approverId: string,
  isOrganizerExplicit?: boolean,
  allowedOrganizerIds?: string[]
): Promise<{ authorized: boolean; reason?: string }> {
  if (approverType === 'ORGANIZER') {
    // FIX2-APR-003 (audit temuan 3.3 Medium): the old check accepted any id
    // starting with "org_" or merely CONTAINING "organizer" — arbitrary text
    // could pass as an organizer voice. Authority is now derived from identity:
    // either the caller explicitly asserted organizer AND the id is one of the
    // configured organizer identities (WA_ORGANIZER_JID / WA_ORGANIZER_PHONE,
    // resolved by CommandRouter.isSenderOrganizer upstream), or the bare
    // system constant 'ORGANIZER' used by internal/admin paths.
    // When no identities are configured at all (unit-test / admin-tool context),
    // an explicit is_organizer assertion remains the trust boundary — same as
    // the production router path where only the configured organizer can set it.
    const hasConfiguredIds = (allowedOrganizerIds ?? []).length > 0;
    const allowed = new Set<string>(['ORGANIZER', ...(allowedOrganizerIds ?? [])]);
    if (allowed.has(approverId)) {
      return { authorized: true };
    }
    if (isOrganizerExplicit && !hasConfiguredIds) {
      return { authorized: true };
    }
    return {
      authorized: false,
      reason: `Approver "${approverId}" is not recognized as an authorized tournament organizer.`,
    };
  }

  // Look up fixture and registered delegates
  const res = await db.execute({
    sql: `
      SELECT f.id,
             ta.delegate_id AS delegate_a,
             tb.delegate_id AS delegate_b
      FROM fixtures f
      LEFT JOIN teams ta ON f.team_a_id = ta.id
      LEFT JOIN teams tb ON f.team_b_id = tb.id
      WHERE f.id = ?
    `,
    args: [fixtureId],
  });

  if (res.rows.length === 0) {
    return { authorized: false, reason: `Fixture not found: ${fixtureId}` };
  }

  const row = res.rows[0];
  const delegateA = row[1] ? String(row[1]) : null;
  const delegateB = row[2] ? String(row[2]) : null;

  if (approverType === 'TEAM_A') {
    if (!delegateA || approverId !== delegateA) {
      return {
        authorized: false,
        reason: `Approver "${approverId}" is not the registered delegate for Team A.`,
      };
    }
    return { authorized: true };
  }

  if (approverType === 'TEAM_B') {
    if (!delegateB || approverId !== delegateB) {
      return {
        authorized: false,
        reason: `Approver "${approverId}" is not the registered delegate for Team B.`,
      };
    }
    return { authorized: true };
  }

  return { authorized: false, reason: 'Invalid approver type.' };
}

/**
 * Determines required approvers based on match outcome.
 * Only the winning team and organizer are required to approve.
 * If match ended in a draw, both teams and organizer must approve.
 */
export function getRequiredApprovers(version: ReportVersion): ApproverType[] {
  let scoreA: number | null = null;
  let scoreB: number | null = null;

  const tryExtractScores = (jsonStr?: string | null) => {
    if (!jsonStr) return;
    try {
      const parsed = JSON.parse(jsonStr);
      const data = parsed.validatedData || parsed.raw_extraction || parsed.summary_data || parsed;
      if (
        data &&
        data.team_a_score !== undefined &&
        data.team_b_score !== undefined &&
        data.team_a_score !== null &&
        data.team_b_score !== null
      ) {
        scoreA = Number(data.team_a_score);
        scoreB = Number(data.team_b_score);
      }
    } catch {
      // ignore parse error
    }
  };

  tryExtractScores(version.validated_data_json);
  if (scoreA === null || scoreB === null || isNaN(scoreA) || isNaN(scoreB)) {
    tryExtractScores(version.extraction_json);
  }

  if (scoreA !== null && scoreB !== null && !isNaN(scoreA) && !isNaN(scoreB)) {
    if (scoreA > scoreB) {
      return ['TEAM_A', 'ORGANIZER'];
    }
    if (scoreB > scoreA) {
      return ['TEAM_B', 'ORGANIZER'];
    }
    // Seri / Draw -> Kedua tim & Panitia
    return ['TEAM_A', 'TEAM_B', 'ORGANIZER'];
  }

  // Fallback
  return ['TEAM_A', 'TEAM_B', 'ORGANIZER'];
}

/**
 * Submits an approval or rejection for a specific immutable report version.
 */
export async function submitReportApproval(
  db: Client,
  input: SubmitApprovalInput
): Promise<ApprovalOutcome> {
  const now: ISODateString = new Date().toISOString();
  const correlationId = input.correlation_id || randomUUID();

  // 1. Fetch report version
  const version = await getReportVersion(db, input.report_version_id);
  if (!version) {
    throw new Error(`Report version not found: ${input.report_version_id}`);
  }

  // 2. Immutability check: cannot vote on an already LOCKED report
  if (version.status === 'LOCKED') {
    throw new Error(
      `Cannot submit approval on an already LOCKED report (${version.id}). Organizer must reopen the report first.`
    );
  }

  // 3. Authority check
  const auth = await verifyApproverAuthority(
    db,
    version.fixture_id,
    input.approver_type,
    input.approver_id,
    input.is_organizer,
    input.allowed_organizer_ids
  );

  if (!auth.authorized) {
    throw new Error(`Unauthorized approval: ${auth.reason}`);
  }

  // 4. Record or update approval decision
  const approvalId: UUID = randomUUID();
  await db.execute({
    sql: `
      INSERT INTO approvals (id, report_version_id, approver_type, approver_id, decision, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (report_version_id, approver_type, approver_id)
      DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at
    `,
    args: [
      approvalId,
      input.report_version_id,
      input.approver_type,
      input.approver_id,
      input.decision,
      now,
    ],
  });

  // 5. Audit event for the vote
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
      input.approver_type === 'ORGANIZER' ? 'ORGANIZER' : 'DELEGATE',
      input.approver_id,
      `REPORT_VOTE_${input.decision}`,
      'report_versions',
      version.id,
      JSON.stringify({ status: version.status }),
      JSON.stringify({ approver_type: input.approver_type, decision: input.decision }),
      input.rejection_reason || null,
      correlationId,
      now,
    ],
  });

  // 6. If rejection: transition report to NEEDS_CORRECTION
  if (input.decision === 'REJECT') {
    await updateReportVersionStatus(db, version.id, 'NEEDS_CORRECTION');
    const allApprovals = await getReportApprovals(db, version.id);

    return {
      report_version_id: version.id,
      status: 'NEEDS_CORRECTION',
      isLocked: false,
      approvals: allApprovals,
      missingApprovers: [],
      message: `Report rejected by ${input.approver_type}: ${input.rejection_reason || 'No reason specified'}`,
    };
  }

  // 7. Check if required parties have approved (Winning team + Organizer, or both teams + Organizer if draw)
  const allApprovals = await getReportApprovals(db, version.id);
  const approvedTypes = new Set<ApproverType>(
    allApprovals.filter((a) => a.decision === 'APPROVE').map((a) => a.approver_type)
  );

  const requiredTypes = getRequiredApprovers(version);
  const missingApprovers = requiredTypes.filter((t) => !approvedTypes.has(t));

  if (missingApprovers.length === 0) {
    // All required parties approved -> transition to LOCKED!
    await updateReportVersionStatus(db, version.id, 'LOCKED');

    // Trigger post-lock stats writing and game finalization (Task 5.6)
    await onReportLocked(db, version.id);

    // Audit event for final lock
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
        'SYSTEM',
        'SYSTEM',
        'REPORT_LOCKED_CONSENSUS',
        'report_versions',
        version.id,
        JSON.stringify({ status: 'PENDING_APPROVAL' }),
        JSON.stringify({ status: 'LOCKED' }),
        'Report approved by required parties (winning team and organizer, or all parties if draw).',
        correlationId,
        now,
      ],
    });

    const isWinnerOnly = requiredTypes.length === 2 && !requiredTypes.includes('TEAM_A') || !requiredTypes.includes('TEAM_B');
    const lockMsg = isWinnerOnly
      ? '✅ Laporan pertandingan telah disetujui oleh tim pemenang dan Panitia. Status resmi LOCKED! Klasemen telah diperbarui.'
      : '✅ Laporan pertandingan telah disetujui oleh kedua tim dan Panitia. Status resmi LOCKED! Klasemen telah diperbarui.';

    return {
      report_version_id: version.id,
      status: 'LOCKED',
      isLocked: true,
      approvals: allApprovals,
      missingApprovers: [],
      message: lockMsg,
    };
  }

  const missingLabels = missingApprovers.map((m) => {
    if (m === 'TEAM_A') return 'Delegasi Tim Pemenang (Tim A)';
    if (m === 'TEAM_B') return 'Delegasi Tim Pemenang (Tim B)';
    return 'Panitia / Organizer';
  }).join(', ');

  // Partial approvals: remains PENDING_APPROVAL
  return {
    report_version_id: version.id,
    status: 'PENDING_APPROVAL',
    isLocked: false,
    approvals: allApprovals,
    missingApprovers,
    message: `Vote persetujuan dicatat. Masih menunggu persetujuan dari: *${missingLabels}*.\nKetik *!approve* untuk menyetujui.`,
  };
}

/**
 * Organizer unilateral lock override (FR-APR-004).
 * Directly transitions report version to LOCKED with audit record.
 */
export async function organizerOverrideLock(
  db: Client,
  input: OrganizerOverrideLockInput
): Promise<ReportVersion> {
  const version = await getReportVersion(db, input.report_version_id);
  if (!version) {
    throw new Error(`Report version not found: ${input.report_version_id}`);
  }

  const now: ISODateString = new Date().toISOString();
  const correlationId = input.correlation_id || randomUUID();

  // Update status to LOCKED
  const updated = await updateReportVersionStatus(db, version.id, 'LOCKED', {
    isOrganizer: true,
    reason: input.reason,
  });

  // Finalize stats
  await onReportLocked(db, version.id);

  // Record audit trail
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
      'ORGANIZER_OVERRIDE_LOCK',
      'report_versions',
      version.id,
      JSON.stringify({ status: version.status }),
      JSON.stringify({ status: 'LOCKED' }),
      input.reason,
      correlationId,
      now,
    ],
  });

  return updated;
}

/**
 * Organizer reopen report (FR-APR-004).
 * Transitions report from LOCKED back to NEEDS_CORRECTION so new corrections can be applied.
 *
 * FIX2-APR-002 (approval reset): reopening now also deletes the old approvals
 * bound to this report version. Without the reset, a single fresh vote after
 * reopen would complete the old 3-party consensus and re-LOCK the report
 * without it ever being re-validated, defeating the purpose of reopening.
 * After a reopen, the approval count genuinely starts from zero (0/3) per the
 * spirit of FR-APR-003 (fresh consensus on every corrected version).
 */
export async function organizerReopenReport(
  db: Client,
  input: OrganizerReopenInput
): Promise<ReportVersion> {
  const version = await getReportVersion(db, input.report_version_id);
  if (!version) {
    throw new Error(`Report version not found: ${input.report_version_id}`);
  }

  const now: ISODateString = new Date().toISOString();
  const correlationId = input.correlation_id || randomUUID();

  // Reopen status
  const updated = await updateReportVersionStatus(db, version.id, 'NEEDS_CORRECTION', {
    isOrganizer: true,
    reason: input.reason,
  });

  // Reset the old approvals: the next consensus must be built from zero.
  const resetRes = await db.execute({
    sql: 'DELETE FROM approvals WHERE report_version_id = ?',
    args: [version.id],
  });
  const resetCount = Number(resetRes.rowsAffected);

  // Record audit trail
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
      'ORGANIZER_REOPEN_REPORT',
      'report_versions',
      version.id,
      JSON.stringify({ status: version.status, approvals_reset: resetCount }),
      JSON.stringify({ status: 'NEEDS_CORRECTION', approvals: 0 }),
      input.reason,
      correlationId,
      now,
    ],
  });

  return updated;
}

/**
 * Retrieves all approvals for a specific report version.
 */
export async function getReportApprovals(
  db: Client,
  reportVersionId: UUID
): Promise<Approval[]> {
  const res = await db.execute({
    sql: `
      SELECT id, report_version_id, approver_type, approver_id, decision, created_at
      FROM approvals
      WHERE report_version_id = ?
      ORDER BY created_at ASC
    `,
    args: [reportVersionId],
  });

  return res.rows.map((row) => ({
    id: String(row[0]),
    report_version_id: String(row[1]),
    approver_type: String(row[2]) as ApproverType,
    approver_id: String(row[3]),
    decision: String(row[4]) as ApprovalDecision,
    created_at: String(row[5]),
  }));
}
