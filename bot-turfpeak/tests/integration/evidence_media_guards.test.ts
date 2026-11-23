/**
 * Flash Peak TMS - Evidence Media Download Guards (audit fix B-2)
 *
 * Regression contract (fails on master, must pass after the fix):
 * - When EVERY media asset fails to re-download from the media service, the
 *   processor must NOT feed placeholder bytes (MOCK_BASE64_DATA) to the AI
 *   classifier. It skips all assets, completes the session as INCOMPLETE, and
 *   replies with an explicit resend request (status NO_MEDIA).
 * - When SOME assets fail, processing continues with the survivors and the
 *   summary surfaces a "skipped" warning; the failed asset is never classified.
 * - A batch with assets but no configured media client behaves like a full
 *   download failure (explicit reply), never like fake data.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { ProviderRouter } from '../../src/ai/router.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../../src/ai/adapter.js';
import type { ImageClassifier } from '../../src/ai/classifier.js';
import type { MatchSummaryExtractor } from '../../src/ai/extractors/match.js';
import { findOrCreateReportSession } from '../../src/ingestion/session.js';
import { claimDebounceBatch } from '../../src/ingestion/debounce.js';
import { processClaimedBatch } from '../../src/application/evidence-batch-processor.js';
import type { FlashPeakMediaClient } from '../../src/media/client.js';
import { createStubMediaClient } from '../helpers/stub_media_client.js';

function createMockAdapter(name: 'GROQ' | 'GEMINI'): ProviderAdapter {
  return {
    name,
    model: `${name.toLowerCase()}-test-model`,
    capabilities: {
      vision: true,
      text: true,
      structured_output: true,
      supported_mime_types: ['image/jpeg', 'image/png'],
    },
    healthCheck: async () => true,
    execute: async (req: AIRequest): Promise<AIResponse<unknown>> => ({
      raw_text: JSON.stringify({ mock: true }),
      parsed_json: { mock: true },
      telemetry: {
        provider: name,
        model: `${name.toLowerCase()}-test-model`,
        task_type: req.task,
        latency_ms: 12,
        input_tokens: 100,
        output_tokens: 50,
        status: 'SUCCESS' as const,
        error_code: null,
      },
    }),
  };
}

/** Match extraction payload aligned with the seeded roster (5v5, 2-1). */
const EXTRACT_PAYLOAD = {
  raw_extraction: {},
  summary_data: {
    team_a_score: 2,
    team_b_score: 1,
    team_a_players: [
      { nickname_raw: 'RAKeeper', rating: 8.5, goals: 0, assists: 0, passes: 10, defense: 2 },
      { nickname_raw: 'RAPlayer2', rating: 7.0, goals: 1, assists: 1, passes: 8, defense: 1 },
      { nickname_raw: 'RAPlayer3', rating: 6.5, goals: 1, assists: 1, passes: 7, defense: 3 },
      { nickname_raw: 'RAPlayer4', rating: 6.0, goals: 0, assists: 0, passes: 6, defense: 2 },
      { nickname_raw: 'RAPlayer5', rating: 5.5, goals: 0, assists: 0, passes: 5, defense: 1 },
    ],
    team_b_players: [
      { nickname_raw: 'RBKeeper', rating: 7.5, goals: 0, assists: 0, passes: 9, defense: 3 },
      { nickname_raw: 'RBPlayer2', rating: 7.0, goals: 1, assists: 0, passes: 8, defense: 2 },
      { nickname_raw: 'RBPlayer3', rating: 6.5, goals: 0, assists: 1, passes: 7, defense: 2 },
      { nickname_raw: 'RBPlayer4', rating: 6.0, goals: 0, assists: 0, passes: 6, defense: 1 },
      { nickname_raw: 'RBPlayer5', rating: 5.0, goals: 0, assists: 0, passes: 5, defense: 2 },
    ],
  },
};

