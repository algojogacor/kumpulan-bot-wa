/**
 * Flash Peak TMS - Full End-to-End Tournament Integration Test (Task 6.6)
 * 
 * Verifies the complete tournament lifecycle across all subsystems:
 * 1. Tournament Creation & Team/Player Pre-registration (8 teams for 2 groups of 4)
 * 2. Guided Sequential Onboarding & WhatsApp Delegate Binding
 * 3. Cryptographic Draw Service, Progressive Reveal & Fixtures Generation
 * 4. Match Evidence Ingestion & 5-Second Sliding Debounce Batching
 * 5. AI Vision Pipeline: Extraction, Backend Validation & Draft v1
 * 6. Natural Language Correction -> Immutable Version v2 & Approval Reset
 * 7. Three-Party Consensus Approval (Team A + Team B + Organizer) -> LOCKED
 * 8. Authoritative Post-Lock Side Effects:
 *    - Player stats writeback (defense_raw vs saves, GK won-game award eligibility)
 *    - Group standings recalculation
 *    - Tournament awards calculation (Golden Boot, Top Assist, Best Defender, Best Winning Goalkeeper)
 * 9. AI Failure Outage Fallback -> Standardized Notification -> Admin !manualreport -> Lock
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/index.js';
import { createStubMediaClient } from '../helpers/stub_media_client.js';
import { OnboardingService } from '../../src/identity/onboarding.js';
import { IdentityResolver } from '../../src/identity/resolver.js';
import { prepareDraw, revealNext } from '../../src/competition/draw.js';
import { generateBalancedRoundRobin } from '../../src/competition/fixtures.js';
import { recalculateAndPersistGroupStandings } from '../../src/competition/standings.js';
import { aggregatePlayerStats } from '../../src/stats/aggregator.js';
import { calculateTournamentAwards } from '../../src/stats/awards.js';
import { formatStandingsTable, formatAwardsAnnouncement } from '../../src/whatsapp/formatters.js';
import { ProviderRouter } from '../../src/ai/router.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../../src/ai/adapter.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

function createMockAdapter(
  name: 'GROQ' | 'GEMINI' | 'OLLAMA_CLOUD',
  handler: (req: AIRequest) => Promise<AIResponse<unknown>>
): ProviderAdapter {
  return {
    name,
    model: `${name.toLowerCase()}-v1`,
    capabilities: {
      vision: true,
      text: true,
      structured_output: true,
      supported_mime_types: ['image/jpeg', 'image/png'],
    },
    healthCheck: vi.fn(async () => true),
    execute: vi.fn(handler),
  };
}

describe('End-to-End Tournament Integration (Fase 6)', () => {
  let db: Client;

  // Tournament context IDs
  const tournamentId = 'tourn-e2e-2026';
  const organizerId = 'org-admin-01';

  const teamAId = 'team-astra-01';
  const teamBId = 'team-blaze-02';

  const delegateAJid = '628111111111@s.whatsapp.net';
  const delegateBJid = '628222222222@s.whatsapp.net';

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
  });

  afterEach(async () => {
    db.close();
  });

  it('executes full tournament lifecycle: onboarding -> draw -> match evidence -> AI draft -> correction -> 3-party approval -> stats & awards', async () => {
    const now = new Date().toISOString();

    // =========================================================================
    // Step 1: Create Tournament & Pre-register Teams and Rosters
    // =========================================================================
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'Flash Peak National Tour 2026', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });

    // Insert 8 teams to fulfill the minimum 8-team requirement for group draw (FR-COMP-010)
    const teamsData = [
      { id: teamAId, name: 'Astra Lumina', code: 'AST' },
      { id: teamBId, name: 'Blaze Titans', code: 'BLZ' },
      { id: 'team-cosmo-03', name: 'Cosmo Rangers', code: 'CSM' },
      { id: 'team-dynasty-04', name: 'Dynasty Elite', code: 'DYN' },
      { id: 'team-eclipse-05', name: 'Eclipse Vanguards', code: 'ECL' },
      { id: 'team-frost-06', name: 'Frost Nova', code: 'FRS' },
      { id: 'team-gravity-07', name: 'Gravity Pulse', code: 'GRV' },
      { id: 'team-horizon-08', name: 'Horizon Apex', code: 'HRZ' },
    ];

    for (const t of teamsData) {
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, team_code, registration_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        args: [t.id, tournamentId, t.name, t.code, now, now],
      });
    }

    // Insert 5 players per team (1 GK + 4 Outfield)
    const seedRoster = async (teamId: string, prefix: string) => {
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'GOALKEEPER', 1, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `gk-${teamId}`, tournamentId, teamId, `${prefix}Keeper`, `${prefix}Keeper`, `${prefix.toLowerCase()}keeper`, now, now,
        ],
      });
      for (let s = 2; s <= 5; s++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'OUTFIELD', ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `out-${teamId}-${s}`, tournamentId, teamId, `${prefix}Player${s}`, `${prefix}Player${s}`, `${prefix.toLowerCase()}player${s}`, s, now, now,
          ],
        });
      }
    };

    for (const t of teamsData) {
      await seedRoster(t.id, t.code);
    }

    // =========================================================================
    // Step 2: Guided Sequential Onboarding (Delegate Verification)
    // =========================================================================
    const identityResolver = new IdentityResolver(db);
    const onboardingService = new OnboardingService(identityResolver, db);

    // Prompt next team (Team A)
    const prompt1 = await onboardingService.getNextOnboardingPrompt(tournamentId);
    expect(prompt1.status).toBe('PROMPT_READY');
    expect(prompt1.team?.id).toBe(teamAId);

    const promptMsgKeyA = 'msg-prompt-team-a';
    onboardingService.setActivePrompt(tournamentId, teamAId, promptMsgKeyA);

    // Delegate A replies to prompt
    const replyMsgA: NormalizedMessage = {
      id: randomUUID(),
      provider_message_key: 'msg-reply-team-a',
      chat_id: 'central-group-jid@g.us',
      sender_raw_address: delegateAJid,
      sender_normalized_address: delegateAJid,
      address_type: 'JID',
      is_from_me: false,
      participant: delegateAJid,
      push_name: 'Delegate Astra',
      message_timestamp: now,
      received_at: now,
      message_type: 'TEXT',
      text_body: 'Saya delegate resmi Astra Lumina',
      caption: null,
      reply_to_key: promptMsgKeyA,
      quoted_participant: 'bot@s.whatsapp.net',
      quoted_text: prompt1.promptText || null,
      raw_message: {} as any,
    };

    const onboardResA = await onboardingService.handleOnboardingReply(tournamentId, replyMsgA);
    expect(onboardResA.status).toBe('SUCCESS');
    expect(onboardResA.verifiedTeam?.id).toBe(teamAId);

    // Verify Team A delegate is stored in DB
    const teamARow = await db.execute({
      sql: 'SELECT delegate_id, registration_status FROM teams WHERE id = ?',
      args: [teamAId],
    });
    expect(teamARow.rows[0][1]).toBe('VERIFIED');
    const delegateAId = String(teamARow.rows[0][0]);
    expect(delegateAId).toBeDefined();

    // Verify Team B
    const prompt2 = await onboardingService.getNextOnboardingPrompt(tournamentId);
    expect(prompt2.team?.id).toBe(teamBId);
    const promptMsgKeyB = 'msg-prompt-team-b';
    onboardingService.setActivePrompt(tournamentId, teamBId, promptMsgKeyB);

    const replyMsgB: NormalizedMessage = {
      id: randomUUID(),
      provider_message_key: 'msg-reply-team-b',
      chat_id: 'central-group-jid@g.us',
      sender_raw_address: delegateBJid,
      sender_normalized_address: delegateBJid,
      address_type: 'JID',
      is_from_me: false,
      participant: delegateBJid,
      push_name: 'Delegate Blaze',
      message_timestamp: now,
      received_at: now,
      message_type: 'TEXT',
      text_body: 'Saya delegate resmi Blaze Titans',
      caption: null,
      reply_to_key: promptMsgKeyB,
      quoted_participant: 'bot@s.whatsapp.net',
      quoted_text: prompt2.promptText || null,
      raw_message: {} as any,
    };

    const onboardResB = await onboardingService.handleOnboardingReply(tournamentId, replyMsgB);
    expect(onboardResB.status).toBe('SUCCESS');
    const teamBRow = await db.execute({
      sql: 'SELECT delegate_id, registration_status FROM teams WHERE id = ?',
      args: [teamBId],
    });
    const delegateBId = String(teamBRow.rows[0][0]);

    // Verify remaining teams so all 8 are verified for draw
    for (let i = 2; i < teamsData.length; i++) {
      const t = teamsData[i];
      await db.execute({
        sql: `UPDATE teams SET registration_status = 'VERIFIED' WHERE id = ?`,
        args: [t.id],
      });
    }

    // =========================================================================
    // Step 3: Draw Service & Fixtures Generation
    // =========================================================================
    const draw = await prepareDraw(db, tournamentId);
    expect(draw.status).toBe('PREPARED');
    expect(draw.commitment_hash).toBeDefined();

    // Progressive reveal all teams
    let revealStep = await revealNext(db, draw.id);
    while (!revealStep.is_complete) {
      revealStep = await revealNext(db, draw.id);
    }
    expect(revealStep.status).toBe('COMPLETED');
    expect(revealStep.revealed_count).toBe(8);

    // Query group created by prepareDraw
    const groupRes = await db.execute({
      sql: `SELECT id FROM groups WHERE draw_id = ? AND group_code = 'A'`,
      args: [draw.id],
    });
    const groupId = String(groupRes.rows[0][0]);

    const groupTeams = teamsData.slice(0, 4);
    for (let i = 0; i < groupTeams.length; i++) {
      const t = groupTeams[i];
      await db.execute({
        sql: `INSERT OR REPLACE INTO group_members (group_id, team_id, draw_position)
              VALUES (?, ?, ?)`,
        args: [groupId, t.id, i + 1],
      });
    }

    // Generate balanced fixtures for Group A
    const pairings = generateBalancedRoundRobin(groupTeams.map((t) => ({ team_id: t.id, team_name: t.name })));
    expect(pairings.length).toBe(6);

    // Select Fixture 1: Team A vs Team B
    const fixture1Id = 'fixture-e2e-01';
    const game1Id = 'game-e2e-01';

    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, scheduled_at, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, 'ROUND_1', ?, ?, ?, ?, 'IN_PROGRESS', ?, ?)`,
      args: [fixture1Id, tournamentId, groupId, teamAId, teamBId, teamAId, now, now, now],
    });

    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
            VALUES (?, ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
      args: [game1Id, fixture1Id, now, now],
    });

    // =========================================================================
    // Step 4: AI Provider Setup & Ingestion Pipeline
    // =========================================================================
    const mockVisionHandler = async (req: AIRequest): Promise<AIResponse<unknown>> => {
      if (req.task === 'CLASSIFY') {
        return {
          raw_text: JSON.stringify({
            screen_type: 'MAIN_MATCH_SUMMARY',
            confidence: 0.98,
            reason: 'Full match result scoreboard with player rows',
            visual_features: ['SCOREBOARD', 'TEAM_A_ROWS', 'TEAM_B_ROWS'],
            uncertainties: [],
          }),
          parsed_json: {
            screen_type: 'MAIN_MATCH_SUMMARY',
            confidence: 0.98,
            reason: 'Full match result scoreboard with player rows',
            visual_features: ['SCOREBOARD', 'TEAM_A_ROWS', 'TEAM_B_ROWS'],
            uncertainties: [],
          },
          telemetry: {
            provider: 'GEMINI',
            model: 'gemini-1.5-flash',
            task_type: 'CLASSIFY',
            latency_ms: 45,
            input_tokens: 120,
            output_tokens: 50,
            status: 'SUCCESS',
            error_code: null,
          },
        };
      }

      if (req.task === 'EXTRACT_MATCH') {
        const payload = {
          screen_type: 'MAIN_MATCH_SUMMARY',
          team_a_score: 3,
          team_b_score: 1,
          result_indicator: 'WIN',
          team_a_players: [
            { nickname_raw: 'ASTKeeper', rating: 8.5, goals: 0, assists: 0, passes: 8, defense: 5 },
            { nickname_raw: 'ASTPlayer2', rating: 9.1, goals: 2, assists: 1, passes: 14, defense: 2 },
            { nickname_raw: 'ASTPlayer3', rating: 8.0, goals: 1, assists: 0, passes: 10, defense: 4 },
            { nickname_raw: 'ASTPlayer4', rating: 7.5, goals: 0, assists: 1, passes: 12, defense: 3 },
            { nickname_raw: 'ASTPlayer5', rating: 7.2, goals: 0, assists: 0, passes: 9, defense: 1 },
          ],
          team_b_players: [
            { nickname_raw: 'BLZKeeper', rating: 6.8, goals: 0, assists: 0, passes: 6, defense: 4 },
            { nickname_raw: 'BLZPlayer2', rating: 8.2, goals: 1, assists: 0, passes: 11, defense: 2 },
            { nickname_raw: 'BLZPlayer3', rating: 7.0, goals: 0, assists: 1, passes: 8, defense: 6 },
            { nickname_raw: 'BLZPlayer4', rating: 6.5, goals: 0, assists: 0, passes: 9, defense: 2 },
            { nickname_raw: 'BLZPlayer5', rating: 6.2, goals: 0, assists: 0, passes: 7, defense: 1 },
          ],
          confidence: 0.95,
          unreadable_fields: [],
          uncertainties: [],
        };

        return {
          raw_text: JSON.stringify(payload),
          parsed_json: payload,
          telemetry: {
            provider: 'GEMINI',
            model: 'gemini-1.5-flash',
            task_type: 'EXTRACT_MATCH',
            latency_ms: 120,
            input_tokens: 300,
            output_tokens: 220,
            status: 'SUCCESS',
            error_code: null,
          },
        };
      }

      if (req.task === 'PARSE_CORRECTION') {
        return {
          raw_text: JSON.stringify({
            target_report_version_id: 'target-v1',
            team_side: 'TEAM_A',
            player_ordinal: 2,
            player_nickname: 'ASTPlayer2',
            metric: 'goals',
            stated_old_value: 2,
            new_value: 3,
            reason: 'Koreksi pencetak gol ketiga',
            ambiguity_flags: [],
          }),
          parsed_json: {
            target_report_version_id: 'target-v1',
            team_side: 'TEAM_A',
            player_ordinal: 2,
            player_nickname: 'ASTPlayer2',
            metric: 'goals',
            stated_old_value: 2,
            new_value: 3,
            reason: 'Koreksi pencetak gol ketiga',
            ambiguity_flags: [],
          },
          telemetry: {
            provider: 'GEMINI',
            model: 'gemini-1.5-flash',
            task_type: 'PARSE_CORRECTION',
            latency_ms: 30,
            input_tokens: 150,
            output_tokens: 80,
            status: 'SUCCESS',
            error_code: null,
          },
        };
      }

      throw new Error(`Unhandled task in mock: ${req.task}`);
    };

    const mockAdapter = createMockAdapter('GEMINI', mockVisionHandler);
    const providerRouter = new ProviderRouter({ adapters: [mockAdapter] });

    const app = createApp({
      db,
      mediaClient: createStubMediaClient(),
      providerRouter,
      quietWindowMs: 50,
    });

    // Ingest match evidence screenshot message
    const evidenceMsg: NormalizedMessage = {
      id: randomUUID(),
      provider_message_key: 'msg-match-screenshot-01',
      chat_id: 'central-group-jid@g.us',
      sender_raw_address: delegateAJid,
      sender_normalized_address: delegateAJid,
      address_type: 'JID',
      is_from_me: false,
      participant: delegateAJid,
      push_name: 'Delegate Astra',
      message_timestamp: now,
      received_at: now,
      message_type: 'IMAGE',
      text_body: null,
      caption: 'Laporan match 1 Astra vs Blaze',
      reply_to_key: null,
      raw_message: {} as any,
    };

    const handleEvidenceRes = await app.handleInboundMessage(evidenceMsg);
    expect(handleEvidenceRes.handled).toBe(true);
    expect(handleEvidenceRes.type).toBe('EVIDENCE');
    expect(handleEvidenceRes.session).toBeDefined();

    const inMsgRes = await db.execute({
      sql: 'SELECT id FROM inbound_messages WHERE provider_message_key = ?',
      args: [evidenceMsg.provider_message_key],
    });
    const capturedMsgId = String(inMsgRes.rows[0][0]);

    // Attach mock media asset to session
    const mediaAssetId = 'media-screenshot-01';
    await db.execute({
      sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
            VALUES (?, 'FLASHPEAK_VM_MEDIA', 'fixtures/fix1.jpg', 'MAIN_MATCH', 'image/jpeg', 10240, 'sha256-mock', 'PRIVATE', 'STORED', ?, ?)`,
      args: [mediaAssetId, capturedMsgId, now],
    });

    // Wait for sliding debounce window to elapse
    await new Promise((r) => setTimeout(r, 60));

    // Process due debounce batches
    const batchResults = await app.processDueDebounceBatches();
    expect(batchResults.length).toBe(1);
    expect(batchResults[0].status).toBe('DRAFT_CREATED');
    expect(batchResults[0].draftVersion).toBeDefined();
    expect(batchResults[0].whatsappSummary).toContain('[PENDING APPROVAL]');

    const version1 = batchResults[0].draftVersion!;
    expect(version1.version_number).toBe(1);
    expect(version1.status).toBe('PENDING_APPROVAL');

    // =========================================================================
    // Step 6: Natural Language Correction -> New Immutable Version v2
    // =========================================================================
    const correctionMsg: NormalizedMessage = {
      id: randomUUID(),
      provider_message_key: 'msg-correction-01',
      chat_id: 'central-group-jid@g.us',
      sender_raw_address: delegateAJid,
      sender_normalized_address: delegateAJid,
      address_type: 'JID',
      is_from_me: false,
      participant: delegateAJid,
      push_name: 'Delegate Astra',
      message_timestamp: now,
      received_at: now,
      message_type: 'TEXT',
      text_body: 'koreksi player urutan 2 tim A salah di gol, seharusnya 3 bukan 2',
      caption: null,
      reply_to_key: evidenceMsg.provider_message_key,
      raw_message: {} as any,
    };

    const correctionOutcome = await app.handleCorrection(version1.id, correctionMsg);
    expect(correctionOutcome.result.success).toBe(true);
    expect(correctionOutcome.result.newVersion).toBeDefined();

    const version2 = correctionOutcome.result.newVersion!;
    expect(version2.version_number).toBe(2);
    expect(version2.status).toBe('PENDING_APPROVAL');

    // =========================================================================
    // Step 7: Winner + Organizer Approval -> Transition to LOCKED (FR-APR-001)
    // =========================================================================
    const appA = await app.submitApproval(version2.id, 'TEAM_A', delegateAId, 'APPROVE');
    expect(appA.isLocked).toBe(false);
    expect(appA.missingApprovers).toContain('ORGANIZER');

    const appOrg = await app.submitApproval(version2.id, 'ORGANIZER', organizerId, 'APPROVE', true);
    expect(appOrg.isLocked).toBe(true);
    expect(appOrg.status).toBe('LOCKED');

    // Verify database updates
    const lockedVerRes = await db.execute({
      sql: 'SELECT status FROM report_versions WHERE id = ?',
      args: [version2.id],
    });
    expect(lockedVerRes.rows[0][0]).toBe('LOCKED');

    const gameRow = await db.execute({
      sql: 'SELECT status, winner_team_id, team_a_score, team_b_score FROM games WHERE id = ?',
      args: [game1Id],
    });
    expect(gameRow.rows[0][0]).toBe('COMPLETED');
    expect(gameRow.rows[0][1]).toBe(teamAId);

    // =========================================================================
    // Step 8: Post-Lock Verification (Player Stats, Standings & Awards)
    // =========================================================================
    const statsRows = await db.execute({
      sql: 'SELECT player_id, team_id, goals, assists, passes, defense_raw, goalkeeper_saves, is_award_eligible FROM player_game_stats WHERE game_id = ?',
      args: [game1Id],
    });
    expect(statsRows.rows.length).toBe(10);

    // GK award eligibility: Team A won, ASTKeeper is_award_eligible = 1
    const astraGkStat = statsRows.rows.find((r) => String(r[0]) === `gk-${teamAId}`);
    expect(astraGkStat).toBeDefined();
    expect(Number(astraGkStat![7])).toBe(1);

    // Team B lost, BLZKeeper is_award_eligible = 0 (FR-GK-008)
    const blazeGkStat = statsRows.rows.find((r) => String(r[0]) === `gk-${teamBId}`);
    expect(blazeGkStat).toBeDefined();
    expect(Number(blazeGkStat![7])).toBe(0);

    // Standings Updated
    const standingsA = await recalculateAndPersistGroupStandings(db, tournamentId, groupId);
    expect(standingsA.length).toBe(4);
    const topTeam = standingsA[0];
    expect(topTeam.team_id).toBe(teamAId);
    expect(topTeam.points).toBe(3);
    expect(topTeam.played).toBe(1);

    const standingsTableText = formatStandingsTable('A', standingsA);
    expect(standingsTableText).toContain('Astra Lumina');
    expect(standingsTableText).toContain('Blaze Titans');

    // Cumulative Player Statistics & Awards
    const playerAgg = await aggregatePlayerStats(db, tournamentId);
    expect(playerAgg.length).toBe(10);

    const awards = await calculateTournamentAwards(db, tournamentId);
    expect(awards.goldenBoot.winners.length).toBe(1);
    expect(awards.goldenBoot.winners[0].nicknameRaw).toBe('ASTPlayer2');
    expect(awards.goldenBoot.winners[0].metricValue).toBe(3);

    expect(awards.bestDefender.winners.length).toBe(1);
    expect(awards.bestDefender.winners[0].nicknameRaw).toBe('BLZPlayer3');
    expect(awards.bestDefender.winners[0].metricValue).toBe(6);

    expect(awards.bestWinningGoalkeeper.winners.length).toBe(1);
    expect(awards.bestWinningGoalkeeper.winners[0].nicknameRaw).toBe('ASTKeeper');
    expect(awards.bestWinningGoalkeeper.winners[0].metricValue).toBe(5);

    const awardsText = formatAwardsAnnouncement('Flash Peak National Tour 2026', awards);
    expect(awardsText).toContain('GOLDEN BOOT');
    expect(awardsText).toContain('ASTPlayer2');
    expect(awardsText).toContain('BEST WINNING GOALKEEPER');
    expect(awardsText).toContain('ASTKeeper');
  });

  it('handles AI provider outage with failure notice and organizer !manualreport fallback (FR-FAIL-001 - FR-FAIL-005)', async () => {
    const now = new Date().toISOString();

    // 1. Setup tournament & fixture
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'Flash Peak Fallback Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });

    const delAId = 'del-cw-01';
    const delBId = 'del-sf-02';
    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
            VALUES (?, 'Delegate CW', 'ACTIVE', ?, ?),
                   (?, 'Delegate SF', 'ACTIVE', ?, ?)`,
      args: [delAId, now, now, delBId, now, now],
    });

    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, team_code, delegate_id, registration_status, created_at, updated_at)
            VALUES (?, ?, 'Cyber Wolf', 'CW', ?, 'VERIFIED', ?, ?),
                   (?, ?, 'Solar Flare', 'SF', ?, 'VERIFIED', ?, ?)`,
      args: [teamAId, tournamentId, delAId, now, now, teamBId, tournamentId, delBId, now, now],
    });

    const fixtureId = 'fix-fail-001';
    const gameId = 'game-fail-001';
    // AUDIT-VERIFY-T4: this test exercises the BO1 group-stage evidence
    // pipeline, so the fixture must be a GROUP fixture (a plain photo for a
    // KNOCKOUT series no longer resolves to the BO1 resolver after the fix).
    const drawIdFail = 'draw-fail-001';
    await db.execute({
      sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at)
            VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fisher-yates', '1', ?)`,
      args: [drawIdFail, tournamentId, now],
    });
    const groupFailId = 'group-fail-001';
    await db.execute({
      sql: `INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`,
      args: [groupFailId, drawIdFail],
    });
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, group_id, team_a_id, team_b_id, left_side_team_id, scheduled_at, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?)`,
      args: [fixtureId, tournamentId, groupFailId, teamAId, teamBId, teamAId, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
            VALUES (?, ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
      args: [gameId, fixtureId, now, now],
    });

    // 2. Setup failing AI router (all providers down / throw error)
    const failingAdapter = createMockAdapter('GROQ', async () => {
      throw new Error('503 Service Unavailable: upstream provider down');
    });
    const providerRouter = new ProviderRouter({ adapters: [failingAdapter] });

    const app = createApp({
      db,
      mediaClient: createStubMediaClient(),
      providerRouter,
      quietWindowMs: 50,
    });

    // Ingest evidence message
    const msg: NormalizedMessage = {
      id: randomUUID(),
      provider_message_key: 'msg-fail-01',
      chat_id: 'central-group@g.us',
      sender_raw_address: delegateAJid,
      sender_normalized_address: delegateAJid,
      address_type: 'JID',
      is_from_me: false,
      participant: delegateAJid,
      push_name: 'Delegate A',
      message_timestamp: now,
      received_at: now,
      message_type: 'IMAGE',
      text_body: null,
      caption: 'Hasil laga',
      reply_to_key: null,
      raw_message: {} as any,
    };

    await app.handleInboundMessage(msg);

    const inMsgFailRes = await db.execute({
      sql: 'SELECT id FROM inbound_messages WHERE provider_message_key = ?',
      args: [msg.provider_message_key],
    });
    const capturedFailMsgId = String(inMsgFailRes.rows[0][0]);

    await db.execute({
      sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
            VALUES (?, 'FLASHPEAK_VM_MEDIA', 'fail.jpg', 'MAIN_MATCH', 'image/jpeg', 1024, 'hash', 'PRIVATE', 'STORED', ?, ?)`,
      args: ['media-fail-01', capturedFailMsgId, now],
    });

    await new Promise((r) => setTimeout(r, 60));

    // Debounce processing runs -> all providers failed -> automatic retry scheduled
    const batchResults = await app.processDueDebounceBatches();
    expect(batchResults.length).toBe(1);
    expect(batchResults[0].status).toBe('AI_RETRY_SCHEDULED');

    // Retry-pending message: tells the participant the system will retry automatically
    const retryMsg = batchResults[0].whatsappSummary!;
    expect(retryMsg).toContain('Laporan Kamu Masih Diproses');
    expect(retryMsg).toContain('mencoba ulang secara otomatis');
    expect(retryMsg).toContain('tidak mengirim ulang screenshot');

    // Session is back in COLLECTING with a delayed due date and an incremented retry counter
    const retriedSession = await db.execute({
      sql: `SELECT status, ai_retry_count, debounce_due_at FROM report_sessions WHERE id = ?`,
      args: [batchResults[0].sessionId],
    });
    expect(String(retriedSession.rows[0][0])).toBe('COLLECTING');
    expect(Number(retriedSession.rows[0][1])).toBe(1);

    // Simulate the retry delay elapsing: pull the due date into the past and re-run
    await db.execute({
      sql: `UPDATE report_sessions SET debounce_due_at = ? WHERE id = ?`,
      args: [new Date(Date.now() - 1000).toISOString(), batchResults[0].sessionId],
    });
    const retryResults = await app.processDueDebounceBatches();
    expect(retryResults.length).toBe(1);
    expect(retryResults[0].status).toBe('AI_RETRY_SCHEDULED');
    expect(retryResults[0].isAIRetry).toBe(true);

    // 3. Organizer executes !manualreport
    for (let s = 1; s <= 5; s++) {
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `p-a-${s}`, tournamentId, teamAId, `CWPlayer${s}`, `CWPlayer${s}`, `cwplayer${s}`, s === 1 ? 'GOALKEEPER' : 'OUTFIELD', s, now, now,
        ],
      });
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `p-b-${s}`, tournamentId, teamBId, `SFPlayer${s}`, `SFPlayer${s}`, `sfplayer${s}`, s === 1 ? 'GOALKEEPER' : 'OUTFIELD', s, now, now,
        ],
      });
    }

    const manualInput = {
      organizer_id: organizerId,
      is_organizer: true,
      fixture_id: fixtureId,
      game_id: gameId,
      team_a_score: 2,
      team_b_score: 0,
      team_a_players: [
        { nickname_raw: 'CWPlayer1', goals: 0, assists: 0, passes: 5, defense_raw: 4, goalkeeper_saves: 4 },
        { nickname_raw: 'CWPlayer2', goals: 2, assists: 0, passes: 10, defense_raw: 2 },
        { nickname_raw: 'CWPlayer3', goals: 0, assists: 1, passes: 12, defense_raw: 3 },
        { nickname_raw: 'CWPlayer4', goals: 0, assists: 1, passes: 8, defense_raw: 1 },
        { nickname_raw: 'CWPlayer5', goals: 0, assists: 0, passes: 7, defense_raw: 0 },
      ],
      team_b_players: [
        { nickname_raw: 'SFPlayer1', goals: 0, assists: 0, passes: 4, defense_raw: 2, goalkeeper_saves: 2 },
        { nickname_raw: 'SFPlayer2', goals: 0, assists: 0, passes: 8, defense_raw: 1 },
        { nickname_raw: 'SFPlayer3', goals: 0, assists: 0, passes: 6, defense_raw: 4 },
        { nickname_raw: 'SFPlayer4', goals: 0, assists: 0, passes: 7, defense_raw: 2 },
        { nickname_raw: 'SFPlayer5', goals: 0, assists: 0, passes: 5, defense_raw: 1 },
      ],
    };

    const manualRes = await app.submitManualReport(manualInput);
    expect(manualRes.success).toBe(true);
    expect(manualRes.version?.provenance).toBe('MANUAL_ENTRY'); // FR-FAIL-005

    const manualVersionId = manualRes.version!.id;

    // 4. Three-party approval on the manual report version
    await app.submitApproval(manualVersionId, 'TEAM_A', delAId, 'APPROVE');
    await app.submitApproval(manualVersionId, 'TEAM_B', delBId, 'APPROVE');
    const manualLock = await app.submitApproval(manualVersionId, 'ORGANIZER', organizerId, 'APPROVE', true);

    expect(manualLock.isLocked).toBe(true);
    expect(manualLock.status).toBe('LOCKED');

    // 5. Verify stats were correctly written to player_game_stats
    const manualStats = await aggregatePlayerStats(db, tournamentId);
    expect(manualStats.length).toBe(10);
    const topScorer = manualStats.find((p) => p.nicknameRaw === 'CWPlayer2');
    expect(topScorer?.totalGoals).toBe(2);
  });
});
