import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseWoClaimIntent,
  WoClaimSessionManager,
  resolveFixtureForWoClaim,
  type PendingWoClaim,
} from '../../src/application/wo-claim-session.js';
import { FlashPeakApp } from '../../src/index.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

describe('Natural Language Walkover (WO) Claim', () => {
  describe('parseWoClaimIntent', () => {
    it('identifies general inquiries as NOT a claim', () => {
      const q1 = parseWoClaimIntent('bagaimana cara klaim wo min?');
      expect(q1.isGeneralQuestion).toBe(true);
      expect(q1.isWoClaim).toBe(false);

      const q2 = parseWoClaimIntent('apakah bisa klaim wo');
      expect(q2.isGeneralQuestion).toBe(true);
      expect(q2.isWoClaim).toBe(false);
    });

    it('detects WO claim without reason as hasReason: false', () => {
      const c1 = parseWoClaimIntent('min kami klaim wo');
      expect(c1.isWoClaim).toBe(true);
      expect(c1.hasReason).toBe(false);

      const c2 = parseWoClaimIntent('min klaim wo tim garuda');
      expect(c2.isWoClaim).toBe(true);
      expect(c2.hasReason).toBe(false);

      const c3 = parseWoClaimIntent('min tolong wo-kan elang fc');
      expect(c3.isWoClaim).toBe(true);
      expect(c3.hasReason).toBe(false);
    });

    it('detects WO claim with reason and extracts reason correctly', () => {
      const c1 = parseWoClaimIntent('min kami klaim wo Match 1 karena lawan tidak hadir lebih dari 15 menit');
      expect(c1.isWoClaim).toBe(true);
      expect(c1.hasReason).toBe(true);
      expect(c1.matchMention).toBe(1);
      expect(c1.extractedReason?.toLowerCase()).toContain('tidak hadir lebih dari 15 menit');

      const c2 = parseWoClaimIntent('min ajukan klaim wo lawan Elang FC menolak buat room');
      expect(c2.isWoClaim).toBe(true);
      expect(c2.hasReason).toBe(true);
      expect(c2.extractedReason?.toLowerCase()).toContain('menolak buat room');
    });
  });

  describe('WoClaimSessionManager', () => {
    let sessionManager: WoClaimSessionManager;

    beforeEach(() => {
      sessionManager = new WoClaimSessionManager();
    });

    it('stages and retrieves pending WO claim', () => {
      const claim: PendingWoClaim = {
        id: 'claim-1',
        chatId: 'group-1@g.us',
        fixtureId: 'fix-1',
        tournamentId: 'tour-1',
        tournamentName: 'Gojiha Turnamen',
        stage: 'GROUP',
        teamAName: 'Garuda FC',
        teamBName: 'Elang FC',
        reportingTeamId: 'team-a',
        reportingTeamName: 'Garuda FC',
        forfeitingTeamId: 'team-b',
        forfeitingTeamName: 'Elang FC',
        reason: 'Lawan tidak hadir setelah toleransi 15 menit',
        reportedByAddress: '628111111111@s.whatsapp.net',
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000,
      };

      sessionManager.stagePendingClaim(claim);
      expect(sessionManager.hasPending('group-1@g.us')).toBe(true);

      const retrieved = sessionManager.getPending('group-1@g.us');
      expect(retrieved?.fixtureId).toBe('fix-1');

      const prompt = sessionManager.formatClaimPrompt(claim, '628888888888');
      expect(prompt).toContain('PENGAJUAN KLAIM WALKOVER (WO)');
      expect(prompt).toContain('Garuda FC');
      expect(prompt).toContain('Elang FC');
      expect(prompt).toContain('!ok');

      const rejectRes = sessionManager.rejectPending('group-1@g.us');
      expect(rejectRes.success).toBe(true);
      expect(sessionManager.hasPending('group-1@g.us')).toBe(false);
    });
  });

  describe('Integration with FlashPeakApp', () => {
    let db: any;
    let app: FlashPeakApp;
    const organizerPhone = '628999999999';
    const organizerJid = `${organizerPhone}@s.whatsapp.net`;
    const groupJid = '120363028888888888@g.us';

    beforeEach(async () => {
      db = createClient({ url: ':memory:' });
      const schemaSql = readFileSync(
        resolve(process.cwd(), 'migrations/001_initial.sql'),
        'utf-8'
      );
      for (const statement of schemaSql.split(';')) {
        const trimmed = statement.trim();
        if (trimmed) await db.execute(trimmed);
      }

      app = new FlashPeakApp({
        db,
        centralGroupJid: groupJid,
        organizerJid,
        organizerPhone,
      });

      // Seed tournament, teams, and fixture
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES ('tourn-wo', 'Gojiha Cup', 'ACTIVE', 'Asia/Jakarta', '1.0', '{}', ?, ?)`,
        args: [now, now],
      });
      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES ('del-a', 'Delegate Singa', 'ACTIVE', ?, ?)`,
        args: [now, now],
      });
      await db.execute({
        sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at)
              VALUES ('ident-a', 'del-a', '628123456789@s.whatsapp.net', 'JID', 1, ?)`,
        args: [now],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES ('team-a', 'tourn-wo', 'Singa FC', 'del-a', 'VERIFIED', ?, ?)`,
        args: [now, now],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES ('team-b', 'tourn-wo', 'Harimau FC', 'VERIFIED', ?, ?)`,
        args: [now, now],
      });
      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES ('fix-1', 'tourn-wo', 'GROUP', 'R1', 'team-a', 'team-b', 'team-a', 'SCHEDULED', ?, ?)`,
        args: [now, now],
      });
    });

    it('ignores casual group messages that do not start with ! prefix', async () => {
      const casualMsg: NormalizedMessage = {
        provider_message_key: 'msg-casual',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: 'kita klaim wo ya, musuh ga aktif sesuai jadwal janjian',
        is_from_me: false,
      };

      const outcome = await app.handleInboundMessage(casualMsg);
      expect(outcome.handled).toBe(false);
      expect(outcome.type).toBe('UNKNOWN');
      expect(app.woClaimSession.hasPending(groupJid)).toBe(false);
    });

    it('rejects WO claim without reason and prompts for explanation when prefixed with !', async () => {
      const msg: NormalizedMessage = {
        provider_message_key: 'msg-wo-no-reason',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!min kami mau klaim wo untuk match 1',
        is_from_me: false,
      };

      const outcome = await app.handleInboundMessage(msg);
      expect(outcome.handled).toBe(true);
      expect(outcome.type).toBe('WO_CLAIM');
      expect(outcome.replyText).toContain('Mohon sertakan alasan klaim WO yang jelas');
      expect(app.woClaimSession.hasPending(groupJid)).toBe(false);
    });

    it('stages WO claim when reason is provided with ! prefix and requires organizer !ok', async () => {
      // 1. Participant sends WO claim with reason starting with '!'
      const claimMsg: NormalizedMessage = {
        provider_message_key: 'msg-wo-with-reason',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!kita klaim wo ya, musuh ga aktif sesuai jadwal janjian',
        is_from_me: false,
      };

      const claimOutcome = await app.handleInboundMessage(claimMsg);
      expect(claimOutcome.handled).toBe(true);
      expect(claimOutcome.type).toBe('WO_CLAIM');
      expect(claimOutcome.replyText).toContain('PENGAJUAN KLAIM WALKOVER (WO)');
      expect(claimOutcome.replyText).toContain('Singa FC');
      expect(claimOutcome.replyText).toContain('Harimau FC');
      expect(claimOutcome.replyText).toContain('!ok');
      expect(app.woClaimSession.hasPending(groupJid)).toBe(true);

      // 2. Non-organizer attempts to approve with !ok -> rejected
      const nonOrgMsg: NormalizedMessage = {
        provider_message_key: 'msg-non-org-ok',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!ok',
        is_from_me: false,
      };
      const nonOrgOutcome = await app.handleInboundMessage(nonOrgMsg);
      expect(nonOrgOutcome.replyText).toContain('Organizer');
      expect(app.woClaimSession.hasPending(groupJid)).toBe(true);

      // 3. Organizer approves with !ok -> successfully confirms WO
      const orgMsg: NormalizedMessage = {
        provider_message_key: 'msg-org-ok',
        chat_id: groupJid,
        sender_raw_address: organizerJid,
        sender_normalized_address: organizerJid,
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!ok',
        is_from_me: false,
      };
      const orgOutcome = await app.handleInboundMessage(orgMsg);
      expect(orgOutcome.replyText).toContain('KLAIM WALKOVER (WO) DISAHKAN OLEH PANITIA');
      expect(orgOutcome.replyText).toContain('Singa FC');
      expect(app.woClaimSession.hasPending(groupJid)).toBe(false);

      // Verify database updated
      const fixCheck = await db.execute("SELECT status FROM fixtures WHERE id = 'fix-1'");
      expect(fixCheck.rows[0].status).toBe('WALKOVER');

      const gameCheck = await db.execute("SELECT is_walkover, walkover_type FROM games WHERE fixture_id = 'fix-1'");
      expect(Number(gameCheck.rows[0].is_walkover)).toBe(1);
      expect(gameCheck.rows[0].walkover_type).toBe('SINGLE_FORFEIT');
    });

    it('cancels pending WO claim when organizer sends !batal', async () => {
      // 1. Participant sends claim
      const claimMsg: NormalizedMessage = {
        provider_message_key: 'msg-wo-cancel',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!Min ajukan klaim WO lawan Harimau FC karena terlambat 15 menit',
        is_from_me: false,
      };
      await app.handleInboundMessage(claimMsg);
      expect(app.woClaimSession.hasPending(groupJid)).toBe(true);

      // 2. Organizer cancels with !batal
      const cancelMsg: NormalizedMessage = {
        provider_message_key: 'msg-cancel',
        chat_id: groupJid,
        sender_raw_address: organizerJid,
        sender_normalized_address: organizerJid,
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!batal',
        is_from_me: false,
      };
      const cancelOutcome = await app.handleInboundMessage(cancelMsg);
      expect(cancelOutcome.replyText).toContain('PENGAJUAN KLAIM WALKOVER (WO) DITOLAK');
      expect(app.woClaimSession.hasPending(groupJid)).toBe(false);
    });

    it('routes natural language schedule, rules, and awards queries prefixed with !', async () => {
      // 1. !jadwal hari ini apa -> routes to matchday status
      const msgToday: NormalizedMessage = {
        provider_message_key: 'msg-today-sched',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!jadwal hari ini apa',
        is_from_me: false,
      };
      const outcomeToday = await app.handleInboundMessage(msgToday);
      expect(outcomeToday.handled).toBe(true);
      expect(outcomeToday.replyText).toContain('STATUS MATCHDAY TURNAMEN');
      expect(outcomeToday.replyText).toContain('19:59 WIB');

      // 2. !jadwal Singa FC -> filters schedule by team
      const msgFilterTeam: NormalizedMessage = {
        provider_message_key: 'msg-sched-singa',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!jadwal Singa FC',
        is_from_me: false,
      };
      const outcomeFilter = await app.handleInboundMessage(msgFilterTeam);
      expect(outcomeFilter.handled).toBe(true);
      expect(outcomeFilter.replyText).toContain('Singa FC');

      // 3. !aturan turnamen apa aja -> routes to !rule
      const msgRule: NormalizedMessage = {
        provider_message_key: 'msg-nl-rule',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!aturan turnamen apa aja',
        is_from_me: false,
      };
      const outcomeRule = await app.handleInboundMessage(msgRule);
      expect(outcomeRule.handled).toBe(true);
      expect(outcomeRule.replyText).toContain('REGULASI RESMI TURNAMEN');

      // 4. !siapa topskor sementara -> routes to !awards
      const msgAwards: NormalizedMessage = {
        provider_message_key: 'msg-nl-awards',
        chat_id: groupJid,
        sender_raw_address: '628123456789@s.whatsapp.net',
        sender_normalized_address: '628123456789@s.whatsapp.net',
        message_timestamp: Math.floor(Date.now() / 1000),
        message_type: 'TEXT',
        text_body: '!siapa topskor sementara',
        is_from_me: false,
      };
      const outcomeAwards = await app.handleInboundMessage(msgAwards);
      expect(outcomeAwards.handled).toBe(true);
      expect(outcomeAwards.replyText).toContain('PENGHARGAAN INDIVIDU');
    });
  });
});
