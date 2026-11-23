/**
 * Flash Peak TMS - Report Versioning Engine (Task 5.1)
 * 
 * Manages immutable report draft versions, version numbers (v1, v2, v3...),
 * extraction & validated payload persistence in the database, and media attachments.
 * 
 * Key Principles:
 * - Immutability: Once written, a report_version's extraction and validated payload
 *   are never modified in place (FR-COR-001, FR-COR-007).
 * - Corrections create a new incremented version number (FR-COR-006, FR-COR-007).
 * - Report context is explicitly persisted in DB (report_versions table),
 *   never relying on LLM chat memory (FR-COR-001).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  ReportVersion,
  ReportVersionStatus,
  ReportProvenance,
  MediaRole,
  ReportMedia,
  UUID,
  ISODateString,
} from '../shared/types/index.js';

export interface CreateReportDraftInput {
  report_session_id: UUID;
  fixture_id: UUID;
  extraction_json?: string;
  validated_data_json: string;
  provenance?: ReportProvenance; // Default: 'AI'
  created_by?: string; // Default: 'AI_PIPELINE'
  status?: ReportVersionStatus; // Default: 'PENDING_APPROVAL'
  media_assets?: Array<{
    media_asset_id: UUID;
    media_role: MediaRole;
    game_id?: UUID | null;
  }>;
}

export interface CreateNextVersionInput {
  previous_version_id: UUID;
  validated_data_json: string;
  extraction_json?: string;
  provenance?: ReportProvenance;
  created_by: string;
  status?: ReportVersionStatus;
  media_assets?: Array<{
    media_asset_id: UUID;
    media_role: MediaRole;
    game_id?: UUID | null;
  }>;
}

/**
 * Creates an initial or next draft version in `report_versions`.
 */
export async function createReportDraft(
  db: Client,
  input: CreateReportDraftInput
): Promise<ReportVersion> {
  const now: ISODateString = new Date().toISOString();
  const id: UUID = randomUUID();

  // Determine next version number for this session
  const maxVersionResult = await db.execute({
    sql: `
      SELECT COALESCE(MAX(version_number), 0) AS max_v
      FROM report_versions
      WHERE report_session_id = ?
    `,
    args: [input.report_session_id],
  });

  const rawMax = maxVersionResult.rows[0]?.[0] ?? (maxVersionResult.rows[0] as { max_v?: unknown })?.max_v ?? 0;
  const versionNumber = Number(rawMax) + 1;

  const version: ReportVersion = {
    id,
    report_session_id: input.report_session_id,
    fixture_id: input.fixture_id,
    version_number: versionNumber,
    status: input.status || 'PENDING_APPROVAL',
    extraction_json: input.extraction_json || '{}',
    validated_data_json: input.validated_data_json,
    provenance: input.provenance || 'AI',
    created_by: input.created_by || 'AI_PIPELINE',
    created_at: now,
  };

  await db.execute({
    sql: `
      INSERT INTO report_versions (
        id, report_session_id, fixture_id, version_number,
        status, extraction_json, validated_data_json,
        provenance, created_by, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      version.id,
      version.report_session_id,
      version.fixture_id,
      version.version_number,
      version.status,
      version.extraction_json,
      version.validated_data_json,
      version.provenance,
      version.created_by,
      version.created_at,
    ],
  });

  // Attach media assets if provided
  if (input.media_assets && input.media_assets.length > 0) {
    for (const item of input.media_assets) {
      await attachMediaToReportVersion(
        db,
        version.id,
        item.media_asset_id,
        item.media_role,
        item.game_id ?? null
      );
    }
  }

  // Update report session state if present
  await db.execute({
    sql: `
      UPDATE report_sessions
      SET status = 'DRAFT_READY', updated_at = ?
      WHERE id = ? AND status IN ('COLLECTING', 'PROCESSING')
    `,
    args: [now, input.report_session_id],
  });

  return version;
}

/**
 * Creates the next version in the chain from an existing version (FR-COR-006, FR-COR-007).
 * Existing version remains completely unchanged (immutable snapshot).
 */
export async function createNextReportVersion(
  db: Client,
  input: CreateNextVersionInput
): Promise<ReportVersion> {
  const previous = await getReportVersion(db, input.previous_version_id);
  if (!previous) {
    throw new Error(`Previous report version not found: ${input.previous_version_id}`);
  }

  const now: ISODateString = new Date().toISOString();
  const id: UUID = randomUUID();
  const nextVersionNumber = previous.version_number + 1;

  // If provenance not specified, inherit:
  // if previous was MANUAL_ENTRY -> keep MANUAL_ENTRY; if previous was AI -> becomes MIXED
  let nextProvenance: ReportProvenance = input.provenance || (
    previous.provenance === 'MANUAL_ENTRY' ? 'MANUAL_ENTRY' : 'MIXED'
  );

  const nextVersion: ReportVersion = {
    id,
    report_session_id: previous.report_session_id,
    fixture_id: previous.fixture_id,
    version_number: nextVersionNumber,
    status: input.status || 'PENDING_APPROVAL',
    extraction_json: input.extraction_json || previous.extraction_json,
    validated_data_json: input.validated_data_json,
    provenance: nextProvenance,
    created_by: input.created_by,
    created_at: now,
  };

  await db.execute({
    sql: `
      INSERT INTO report_versions (
        id, report_session_id, fixture_id, version_number,
        status, extraction_json, validated_data_json,
        provenance, created_by, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      nextVersion.id,
      nextVersion.report_session_id,
      nextVersion.fixture_id,
      nextVersion.version_number,
      nextVersion.status,
      nextVersion.extraction_json,
      nextVersion.validated_data_json,
      nextVersion.provenance,
      nextVersion.created_by,
      nextVersion.created_at,
    ],
  });

  // Attach media: either specified or inherited from previous version
  if (input.media_assets && input.media_assets.length > 0) {
    for (const item of input.media_assets) {
      await attachMediaToReportVersion(
        db,
        nextVersion.id,
        item.media_asset_id,
        item.media_role,
        item.game_id ?? null
      );
    }
  } else {
    // Inherit media from previous version
    const prevMedia = await getReportMedia(db, previous.id);
    for (const m of prevMedia) {
      await attachMediaToReportVersion(
        db,
        nextVersion.id,
        m.media_asset_id,
        m.media_role,
        m.game_id
      );
    }
  }

  return nextVersion;
}