describe('Evidence media download guards (B-2)', () => {
  let db: Client;
  const tournamentId = 'tour-b2-media';
  const teamAId = 'team-b2-a';
  const teamBId = 'team-b2-b';
  const fixtureId = 'fix-b2-001';
  const delegateAJid = '628111111111@s.whatsapp.net';

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'B2 Media Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
            VALUES ('del-b2-a', 'Delegate B2 A', 'ACTIVE', ?, ?)`,
      args: [now, now],
    });
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
            VALUES (?, ?, 'Team B2 A', 'VERIFIED', ?, ?), (?, ?, 'Team B2 B', 'VERIFIED', ?, ?)`,
      args: [teamAId, tournamentId, now, now, teamBId, tournamentId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, scheduled_at, timezone, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, ?, ?, ?, 'Asia/Jakarta', 'IN_PROGRESS', ?, ?)`,
      args: [fixtureId, tournamentId, teamAId, teamBId, teamAId, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
            VALUES ('game-b2-001', ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
      args: [fixtureId, now, now],
    });
    for (let s = 1; s <= 5; s++) {
      const isGk = s === 1;
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `p-b2a-${s}`, tournamentId, teamAId,
          isGk ? 'RAKeeper' : `RAPlayer${s}`,
          isGk ? 'RAKeeper' : `RAPlayer${s}`,
          isGk ? 'rakeeper' : `raplayer${s}`,
          isGk ? 'GOALKEEPER' : 'OUTFIELD', s, now, now,
        ],
      });
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          `p-b2b-${s}`, tournamentId, teamBId,
          isGk ? 'RBKeeper' : `RBPlayer${s}`,
          isGk ? 'RBKeeper' : `RBPlayer${s}`,
          isGk ? 'rbkeeper' : `rbplayer${s}`,
          isGk ? 'GOALKEEPER' : 'OUTFIELD', s, now, now,
        ],
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  /** Creates a session with N evidence photo assets (msg-b2-01, msg-b2-02, ...). */
  async function createSessionWithAssets(assetKeys: string[], submittingTeam?: string): Promise<string> {
    const sessionRes = await findOrCreateReportSession(db, {
      fixture_id: fixtureId,
      submitting_team_id: submittingTeam || teamAId,
    });
    const sessionId = sessionRes.session.id;
    const now = new Date().toISOString();

    for (let i = 0; i < assetKeys.length; i++) {
      const key = assetKeys[i];
      const msgId = randomUUID();
      await db.execute({
        sql: `INSERT INTO inbound_messages (id, provider_message_key, chat_id, sender_raw_address, message_timestamp, received_at, message_type, text_body, caption, report_session_id, raw_metadata_json, created_at)
              VALUES (?, ?, 'g-b2', ?, ?, ?, 'IMAGE', NULL, 'Hasil laga', ?, '{}', ?)`,
        args: [msgId, key, delegateAJid, now, now, sessionId, now],
      });
      await db.execute({
        sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
              VALUES (?, 'FLASHPEAK_VM_MEDIA', ?, 'MAIN_MATCH', 'image/jpeg', 1024, ?, 'PRIVATE', 'STORED', ?, ?)`,
        args: [`media-${key}`, `${key}.jpg`, `hash-${key}`, msgId, now],
      });
    }

    await db.execute({
      sql: 'UPDATE report_sessions SET debounce_due_at = ? WHERE id = ?',
      args: [new Date(Date.now() - 1000).toISOString(), sessionId],
    });
    return sessionId;
  }

  function buildDeps(overrides: {
    mediaClient?: FlashPeakMediaClient;
    classifyMock?: ReturnType<typeof vi.fn>;
    extractMock?: ReturnType<typeof vi.fn>;
  }) {
    const classifyMock =
      overrides.classifyMock ??
      vi.fn(async () => ({
        screen_type: 'MAIN_MATCH_SUMMARY',
        confidence: 0.95,
        reason: 'Scoreboard with final score',
        visual_features: ['scoreboard'],
        uncertainties: [],
      }));
    const extractMock = overrides.extractMock ?? vi.fn(async () => EXTRACT_PAYLOAD);
    return {
      db,
      providerRouter: new ProviderRouter({ adapters: [createMockAdapter('GROQ')] }),
      mediaClient: overrides.mediaClient,
      classifier: { classify: classifyMock } as unknown as ImageClassifier,
      matchExtractor: { extract: extractMock } as unknown as MatchSummaryExtractor,
      _classifyMock: classifyMock,
      _extractMock: extractMock,
    };
  }

  it('all asset re-downloads fail -> NO_MEDIA explicit reply, classifier never called, session INCOMPLETE', async () => {
    const sessionId = await createSessionWithAssets(['msg-b2-01', 'msg-b2-02']);
    const batch = await claimDebounceBatch(db, 'test-worker', 30_000);
    expect(batch).toBeTruthy();
    expect(batch!.mediaAssets.length).toBe(2);

    const classifyMock = vi.fn();
    const deps = buildDeps({
      mediaClient: createStubMediaClient({ failAllDownloads: true }),
      classifyMock,
    });

    const res = await processClaimedBatch(deps, batch!);

    // Explicit participant-facing failure — NOT a mock-data AI run.
    expect(res.status).toBe('NO_MEDIA');
    expect(res.whatsappSummary).toBeTruthy();
    expect(res.whatsappSummary).toContain('gagal diunduh ulang');
    expect(res.whatsappSummary).toContain('kirim ulang');
    expect(res.error).toContain('failed to re-download');

    // Placeholder bytes were never classified: zero AI calls for this batch.
    expect(classifyMock).not.toHaveBeenCalled();

    const sess = await db.execute({
      sql: 'SELECT status FROM report_sessions WHERE id = ?',
      args: [sessionId],
    });
    expect(String(sess.rows[0][0])).toBe('INCOMPLETE');
  });

  it('assets exist but no media client configured -> same explicit NO_MEDIA reply (no placeholder data)', async () => {
    await createSessionWithAssets(['msg-b2-03']);
    const batch = await claimDebounceBatch(db, 'test-worker', 30_000);
    expect(batch).toBeTruthy();

    const classifyMock = vi.fn();
    const deps = buildDeps({ mediaClient: undefined, classifyMock });

    const res = await processClaimedBatch(deps, batch!);

    expect(res.status).toBe('NO_MEDIA');
    expect(res.whatsappSummary).toContain('gagal diunduh ulang');
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('partial download failure -> processes the downloaded asset and warns about the skipped one', async () => {
    await createSessionWithAssets(['msg-good', 'msg-bad']);
    const batch = await claimDebounceBatch(db, 'test-worker', 30_000);
    expect(batch).toBeTruthy();

    // Only the 'msg-good' asset (remote id 'msg-good') can be re-downloaded.
    const classifyMock = vi.fn(async () => ({
      screen_type: 'MAIN_MATCH_SUMMARY',
      confidence: 0.95,
      reason: 'Scoreboard with final score',
      visual_features: ['scoreboard'],
      uncertainties: [],
    }));
    const deps = buildDeps({
      mediaClient: createStubMediaClient({ allowRemoteId: (id) => id === 'msg-good' }),
      classifyMock,
    });

    const res = await processClaimedBatch(deps, batch!);

    expect(res.status).toBe('DRAFT_CREATED');
    expect(res.draftVersion).toBeTruthy();
    // Only the downloadable asset reached the classifier.
    expect(classifyMock).toHaveBeenCalledTimes(1);
    const classifiedPayload = classifyMock.mock.calls[0][0] as { base64: string };
    expect(classifiedPayload.base64).not.toContain('MOCK_BASE64_DATA');
    // The summary surfaces the skipped asset instead of hiding it.
    expect(res.whatsappSummary).toContain('dilewati');
  });

  it('does not invert scores or rosters when Team B submits screenshot where Team A is on the left', async () => {
    // Session submitted by Team B
    await createSessionWithAssets(['msg-teamb-sub'], teamBId);
    const batch = await claimDebounceBatch(db, 'test-worker', 30_000);
    expect(batch).toBeTruthy();

    const deps = buildDeps({
      mediaClient: createStubMediaClient({ allowRemoteId: (id) => id === 'msg-teamb-sub' }),
    });

    const res = await processClaimedBatch(deps, batch!);

    expect(res.status).toBe('DRAFT_CREATED');
    expect(res.draftVersion).toBeTruthy();
    // Verify draft validated data has Team A score = 2 and Team B score = 1
    const draft = await db.execute({
      sql: 'SELECT validated_data_json FROM report_versions WHERE id = ?',
      args: [res.draftVersion!.id],
    });
    const validatedData = JSON.parse(String(draft.rows[0][0]));
    expect(validatedData.team_a_score).toBe(2);
    expect(validatedData.team_b_score).toBe(1);
    expect(validatedData.team_a_players[0].nickname_raw).toBe('RAKeeper');
    expect(validatedData.team_b_players[0].nickname_raw).toBe('RBKeeper');
  });

  it('attaches designated goalkeeper when scoreboard extraction only has 4 outfield players', async () => {
    await createSessionWithAssets(['msg-4players'], teamAId);
    const batch = await claimDebounceBatch(db, 'test-worker', 30_000);
    expect(batch).toBeTruthy();

    const fourPlayerPayload = {
      raw_extraction: {},
      summary_data: {
        team_a_score: 3,
        team_b_score: 1,
        team_a_players: [
          { nickname_raw: 'RAPlayer2', rating: 7.0, goals: 1, assists: 1, passes: 8, defense: 1 },
          { nickname_raw: 'RAPlayer3', rating: 6.5, goals: 1, assists: 1, passes: 7, defense: 3 },
          { nickname_raw: 'RAPlayer4', rating: 6.0, goals: 1, assists: 0, passes: 6, defense: 2 },
          { nickname_raw: 'RAPlayer5', rating: 5.5, goals: 0, assists: 0, passes: 5, defense: 1 },
        ],
        team_b_players: [
          { nickname_raw: 'RBPlayer2', rating: 7.0, goals: 1, assists: 0, passes: 8, defense: 2 },
          { nickname_raw: 'RBPlayer3', rating: 6.5, goals: 0, assists: 1, passes: 7, defense: 2 },
          { nickname_raw: 'RBPlayer4', rating: 6.0, goals: 0, assists: 0, passes: 6, defense: 1 },
          { nickname_raw: 'RBPlayer5', rating: 5.0, goals: 0, assists: 0, passes: 5, defense: 2 },
        ],
      },
    };

    const deps = buildDeps({
      mediaClient: createStubMediaClient({ allowRemoteId: (id) => id === 'msg-4players' }),
      extractMock: vi.fn(async () => fourPlayerPayload),
    });

    const res = await processClaimedBatch(deps, batch!);
    expect(res.status).toBe('DRAFT_CREATED');
    expect(res.draftVersion?.status).toBe('PENDING_APPROVAL');

    const draft = await db.execute({
      sql: 'SELECT validated_data_json FROM report_versions WHERE id = ?',
      args: [res.draftVersion!.id],
    });
    const validatedData = JSON.parse(String(draft.rows[0][0]));
    expect(validatedData.team_a_players.length).toBe(5);
    expect(validatedData.team_b_players.length).toBe(5);
    expect(validatedData.team_a_players.some((p: any) => p.nickname_raw === 'RAKeeper')).toBe(true);
    expect(validatedData.team_b_players.some((p: any) => p.nickname_raw === 'RBKeeper')).toBe(true);
  });
});
