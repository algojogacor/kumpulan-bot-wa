/**
 * FIX2 regression tests for the fresh-session audit findings (20 Nov 2026).
 *
 * Covers the four fixed defects + the dynamic group sizing feature:
 * 1. (Critical, temuan 3.1) !kogame photo pipeline end-to-end through
 *    handleInboundMessage: the WhatsApp reply must NOT be an FK failure, the
 *    game must be recorded, and ko_game_evidence must gain an APPLIED row
 *    whose source_message_id points at a real inbound_messages row.
 * 2. (High, temuan 3.2) implicit fixture resolution with MULTIPLE active
 *    knockout series replies with a chooser list; a bogus explicit fixture id
 *    (e.g. "MOCK") is rejected as "tidak ditemukan", not treated as an id.
 * 3. (Medium, temuan 3.3) ORGANIZER approval authority: only configured
 *    organizer identities pass; "org_..." / "...organizer..." string patterns
 *    no longer authorize.
 * 4. (Medium, temuan 3.4) atomicity: when the journal write fails inside the
 *    transaction, the game result is NOT left behind (rollback verified).
 * 5. Dynamic group sizing: computeGroupSizing(20, {targetGroupSize:5}) ->
 *    4 groups x 5; computeGroupSizing(16, {targetGroupSize:5}) throws
 *    (16 = 5a+4b unsolvable); invalid target rejected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/index.js';
import { ProviderRouter } from '../../src/ai/router.js';
import { computeGroupSizing } from '../../src/competition/draw.js';
import { applyKoGameEvidence } from '../../src/application/ko-evidence-pipeline.js';
import { submitReportApproval } from '../../src/reports/approval.js';
import { createReportDraft } from '../../src/reports/versioning.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../../src/ai/adapter.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

const ORG_JID = '628999000001@s.whatsapp.net';

// Deterministic mock vision adapter — scores come from a FIFO queue.
const pendingSpec: Array<{ a: number; b: number }> = [];
function queueScore(a: number, b: number) {
  pendingSpec.push({ a, b });
}
function mockAdapter(): ProviderAdapter {
  return {
    name: 'MOCK',
    model: 'mock-v1',
    capabilities: { vision: true, text: true, structured_output: true, supported_mime_types: ['image/jpeg'] },
    healthCheck: async () => true,
    execute: async (req: AIRequest): Promise<AIResponse<unknown>> => {
      if (req.task === 'CLASSIFY') {
        const j = { screen_type: 'MAIN_MATCH_SUMMARY', confidence: 0.99, reason: 'mock', visual_features: [], uncertainties: [] };
        return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'CLASSIFY', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
      }
      if (req.task === 'EXTRACT_MATCH') {
        const spec = pendingSpec.shift();
        const j = {
          screen_type: 'MAIN_MATCH_SUMMARY',
          team_a_score: spec?.a ?? null, team_b_score: spec?.b ?? null,
          result_indicator: 'WIN', team_a_players: [], team_b_players: [],
          confidence: 0.99, unreadable_fields: [], uncertainties: [],
        };
        return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'EXTRACT_MATCH', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
      }
      throw new Error('unhandled task ' + req.task);
    },
  } as unknown as ProviderAdapter;
}

function imgMsg(sender: string, chat: string, caption: string, key: string): NormalizedMessage {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), provider_message_key: key,
    chat_id: chat, sender_raw_address: sender, sender_normalized_address: sender,
    address_type: 'JID', is_from_me: false, participant: sender, push_name: 'T',
    message_timestamp: now, received_at: now, message_type: 'IMAGE',
    text_body: null, caption, reply_to_key: null,
    quoted_participant: null, quoted_text: null,
    media_metadata: { mimetype: 'image/jpeg', fileName: 'shot.jpg' } as any,
    raw_message: {} as any,
  };
}

describe('FIX2 audit regression — !kogame photo pipeline (temuan 3.1/3.2/3.4)', () => {
  let db: Client;
  let fixtureA: string;
  let fixtureB: string;

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db); // includes PRAGMA foreign_keys = ON
    pendingSpec.length = 0;

    const now = new Date().toISOString();
    await db.execute({ sql: `INSERT INTO tournaments (id,name,status,timezone,rules_version,config_json,created_at,updated_at) VALUES ('t1','FIX2 Cup','ACTIVE','Asia/Jakarta','1','{}',?,?)`, args: [now, now] });
    for (const [tid, tname] of [['ta', 'Alpha'], ['tb', 'Beta'], ['tc', 'Gamma'], ['td', 'Delta']] as const) {
      await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES (?,'t1',?,'VERIFIED',?,?)`, args: [tid, tname, now, now] });
    }
    // Two ACTIVE KO fixtures with pending series (ambiguous implicit resolution scenario)
    const rows: Array<[string, string, string]> = [
      ['fa', 'ta', 'tb'],
      ['fb', 'tc', 'td'],
    ];
    for (const [fid, a, b] of rows) {
      await db.execute({ sql: `INSERT INTO fixtures (id,tournament_id,stage,group_id,round_code,team_a_id,team_b_id,left_side_team_id,scheduled_at,timezone,host_team_id,host_assignment_reason,status,created_at,updated_at) VALUES (?,'t1','KNOCKOUT',NULL,'SEMI_FINAL',?,?,?,NULL,'Asia/Jakarta',NULL,'DEFAULT_LEFT_SIDE','SCHEDULED',?,?)`, args: [fid, a, b, a, now, now] });
      await db.execute({ sql: `INSERT INTO series (id,fixture_id,format,target_wins,status,winner_team_id,team_a_game_wins,team_b_game_wins,created_at,updated_at) VALUES (?,?, 'BO3',2,'PENDING',NULL,0,0,?,?)`, args: [`s-${fid}`, fid, now, now] });
    }
    fixtureA = 'fa';
    fixtureB = 'fb';
  });

  afterEach(() => {
    db.close();
  });

  it('records the game + evidence row with a FK-valid source_message_id (was: always FK failure)', async () => {
    const app = createApp({
      db,
      providerRouter: new ProviderRouter({ adapters: [mockAdapter()] }),
      organizerJid: ORG_JID,
      centralGroupJid: 'g@g.us',
    });

    queueScore(2, 0);
    const res = await app.handleInboundMessage(
      imgMsg(ORG_JID, 'g@g.us', `!kogame ${fixtureA}`, 'wa-key-fk-fix-1'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1])
    );

    // The reply is the success/next-game message, NOT the FK failure text.
    expect(res.handled).toBe(true);
    expect(String(res.replyText)).toContain('HASIL GAME KNOCKOUT TERCATAT');
    expect(String(res.replyText)).not.toContain('FOREIGN KEY');
    expect(String(res.replyText)).not.toContain('Gagal memproses bukti game knockout');

    // Game recorded for the correct fixture.
    const g = await db.execute({ sql: `SELECT game_number, team_a_score, team_b_score FROM games WHERE fixture_id = ?`, args: [fixtureA] });
    expect(g.rows.length).toBe(1);
    expect(Number((g.rows[0] as any).game_number)).toBe(1);
    expect(Number((g.rows[0] as any).team_a_score)).toBe(2);

    // Evidence journal has an APPLIED row whose source_message_id references
    // a REAL inbound_messages row (the FK-fix core assertion).
    const ev = await db.execute({
      sql: `SELECT e.status, e.source_message_id, m.id AS msg_id
            FROM ko_game_evidence e
            LEFT JOIN inbound_messages m ON e.source_message_id = m.id
            WHERE e.fixture_id = ?`,
      args: [fixtureA],
    });
    expect(ev.rows.length).toBe(1);
    expect(String((ev.rows[0] as any).status)).toBe('APPLIED');
    expect(String((ev.rows[0] as any).msg_id)).toBe(String((ev.rows[0] as any).source_message_id));
    expect((ev.rows[0] as any).msg_id).not.toBeNull();
  });

  it('rejects ambiguous implicit resolution with a chooser list, and rejects bogus explicit fixture id', async () => {
    const app = createApp({
      db,
      providerRouter: new ProviderRouter({ adapters: [mockAdapter()] }),
      organizerJid: ORG_JID,
      centralGroupJid: 'g@g.us',
    });

    // No explicit fixture id + two active series -> chooser list mentioning both.
    queueScore(2, 0);
    const res = await app.handleInboundMessage(
      imgMsg(ORG_JID, 'g@g.us', '!kogame', 'wa-key-ambiguous-1'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2])
    );
    const txt = String(res.replyText);
    expect(txt).toContain('beberapa series knockout aktif');
    expect(txt).toContain(fixtureA);
    expect(txt).toContain(fixtureB);
    // Nothing recorded during the ambiguity rejection.
    const cnt = await db.execute('SELECT COUNT(*) AS c FROM games');
    expect(Number((cnt.rows[0] as any).c)).toBe(0);

    // Bogus explicit id ("MOCK" word) -> rejected as tidak ditemukan.
    const res2 = await app.handleInboundMessage(
      imgMsg(ORG_JID, 'g@g.us', '!kogame MOCK a:2 b:0', 'wa-key-bogus-1'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 3])
    );
    expect(String(res2.replyText)).toContain('tidak ditemukan');
    const cnt2 = await db.execute('SELECT COUNT(*) AS c FROM games');
    expect(Number((cnt2.rows[0] as any).c)).toBe(0);
  });

  it('atomic rollback: journal failure leaves NO recorded game (temuan 3.4)', async () => {
    // Make the journal INSERT fail by passing a bogus FK value directly to the
    // pipeline (source_message_id that does not exist in inbound_messages).
    await expect(
      applyKoGameEvidence(db, {
        fixtureId: fixtureA,
        teamAScore: 2,
        teamBScore: 0,
        submittedByDelegateId: null,
        sourceMessageId: 'not-a-real-inbound-row-id',
      })
    ).rejects.toThrow(/atomik|FOREIGN KEY|constraint/i);

    // All-or-nothing: the failed photo must NOT have left a game/series result behind.
    const g = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM games WHERE fixture_id = ?', args: [fixtureA] });
    expect(Number((g.rows[0] as any).c)).toBe(0);
    const ev = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM ko_game_evidence', args: [] });
    expect(Number((ev.rows[0] as any).c)).toBe(0);
    const ser = await db.execute({ sql: 'SELECT team_a_game_wins FROM series WHERE fixture_id = ?', args: [fixtureA] });
    expect(Number((ser.rows[0] as any).team_a_game_wins)).toBe(0);
  });
});

describe('FIX2 audit regression — ORGANIZER approval authority (temuan 3.3)', () => {
  let db: Client;
  let versionId: string;

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);
    const now = new Date().toISOString();
    await db.execute({ sql: `INSERT INTO tournaments (id,name,status,timezone,rules_version,config_json,created_at,updated_at) VALUES ('t2','APR Cup','ACTIVE','Asia/Jakarta','1','{}',?,?)`, args: [now, now] });
    await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('x1','t2','Xi','VERIFIED',?,?)`, args: [now, now] });
    await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('x2','t2','Psi','VERIFIED',?,?)`, args: [now, now] });
    await db.execute({ sql: `INSERT INTO fixtures (id,tournament_id,stage,group_id,round_code,team_a_id,team_b_id,left_side_team_id,scheduled_at,timezone,host_team_id,host_assignment_reason,status,created_at,updated_at) VALUES ('f2','t2','GROUP',NULL,NULL,'x1','x2','x1',NULL,'Asia/Jakarta',NULL,'DEFAULT_LEFT_SIDE','SCHEDULED',?,?)`, args: [now, now] });
    await db.execute({ sql: `INSERT INTO report_sessions (id,fixture_id,submitting_team_id,status,last_message_at,debounce_due_at,created_at,updated_at) VALUES ('rs2','f2','x1','COLLECTING',?,?,?,?)`, args: [now, now, now, now] });
    const ver = await createReportDraft(db, {
      report_session_id: 'rs2',
      fixture_id: 'f2',
      validated_data_json: JSON.stringify({ score_a: 1, score_b: 0 }),
    });
    versionId = ver.id;
  });

  afterEach(() => {
    db.close();
  });

  it('rejects string-pattern organizer ids that are not configured (old behavior authorized them)', async () => {
    // "org_" prefix / "organizer" substring must NOT pass anymore.
    await expect(
      submitReportApproval(db, {
        report_version_id: versionId,
        approver_type: 'ORGANIZER',
        approver_id: 'org_rogue-attacker',
        decision: 'APPROVE',
        is_organizer: true,
        allowed_organizer_ids: [ORG_JID],
      })
    ).rejects.toThrow(/not recognized as an authorized tournament organizer/);

    await expect(
      submitReportApproval(db, {
        report_version_id: versionId,
        approver_type: 'ORGANIZER',
        approver_id: 'i-am-organizer-trust-me',
        decision: 'APPROVE',
        is_organizer: true,
        allowed_organizer_ids: [ORG_JID],
      })
    ).rejects.toThrow(/not recognized as an authorized tournament organizer/);
  });

  it('accepts the configured organizer identity', async () => {
    const out = await submitReportApproval(db, {
      report_version_id: versionId,
      approver_type: 'ORGANIZER',
      approver_id: ORG_JID,
      decision: 'APPROVE',
      is_organizer: true,
      allowed_organizer_ids: [ORG_JID],
    });
    expect(out.status).toBe('PENDING_APPROVAL'); // not locked yet: missing team voices
  });
});

describe('FIX2-COMP-DYN — dynamic group sizing', () => {
  it('target 5: 20 teams -> 4 groups of 5; 16 teams falls back to 4x4 (5a+4b search); 11 throws', () => {
    const s20 = computeGroupSizing(20, { targetGroupSize: 5 });
    expect(s20.group_sizes).toEqual([5, 5, 5, 5]);
    expect(s20.num_groups).toBe(4);

    // 16 teams: no 5a+4b solution with a>0, but 0*5 + 4*4 = 16 IS valid —
    // the search falls back to all-4 groups (same as the default path).
    const s16 = computeGroupSizing(16, { targetGroupSize: 5 });
    expect(s16.group_sizes).toEqual([4, 4, 4, 4]);

    // 11 teams: 5a+4b has NO solution at all (a=2..0 leaves 1,6,11) -> explicit error.
    expect(() => computeGroupSizing(11, { targetGroupSize: 5 })).toThrow(
      /tidak dapat dibagi menjadi kombinasi grup 5 dan 4/
    );
  });

  it('default (no options) preserves FR-COMP-010 behaviour exactly', () => {
    expect(computeGroupSizing(23).group_sizes).toEqual([5, 5, 5, 4, 4]);
    expect(computeGroupSizing(9).group_sizes).toEqual([5, 4]);
    expect(() => computeGroupSizing(11)).toThrow(/tidak dapat dibagi/);
    expect(() => computeGroupSizing(7)).toThrow(/minimal 8 tim/);
  });

  it('rejects invalid target sizes with a clear error', () => {
    expect(() => computeGroupSizing(20, { targetGroupSize: 6 } as any)).toThrow(/hanya 4 atau 5/);
    expect(() => computeGroupSizing(20, { targetGroupSize: 3 } as any)).toThrow(/hanya 4 atau 5/);
  });
});
