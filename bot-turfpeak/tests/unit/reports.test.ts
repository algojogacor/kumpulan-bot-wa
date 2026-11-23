/**
 * Flash Peak TMS - Reports, Approvals & Manual Mode Unit Tests (Fase 5)
 * 
 * Verifies all Fase 5 requirements:
 * 1. Task 5.1: Report Versioning (draft creation, immutable v1/v2/v3 snapshots, media attachment).
 * 2. Task 5.2: Backend Validation (player counts 1 GK + 4 outfield, roster membership, score consistency,
 *    non-negative metrics, duplicate detection, recomputed totals).
 * 3. Task 5.3: Correction Orchestration (authority check, invalidation of approvals on new version,
 *    patch staging, clarification requests, locked report rejection).
 * 4. Task 5.4: Three-Party Approval (Team A + Team B + Organizer -> LOCKED; partial approval remains
 *    PENDING_APPROVAL; rejection flow; organizer override lock & reopen).
 * 5. Task 5.5: Manual Mode (!manualreport admin-only check, identical validation, provenance MANUAL_ENTRY,
 *    AI protection flag).
 * 6. Task 5.6: Stats Writer (player_game_stats written on lock, award eligibility: outfield=1, GK=1 only if won,
 *    defense_raw vs saves separation, walkovers write NO player stats, game & fixture completion).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createReportDraft,
  createNextReportVersion,
  getReportVersion,
  getLatestReportVersion,
  getReportVersionsBySession,
  getReportVersionsByFixture,
  updateReportVersionStatus,
  attachMediaToReportVersion,
  getReportMedia,
} from '../../src/reports/versioning.js';
import {
  validateMatchReport,
  matchPlayerToRoster,
  cleanSearchKey,
  computeSimilarity,
  type RawPlayerMatchStat,
} from '../../src/reports/validation.js';
import {
  applyReportCorrection,
} from '../../src/reports/corrections.js';
import {
  submitReportApproval,
  organizerOverrideLock,
  organizerReopenReport,
  getReportApprovals,
} from '../../src/reports/approval.js';
import {
  handleManualReport,
  isSessionManualProtected,
} from '../../src/reports/manual.js';
import {
  onReportLocked,
} from '../../src/reports/stats.js';
import type {
  StructuredCorrectionPatch,
} from '../../src/shared/types/index.js';

describe('Reports, Approvals & Manual Mode (Fase 5)', () => {
  let db: Client;

  // Test Fixture context
  const tournamentId = 'tourn-fase5-001';
  const delegateAId = 'del-fase5-team-a';
  const delegateBId = 'del-fase5-team-b';
  const organizerId = 'organizer-admin-001';
  const teamAId = 'team-fase5-a';
  const teamBId = 'team-fase5-b';
  const fixtureId = 'fix-fase5-001';
  const gameId = 'game-fase5-001';
  const sessionId = 'session-fase5-001';

  async function seedTestData(client: Client) {
    const now = new Date().toISOString();

    // 1. Tournament
    await client.execute({
      sql: `
        INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
        VALUES (?, 'Fase 5 Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)
      `,
      args: [tournamentId, now, now],
    });

    // 2. Delegates
    await client.execute({
      sql: `
        INSERT INTO delegates (id, display_name, status, created_at, updated_at)
        VALUES (?, 'Delegate Team A', 'ACTIVE', ?, ?),
               (?, 'Delegate Team B', 'ACTIVE', ?, ?)
      `,
      args: [delegateAId, now, now, delegateBId, now, now],
    });

    // 3. Teams
    await client.execute({
      sql: `
        INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
        VALUES (?, ?, 'Astra Lumina', ?, 'VERIFIED', ?, ?),
               (?, ?, 'Chronos Peak', ?, 'VERIFIED', ?, ?)
      `,
      args: [teamAId, tournamentId, delegateAId, now, now, teamBId, tournamentId, delegateBId, now, now],
    });

    // 4. Players (5 for Team A: 1 GK, 4 Outfield; 5 for Team B: 1 GK, 4 Outfield)
    const teamAPlayers = [
      { id: 'p-a-gk', nick: 'AstraGK', pos: 'GOALKEEPER' },
      { id: 'p-a-1', nick: 'AstraStriker', pos: 'OUTFIELD' },
      { id: 'p-a-2', nick: 'AstraMid', pos: 'OUTFIELD' },
      { id: 'p-a-3', nick: 'AstraWing', pos: 'OUTFIELD' },
      { id: 'p-a-4', nick: 'AstraDef', pos: 'OUTFIELD' },
    ];

    const teamBPlayers = [
      { id: 'p-b-gk', nick: 'ChronosGK', pos: 'GOALKEEPER' },
      { id: 'p-b-1', nick: 'ChronosForward', pos: 'OUTFIELD' },
      { id: 'p-b-2', nick: 'ChronosMid', pos: 'OUTFIELD' },
      { id: 'p-b-3', nick: 'ChronosWinger', pos: 'OUTFIELD' },
      { id: 'p-b-4', nick: 'ChronosDef', pos: 'OUTFIELD' },
    ];

    for (let i = 0; i < teamAPlayers.length; i++) {
      const p = teamAPlayers[i];
      await client.execute({
        sql: `
          INSERT INTO players (
            id, tournament_id, team_id, nickname_raw, nickname_nfc,
            nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)
        `,
        args: [
          p.id,
          tournamentId,
          teamAId,
          p.nick,
          p.nick.normalize('NFC'),
          p.nick.toLowerCase(),
          p.pos,
          i + 1,
          now,
          now,
        ],
      });
    }

    for (let i = 0; i < teamBPlayers.length; i++) {
      const p = teamBPlayers[i];
      await client.execute({
        sql: `
          INSERT INTO players (
            id, tournament_id, team_id, nickname_raw, nickname_nfc,
            nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)
        `,
        args: [
          p.id,
          tournamentId,
          teamBId,
          p.nick,
          p.nick.normalize('NFC'),
          p.nick.toLowerCase(),
          p.pos,
          i + 1,
          now,
          now,
        ],
      });
    }

    // 5. Fixture
    await client.execute({
      sql: `
        INSERT INTO fixtures (
          id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id,
          timezone, status, created_at, updated_at
        )
        VALUES (?, ?, 'GROUP', ?, ?, ?, 'Asia/Jakarta', 'SCHEDULED', ?, ?)
      `,
      args: [fixtureId, tournamentId, teamAId, teamBId, teamAId, now, now],
    });

    // 6. Game
    await client.execute({
      sql: `
        INSERT INTO games (
          id, fixture_id, game_number, status, is_draw, is_walkover,
          evidence_status, created_at, updated_at
        )
        VALUES (?, ?, 1, 'REPORT_PENDING', 0, 0, 'PENDING', ?, ?)
      `,
      args: [gameId, fixtureId, now, now],
    });

    // 7. Report Session
    await client.execute({
      sql: `
        INSERT INTO report_sessions (
          id, fixture_id, game_id, submitting_team_id, status,
          last_message_at, debounce_due_at, session_expires_at, extension_count, version, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'DRAFT_READY', ?, ?, NULL, 0, 1, ?, ?)
      `,
      args: [sessionId, fixtureId, gameId, teamAId, now, now, now, now],
    });

    // 8. Inbound message (for correction foreign key)
    await client.execute({
      sql: `
        INSERT INTO inbound_messages (
          id, provider_message_key, chat_id, sender_raw_address, delegate_id,
          message_timestamp, received_at, message_type, text_body, raw_metadata_json, created_at
        )
        VALUES ('inbound-msg-001', 'key-fase5-msg-001', '12345@g.us', '6281111111@s.whatsapp.net', ?,
                ?, ?, 'TEXT', 'Correction text', '{}', ?)
      `,
      args: [delegateAId, now, now, now],
    });
  }

  function createValidLineupA(): RawPlayerMatchStat[] {
    return [
      { nickname_raw: 'AstraGK', rating: 7.5, goals: 0, assists: 0, passes: 10, defense_raw: 5 },
      { nickname_raw: 'AstraStriker', rating: 8.5, goals: 2, assists: 1, passes: 15, defense_raw: 1 },
      { nickname_raw: 'AstraMid', rating: 7.8, goals: 1, assists: 2, passes: 25, defense_raw: 3 },
      { nickname_raw: 'AstraWing', rating: 7.2, goals: 0, assists: 0, passes: 12, defense_raw: 2 },
      { nickname_raw: 'AstraDef', rating: 7.0, goals: 0, assists: 0, passes: 18, defense_raw: 6 },
    ];
  }

  function createValidLineupB(): RawPlayerMatchStat[] {
    return [
      { nickname_raw: 'ChronosGK', rating: 6.8, goals: 0, assists: 0, passes: 8, defense_raw: 4 },
      { nickname_raw: 'ChronosForward', rating: 7.5, goals: 1, assists: 0, passes: 10, defense_raw: 0 },
      { nickname_raw: 'ChronosMid', rating: 7.0, goals: 0, assists: 1, passes: 20, defense_raw: 2 },
      { nickname_raw: 'ChronosWinger', rating: 6.9, goals: 0, assists: 0, passes: 14, defense_raw: 1 },
      { nickname_raw: 'ChronosDef', rating: 7.1, goals: 0, assists: 0, passes: 16, defense_raw: 5 },
    ];
  }

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
    await seedTestData(db);
  });

  afterEach(() => {
    db.close();
  });

  // ===========================================================================
  // Task 5.2: Backend Validation Engine
  // ===========================================================================
  describe('Task 5.2: Deterministic Backend Validation', () => {
    it('validates a correct match report successfully with recalculated totals and GK defense mapping', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3, // AstraStriker (2) + AstraMid (1) = 3
        team_b_score: 1, // ChronosForward (1) = 1
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.validatedData).toBeDefined();
      expect(validation.recalculatedScoreA).toBe(3);
      expect(validation.recalculatedScoreB).toBe(1);

      // Verify goalkeeper saves mapped from summary DEFENSE (FR-GK-003)
      const gkA = validation.validatedData!.team_a_players.find((p) => p.nickname_raw === 'AstraGK');
      expect(gkA?.goalkeeper_saves).toBe(5);
      expect(gkA?.defense_raw).toBe(5);

      const gkB = validation.validatedData!.team_b_players.find((p) => p.nickname_raw === 'ChronosGK');
      expect(gkB?.goalkeeper_saves).toBe(4);
      expect(gkB?.defense_raw).toBe(4);

      // Outfield player saves must remain null
      const strikerA = validation.validatedData!.team_a_players.find((p) => p.nickname_raw === 'AstraStriker');
      expect(strikerA?.goalkeeper_saves).toBeNull();
    });

    it('rejects lineup if active players count is not exactly 5 per side', async () => {
      const lineupWith4 = createValidLineupA().slice(0, 4);

      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: lineupWith4, // Only 4 players
        team_b_players: createValidLineupB(),
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('must have exactly 5 players'))).toBe(true);
    });

    it('rejects unregistered player in lineup (roster membership check)', async () => {
      const lineupA = createValidLineupA();
      lineupA[1].nickname_raw = 'UnknownRoguePlayer';

      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: lineupA,
        team_b_players: createValidLineupB(),
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('not a registered active player'))).toBe(true);
    });

    it('allows unregistered player on losing team with INELIGIBLE status and preserved score (Rule 2.12, D-035)', async () => {
      const lineupB = createValidLineupB();
      lineupB[1].nickname_raw = 'RogueLosingPlayer'; // Team B has unregistered player

      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: lineupB,
      });

      // Valid because Team B lost (3 - 1); innocent winning team A keeps their win and GD
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.warnings.some((w) => w.includes('INELIGIBLE'))).toBe(true);
      expect(validation.warnings.some((w) => w.includes('skor asli tetap berlaku'))).toBe(true);

      // Verify the player is registered as INELIGIBLE in DB
      const pRes = await db.execute({
        sql: `SELECT status FROM players WHERE nickname_raw = 'RogueLosingPlayer' AND team_id = ?`,
        args: [teamBId],
      });
      expect(pRes.rows.length).toBe(1);
      expect(String(pRes.rows[0][0])).toBe('INELIGIBLE');
    });

    it('rejects duplicate player row within a team lineup', async () => {
      const lineupA = createValidLineupA();
      lineupA[2].nickname_raw = 'AstraStriker'; // Duplicate striker instead of mid

      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 4,
        team_b_score: 1,
        team_a_players: lineupA,
        team_b_players: createValidLineupB(),
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('Duplicate player detected'))).toBe(true);
    });

    it('detects score inconsistency when player goals sum does not match team score', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 5, // Player goals sum is 2 + 1 = 3, but stated score is 5!
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('Score inconsistency for Team A'))).toBe(true);
      expect(validation.recalculatedScoreA).toBe(3);
    });

    it('rejects negative numbers in player statistics', async () => {
      const lineupA = createValidLineupA();
      lineupA[1].goals = -1;

      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 0,
        team_b_score: 1,
        team_a_players: lineupA,
        team_b_players: createValidLineupB(),
      });

      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('invalid goals'))).toBe(true);
    });
  });

  // ===========================================================================
  // Task 5.1: Report Versioning
  // ===========================================================================
  describe('Task 5.1: Report Versioning & Immutable Snapshots', () => {
    it('creates immutable draft v1 and increments to v2 without mutating v1', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draftV1 = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
        extraction_json: JSON.stringify({ note: 'AI initial extract' }),
        provenance: 'AI',
        created_by: 'AI_PIPELINE',
      });

      expect(draftV1.version_number).toBe(1);
      expect(draftV1.provenance).toBe('AI');
      expect(draftV1.status).toBe('PENDING_APPROVAL');

      // Create v2 with updated data
      const updatedData = { ...validation.validatedData!, team_a_score: 4 };
      const draftV2 = await createNextReportVersion(db, {
        previous_version_id: draftV1.id,
        validated_data_json: JSON.stringify(updatedData),
        created_by: delegateAId,
      });

      expect(draftV2.version_number).toBe(2);
      expect(draftV2.provenance).toBe('MIXED'); // AI upgraded with human correction

      // Assert v1 remains intact (immutable)
      const fetchedV1 = await getReportVersion(db, draftV1.id);
      expect(fetchedV1?.version_number).toBe(1);
      expect(JSON.parse(fetchedV1!.validated_data_json).team_a_score).toBe(3);

      // Assert latest version for session is v2
      const latest = await getLatestReportVersion(db, sessionId);
      expect(latest?.id).toBe(draftV2.id);
      expect(latest?.version_number).toBe(2);

      // Verify versions list for session
      const versions = await getReportVersionsBySession(db, sessionId);
      expect(versions).toHaveLength(2);
      expect(versions[0].version_number).toBe(1);
      expect(versions[1].version_number).toBe(2);
    });

    it('attaches and retrieves media assets to report version', async () => {
      // Create mock media asset
      const mediaId = randomUUID();
      const now = new Date().toISOString();
      await db.execute({
        sql: `
          INSERT INTO media_assets (
            id, storage_provider, storage_key, media_role, mime_type,
            byte_size, sha256, visibility, status, source_message_id, created_at
          )
          VALUES (?, 'FLASHPEAK_VM_MEDIA', 'matches/img.jpg', 'MAIN_MATCH', 'image/jpeg',
                  1024, ?, 'PRIVATE', 'STORED', 'inbound-msg-001', ?)
        `,
        args: [mediaId, 'a'.repeat(64), now],
      });

      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draft = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
        media_assets: [{ media_asset_id: mediaId, media_role: 'MAIN_MATCH', game_id: gameId }],
      });

      const media = await getReportMedia(db, draft.id);
      expect(media).toHaveLength(1);
      expect(media[0].media_asset_id).toBe(mediaId);
      expect(media[0].media_role).toBe('MAIN_MATCH');
    });
  });

  // ===========================================================================
  // Task 5.3: Correction Orchestration
  // ===========================================================================
  describe('Task 5.3: Correction Orchestration & Approval Invalidation', () => {
    it('applies player stat correction, creates new version, and resets approvals (FR-APR-003, FR-COR-006)', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draftV1 = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      // Delegate A approves v1
      await submitReportApproval(db, {
        report_version_id: draftV1.id,
        approver_type: 'TEAM_A',
        approver_id: delegateAId,
        decision: 'APPROVE',
      });

      const approvalsV1 = await getReportApprovals(db, draftV1.id);
      expect(approvalsV1).toHaveLength(1);

      // Now Delegate B submits a valid correction: "player urutan 2 (AstraStriker) assists should be 2 instead of 1"
      const patch: StructuredCorrectionPatch = {
        target_report_version_id: draftV1.id,
        team_side: 'TEAM_A',
        player_ordinal: 2, // AstraStriker
        metric: 'assists',
        stated_old_value: 1,
        new_value: 2,
        reason: 'Striker had 2 assists in first half',
        ambiguity_flags: [],
      };

      const result = await applyReportCorrection(db, {
        target_report_version_id: draftV1.id,
        sender_id: delegateBId, // Delegate B is authorized for this match
        inbound_message_id: 'inbound-msg-001',
        patch,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('ACCEPTED');
      expect(result.newVersion).toBeDefined();
      expect(result.newVersion?.version_number).toBe(2);

      // Check updated value in new version
      const v2Data = JSON.parse(result.newVersion!.validated_data_json);
      expect(v2Data.team_a_players[1].assists).toBe(2);

      // CRITICAL: Approvals on new version must be RESET to 0 (FR-APR-003)
      const approvalsV2 = await getReportApprovals(db, result.newVersion!.id);
      expect(approvalsV2).toHaveLength(0); // 0 approvals on fresh version!
    });

    it('rejects correction from unauthorized sender', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draftV1 = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      const result = await applyReportCorrection(db, {
        target_report_version_id: draftV1.id,
        sender_id: 'random-unauthorized-user',
        inbound_message_id: 'inbound-msg-001',
        patch: {
          target_report_version_id: draftV1.id,
          team_side: 'TEAM_A',
          metric: 'score',
          stated_old_value: 3,
          new_value: 4,
          ambiguity_flags: [],
        },
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('Unauthorized sender');
    });

    it('returns NEEDS_CLARIFICATION for ambiguous player correction', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draftV1 = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      const result = await applyReportCorrection(db, {
        target_report_version_id: draftV1.id,
        sender_id: delegateAId,
        inbound_message_id: 'inbound-msg-001',
        patch: {
          target_report_version_id: draftV1.id,
          // Missing team side and ambiguous non-existent player
          player_nickname: 'UnknownGuy',
          metric: 'goals',
          stated_old_value: 1,
          new_value: 2,
          ambiguity_flags: ['NO_TEAM_SPECIFIED'],
        },
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('NEEDS_CLARIFICATION');
      expect(result.clarification_reason).toBeDefined();
    });

    it('rejects correction on a LOCKED report', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draftV1 = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
        status: 'LOCKED', // Already locked!
      });

      const result = await applyReportCorrection(db, {
        target_report_version_id: draftV1.id,
        sender_id: delegateAId,
        inbound_message_id: 'inbound-msg-001',
        patch: {
          target_report_version_id: draftV1.id,
          team_side: 'TEAM_A',
          player_ordinal: 1,
          metric: 'passes',
          stated_old_value: 10,
          new_value: 12,
          ambiguity_flags: [],
        },
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('Cannot apply correction to a LOCKED report');
    });
  });

  // ===========================================================================
  // Task 5.4: Three-Party Approval Lifecycle
  // ===========================================================================
  describe('Task 5.4: Three-Party Approval Lifecycle', () => {
    it('locks report when all three parties (Team A, Team B, Organizer) approve the same version', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draft = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      // 1. Team A (the winner) approves
      const res1 = await submitReportApproval(db, {
        report_version_id: draft.id,
        approver_type: 'TEAM_A',
        approver_id: delegateAId,
        decision: 'APPROVE',
      });
      expect(res1.status).toBe('PENDING_APPROVAL');
      expect(res1.isLocked).toBe(false);
      expect(res1.missingApprovers).toEqual(['ORGANIZER']);

      // 2. Organizer approves -> Transitions to LOCKED! (Only winning team + organizer required)
      const res3 = await submitReportApproval(db, {
        report_version_id: draft.id,
        approver_type: 'ORGANIZER',
        approver_id: organizerId,
        decision: 'APPROVE',
        is_organizer: true,
      });
      expect(res3.status).toBe('LOCKED');
      expect(res3.isLocked).toBe(true);
      expect(res3.missingApprovers).toHaveLength(0);

      // Verify DB report status
      const updated = await getReportVersion(db, draft.id);
      expect(updated?.status).toBe('LOCKED');

      // Verify game completed in DB
      const gameRes = await db.execute({
        sql: 'SELECT status, winner_team_id, team_a_score, team_b_score FROM games WHERE id = ?',
        args: [gameId],
      });
      expect(gameRes.rows[0][0]).toBe('COMPLETED');
      expect(gameRes.rows[0][1]).toBe(teamAId);
    });

    it('rejects unauthorized approver claiming Team A role', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draft = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      await expect(
        submitReportApproval(db, {
          report_version_id: draft.id,
          approver_type: 'TEAM_A',
          approver_id: 'fake-delegate-id',
          decision: 'APPROVE',
        })
      ).rejects.toThrow('Unauthorized');
    });

    it('transitions report to NEEDS_CORRECTION when a party rejects', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draft = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      const res = await submitReportApproval(db, {
        report_version_id: draft.id,
        approver_type: 'TEAM_B',
        approver_id: delegateBId,
        decision: 'REJECT',
        rejection_reason: 'Goals count is wrong',
      });

      expect(res.status).toBe('NEEDS_CORRECTION');
      expect(res.isLocked).toBe(false);

      const updated = await getReportVersion(db, draft.id);
      expect(updated?.status).toBe('NEEDS_CORRECTION');
    });

    it('supports organizer unilateral override lock and reopen (FR-APR-004)', async () => {
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draft = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      // Organizer unilaterally locks with reason
      const locked = await organizerOverrideLock(db, {
        report_version_id: draft.id,
        organizer_id: organizerId,
        reason: 'Both delegates confirmed offline in voice chat',
      });
      expect(locked.status).toBe('LOCKED');

      // Now Organizer reopens for correction
      const reopened = await organizerReopenReport(db, {
        report_version_id: draft.id,
        organizer_id: organizerId,
        reason: 'Delegate submitted late valid dispute evidence',
      });
      expect(reopened.status).toBe('NEEDS_CORRECTION');
    });
  });

  // ===========================================================================
  // Task 5.5: Admin Manual Mode (!manualreport)
  // ===========================================================================
  describe('Task 5.5: Admin Manual Mode (!manualreport)', () => {
    it('creates manual report with provenance MANUAL_ENTRY and sets AI protection flag (FR-FAIL-003, FR-FAIL-005, WORKFLOWS §11)', async () => {
      const manualRes = await handleManualReport(db, {
        organizer_id: organizerId,
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
        notes: 'Entered manually due to AI provider outage',
        is_organizer: true,
      });

      expect(manualRes.success).toBe(true);
      expect(manualRes.version).toBeDefined();
      expect(manualRes.version?.provenance).toBe('MANUAL_ENTRY');
      expect(manualRes.version?.created_by).toBe(organizerId);

      // Verify AI protection helper
      const isProtected = await isSessionManualProtected(db, manualRes.version!.report_session_id);
      expect(isProtected).toBe(true);
    });

    it('rejects !manualreport when invoked by non-organizer', async () => {
      await expect(
        handleManualReport(db, {
          organizer_id: 'random-player-id',
          fixture_id: fixtureId,
          game_id: gameId,
          team_a_score: 3,
          team_b_score: 1,
          team_a_players: createValidLineupA(),
          team_b_players: createValidLineupB(),
          is_organizer: false,
        })
      ).rejects.toThrow('Unauthorized: !manualreport is restricted to tournament organizers');
    });
  });

  // ===========================================================================
  // Task 5.6: Stats Writer & Award Eligibility
  // ===========================================================================
  describe('Task 5.6: Stats Writer & Award Eligibility', () => {
    it('writes player stats on lock with goalkeeper award eligibility strictly for won game (FR-GK-008)', async () => {
      // Game ended 3-1: Team A WON, Team B LOST
      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: createValidLineupA(),
        team_b_players: createValidLineupB(),
      });

      const draft = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      // Three party approval to trigger lock
      await submitReportApproval(db, {
        report_version_id: draft.id,
        approver_type: 'TEAM_A',
        approver_id: delegateAId,
        decision: 'APPROVE',
      });
      await submitReportApproval(db, {
        report_version_id: draft.id,
        approver_type: 'TEAM_B',
        approver_id: delegateBId,
        decision: 'APPROVE',
      });
      await submitReportApproval(db, {
        report_version_id: draft.id,
        approver_type: 'ORGANIZER',
        approver_id: organizerId,
        decision: 'APPROVE',
        is_organizer: true,
      });

      // Query player_game_stats
      const statsRes = await db.execute({
        sql: `
          SELECT p.nickname_raw, p.position, s.is_award_eligible, s.defense_raw, s.goalkeeper_saves
          FROM player_game_stats s
          JOIN players p ON s.player_id = p.id
          WHERE s.game_id = ?
        `,
        args: [gameId],
      });

      expect(statsRes.rows).toHaveLength(10); // 5 players from Team A + 5 players from Team B

      const statsMap = new Map<string, { pos: string; eligible: number; defRaw: number; saves: number }>();
      for (const r of statsRes.rows) {
        statsMap.set(String(r[0]), {
          pos: String(r[1]),
          eligible: Number(r[2]),
          defRaw: Number(r[3]),
          saves: Number(r[4]),
        });
      }

      // 1. Outfield players on both teams are award eligible (1)
      expect(statsMap.get('AstraStriker')?.eligible).toBe(1);
      expect(statsMap.get('ChronosForward')?.eligible).toBe(1);

      // 2. Winning Goalkeeper (Team A) is award eligible (1) (FR-GK-008)
      const winningGK = statsMap.get('AstraGK');
      expect(winningGK?.pos).toBe('GOALKEEPER');
      expect(winningGK?.eligible).toBe(1);
      expect(winningGK?.saves).toBe(5);
      expect(winningGK?.defRaw).toBe(5);

      // 3. Losing Goalkeeper (Team B) is NOT award eligible (0) per FR-GK-008
      const losingGK = statsMap.get('ChronosGK');
      expect(losingGK?.pos).toBe('GOALKEEPER');
      expect(losingGK?.eligible).toBe(0); // 0 because team lost!
      expect(losingGK?.saves).toBe(4);
      expect(losingGK?.defRaw).toBe(4);
    });

    it('generates NO player statistics for walkover games (FR-CALC-006)', async () => {
      // Set game as walkover
      await db.execute({
        sql: `UPDATE games SET is_walkover = 1, walkover_type = 'SINGLE_FORFEIT' WHERE id = ?`,
        args: [gameId],
      });

      const validation = await validateMatchReport(db, {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_id: teamAId,
        team_b_id: teamBId,
        team_a_score: 3,
        team_b_score: 0,
        team_a_players: createValidLineupA(),
        team_b_players: [
          { nickname_raw: 'ChronosGK', rating: 0, goals: 0, assists: 0, passes: 0, defense_raw: 0 },
          { nickname_raw: 'ChronosForward', rating: 0, goals: 0, assists: 0, passes: 0, defense_raw: 0 },
          { nickname_raw: 'ChronosMid', rating: 0, goals: 0, assists: 0, passes: 0, defense_raw: 0 },
          { nickname_raw: 'ChronosWinger', rating: 0, goals: 0, assists: 0, passes: 0, defense_raw: 0 },
          { nickname_raw: 'ChronosDef', rating: 0, goals: 0, assists: 0, passes: 0, defense_raw: 0 },
        ],
      });

      const draft = await createReportDraft(db, {
        report_session_id: sessionId,
        fixture_id: fixtureId,
        validated_data_json: JSON.stringify(validation.validatedData!),
      });

      // Lock report
      await organizerOverrideLock(db, {
        report_version_id: draft.id,
        organizer_id: organizerId,
        reason: 'Walkover confirmed',
      });

      // Check player_game_stats count
      const statsRes = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM player_game_stats WHERE game_id = ?',
        args: [gameId],
      });
      const cnt = Number(statsRes.rows[0]?.[0] ?? (statsRes.rows[0] as { cnt?: unknown })?.cnt ?? 0);

      // Must be 0! FR-CALC-006: Walkovers generate NO player statistics
      expect(cnt).toBe(0);
    });
  });

  describe('Tiered Player-to-Roster Matcher (Zero False Positives & OCR Resilient)', () => {
    const mockRoster = [
      {
        id: 'p1',
        tournament_id: 't1',
        team_id: 'team-agi',
        nickname_raw: 'AGIㆍL∆RZZ☢️',
        nickname_nfc: 'AGIㆍL∆RZZ☢️',
        nickname_search_key: 'agilrzz',
        position: 'GOALKEEPER' as const,
        roster_slot: 1,
        roster_type: 'STARTER' as const,
        status: 'ACTIVE' as const,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p2',
        tournament_id: 't1',
        team_id: 'team-agi',
        nickname_raw: 'AGIㆍZKII☣',
        nickname_nfc: 'AGIㆍZKII☣',
        nickname_search_key: 'agizkii',
        position: 'OUTFIELD' as const,
        roster_slot: 2,
        roster_type: 'STARTER' as const,
        status: 'ACTIVE' as const,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p3',
        tournament_id: 't1',
        team_id: 'team-agi',
        nickname_raw: 'AGIㆍIshikawa',
        nickname_nfc: 'AGIㆍIshikawa',
        nickname_search_key: 'agiishikawa',
        position: 'OUTFIELD' as const,
        roster_slot: 3,
        roster_type: 'STARTER' as const,
        status: 'ACTIVE' as const,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p4',
        tournament_id: 't1',
        team_id: 'team-agi',
        nickname_raw: 'AGIㆍReXzz',
        nickname_nfc: 'AGIㆍReXzz',
        nickname_search_key: 'agirexzz',
        position: 'OUTFIELD' as const,
        roster_slot: 4,
        roster_type: 'STARTER' as const,
        status: 'ACTIVE' as const,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'p5',
        tournament_id: 't1',
        team_id: 'team-agi',
        nickname_raw: 'AGI • Oppo',
        nickname_nfc: 'AGI • Oppo',
        nickname_search_key: 'agioppo',
        position: 'OUTFIELD' as const,
        roster_slot: 6,
        roster_type: 'SUBSTITUTE' as const,
        status: 'ACTIVE' as const,
        created_at: '',
        updated_at: '',
      },
    ];

    it('matches exact raw and NFC nicknames (Tier 1 & 2)', () => {
      const match1 = matchPlayerToRoster({ nickname_raw: 'AGIㆍL∆RZZ☢️' }, mockRoster);
      expect(match1).not.toBeNull();
      expect(match1?.id).toBe('p1');

      const match2 = matchPlayerToRoster({ nickname_raw: 'AGI • Oppo' }, mockRoster);
      expect(match2).not.toBeNull();
      expect(match2?.id).toBe('p5');
    });

    it('matches stylized OCR variations via Clean Alphanumeric Key (Tier 3)', () => {
      // 1. Separator dot difference: ' • ' vs 'ㆍ'
      const matchIshikawa = matchPlayerToRoster({ nickname_raw: 'AGI • Ishikawa' }, mockRoster);
      expect(matchIshikawa).not.toBeNull();
      expect(matchIshikawa?.id).toBe('p3');

      // 2. Trailing symbol difference & separator difference
      const matchZkii = matchPlayerToRoster({ nickname_raw: 'AGI • ZKII☣' }, mockRoster);
      expect(matchZkii).not.toBeNull();
      expect(matchZkii?.id).toBe('p2');

      // 3. Greek Lambda vs Delta increment & radioactive vs biohazard symbols
      const matchLarzz = matchPlayerToRoster({ nickname_raw: 'AGI • LΛRZZ ☣' }, mockRoster);
      expect(matchLarzz).not.toBeNull();
      expect(matchLarzz?.id).toBe('p1');
    });

    it('matches minor OCR typo via Safe Fuzzy Match (Tier 4)', () => {
      // 'AGI • Ishikawo' (1 typo: o instead of a) -> high similarity, clear gap
      const matchTypo = matchPlayerToRoster({ nickname_raw: 'AGI • Ishikawo' }, mockRoster);
      expect(matchTypo).not.toBeNull();
      expect(matchTypo?.id).toBe('p3');
    });

    it('rejects ambiguous names when safety margin gap is below 15%', () => {
      const closeRoster = [
        {
          id: 'tz1',
          tournament_id: 't1',
          team_id: 'team-tz',
          nickname_raw: 'TZ・Ҡurøko✦',
          nickname_nfc: 'TZ・Ҡurøko✦',
          nickname_search_key: 'tzurko',
          position: 'OUTFIELD' as const,
          roster_slot: 1,
          roster_type: 'STARTER' as const,
          status: 'ACTIVE' as const,
          created_at: '',
          updated_at: '',
        },
        {
          id: 'tz2',
          tournament_id: 't1',
          team_id: 'team-tz',
          nickname_raw: 'TZ・Ҡurøna✦',
          nickname_nfc: 'TZ・Ҡurøna✦',
          nickname_search_key: 'tzurna',
          position: 'OUTFIELD' as const,
          roster_slot: 2,
          roster_type: 'STARTER' as const,
          status: 'ACTIVE' as const,
          created_at: '',
          updated_at: '',
        },
      ];

      // 'TZ・Ҡurøka✦' is equidistant to both Kuroko (ko vs ka) and Kurona (na vs ka) -> gap = 0
      const ambiguousMatch = matchPlayerToRoster({ nickname_raw: 'TZ・Ҡurøka✦' }, closeRoster);
      expect(ambiguousMatch).toBeNull();
    });

    it('strictly rejects unregistered players', () => {
      const matchDikz = matchPlayerToRoster({ nickname_raw: 'AGI • DIKZ' }, mockRoster);
      expect(matchDikz).toBeNull();

      const matchStranger = matchPlayerToRoster({ nickname_raw: 'EVOS JOKO' }, mockRoster);
      expect(matchStranger).toBeNull();
    });
  });
});