/**
 * Retrieves a report version by its primary ID.
 */
export async function getReportVersion(
  db: Client,
  versionId: UUID
): Promise<ReportVersion | null> {
  const result = await db.execute({
    sql: `
      SELECT id, report_session_id, fixture_id, version_number,
             status, extraction_json, validated_data_json,
             provenance, created_by, created_at
      FROM report_versions
      WHERE id = ?
    `,
    args: [versionId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: String(row[0]),
    report_session_id: String(row[1]),
    fixture_id: String(row[2]),
    version_number: Number(row[3]),
    status: String(row[4]) as ReportVersionStatus,
    extraction_json: String(row[5]),
    validated_data_json: String(row[6]),
    provenance: String(row[7]) as ReportProvenance,
    created_by: String(row[8]),
    created_at: String(row[9]),
  };
}

/**
 * Retrieves the latest (highest version_number) report version for a given report session.
 */
export async function getLatestReportVersion(
  db: Client,
  sessionId: UUID
): Promise<ReportVersion | null> {
  const result = await db.execute({
    sql: `
      SELECT id, report_session_id, fixture_id, version_number,
             status, extraction_json, validated_data_json,
             provenance, created_by, created_at
      FROM report_versions
      WHERE report_session_id = ?
      ORDER BY version_number DESC
      LIMIT 1
    `,
    args: [sessionId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: String(row[0]),
    report_session_id: String(row[1]),
    fixture_id: String(row[2]),
    version_number: Number(row[3]),
    status: String(row[4]) as ReportVersionStatus,
    extraction_json: String(row[5]),
    validated_data_json: String(row[6]),
    provenance: String(row[7]) as ReportProvenance,
    created_by: String(row[8]),
    created_at: String(row[9]),
  };
}

/**
 * Retrieves all report versions for a report session, ordered by version_number ascending.
 */
export async function getReportVersionsBySession(
  db: Client,
  sessionId: UUID
): Promise<ReportVersion[]> {
  const result = await db.execute({
    sql: `
      SELECT id, report_session_id, fixture_id, version_number,
             status, extraction_json, validated_data_json,
             provenance, created_by, created_at
      FROM report_versions
      WHERE report_session_id = ?
      ORDER BY version_number ASC
    `,
    args: [sessionId],
  });

  return result.rows.map((row) => ({
    id: String(row[0]),
    report_session_id: String(row[1]),
    fixture_id: String(row[2]),
    version_number: Number(row[3]),
    status: String(row[4]) as ReportVersionStatus,
    extraction_json: String(row[5]),
    validated_data_json: String(row[6]),
    provenance: String(row[7]) as ReportProvenance,
    created_by: String(row[8]),
    created_at: String(row[9]),
  }));
}

/**
 * Retrieves all report versions for a fixture.
 */
export async function getReportVersionsByFixture(
  db: Client,
  fixtureId: UUID
): Promise<ReportVersion[]> {
  const result = await db.execute({
    sql: `
      SELECT id, report_session_id, fixture_id, version_number,
             status, extraction_json, validated_data_json,
             provenance, created_by, created_at
      FROM report_versions
      WHERE fixture_id = ?
      ORDER BY created_at ASC, version_number ASC
    `,
    args: [fixtureId],
  });

  return result.rows.map((row) => ({
    id: String(row[0]),
    report_session_id: String(row[1]),
    fixture_id: String(row[2]),
    version_number: Number(row[3]),
    status: String(row[4]) as ReportVersionStatus,
    extraction_json: String(row[5]),
    validated_data_json: String(row[6]),
    provenance: String(row[7]) as ReportProvenance,
    created_by: String(row[8]),
    created_at: String(row[9]),
  }));
}

/**
 * Updates the status of an existing report version.
 * If current status is LOCKED, disallows changes unless authorized.
 */
export async function updateReportVersionStatus(
  db: Client,
  versionId: UUID,
  newStatus: ReportVersionStatus,
  options?: { isOrganizer?: boolean; reason?: string }
): Promise<ReportVersion> {
  const current = await getReportVersion(db, versionId);
  if (!current) {
    throw new Error(`Report version not found: ${versionId}`);
  }

  // Immutability check: once locked, only organizer can change status (reopen)
  if (current.status === 'LOCKED' && newStatus !== 'LOCKED') {
    if (!options?.isOrganizer) {
      throw new Error(
        `Cannot change status of a LOCKED report (${versionId}). Only tournament organizer may reopen a locked report.`
      );
    }
  }

  await db.execute({
    sql: 'UPDATE report_versions SET status = ? WHERE id = ?',
    args: [newStatus, versionId],
  });

  return {
    ...current,
    status: newStatus,
  };
}

/**
 * Attaches a media asset to a report version in `report_media`.
 */
export async function attachMediaToReportVersion(
  db: Client,
  reportVersionId: UUID,
  mediaAssetId: UUID,
  mediaRole: MediaRole,
  gameId?: UUID | null
): Promise<void> {
  await db.execute({
    sql: `
      INSERT OR REPLACE INTO report_media (
        report_version_id, media_asset_id, game_id, media_role
      )
      VALUES (?, ?, ?, ?)
    `,
    args: [reportVersionId, mediaAssetId, gameId || null, mediaRole],
  });
}

/**
 * Retrieves all media attached to a report version.
 */
export async function getReportMedia(
  db: Client,
  reportVersionId: UUID
): Promise<ReportMedia[]> {
  const result = await db.execute({
    sql: `
      SELECT report_version_id, media_asset_id, game_id, media_role
      FROM report_media
      WHERE report_version_id = ?
    `,
    args: [reportVersionId],
  });

  return result.rows.map((row) => ({
    report_version_id: String(row[0]),
    media_asset_id: String(row[1]),
    game_id: row[2] ? String(row[2]) : null,
    media_role: String(row[3]) as MediaRole,
  }));
}
