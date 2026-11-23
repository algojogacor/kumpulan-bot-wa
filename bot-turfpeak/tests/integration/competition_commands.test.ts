import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/index.js';
import type { NormalizedMessage } from '../../src/whatsapp/types.js';

describe('Competition Worker Commands Integration (!createtournament & !draw)', () => {
  let db: Client;
  const organizerPhone = '6289999999999';
  const organizerJid = '6289999999999@s.whatsapp.net';
  const regularUserJid = '6281111111111@s.whatsapp.net';
  const centralGroupJid = '120363000000000000@g.us';

  beforeEach(async () => {
    db = createClient({ url: 'file::memory:?cache=shared' });
    await runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTextMessage(
    senderJid: string,
    chatId: string,
    text: string
  ): NormalizedMessage {
    return {
      id: randomUUID(),
      provider_message_key: randomUUID(),
      chat_id: chatId,
      sender_raw_address: senderJid,
      sender_normalized_address: senderJid,
      address_type: 'JID',
      is_from_me: false,
      participant: senderJid,
      push_name: 'Test Sender',
      message_timestamp: new Date().toISOString(),
      received_at: new Date().toISOString(),
      message_type: 'TEXT',
      text_body: text,
      caption: null,
      reply_to_key: null,
      quoted_participant: null,
      quoted_text: null,
      raw_message: {} as any,
    };
  }

  it('rejects !createtournament when invoked by non-organizer', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    const msg = createTextMessage(regularUserJid, centralGroupJid, '!createtournament Summer Cup');
    const res = await app.handleInboundMessage(msg);

    expect(res.handled).toBe(true);
    expect(res.type).toBe('COMMAND');
    expect(res.commandResult?.success).toBe(false);
    expect(res.replyText).toContain('hanya memiliki izin untuk dijalankan oleh Organizer');
  });

  it('successfully creates tournament with !createtournament by organizer', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    const msg = createTextMessage(organizerJid, centralGroupJid, '!createtournament Flash Peak Grand Cup');
    const res = await app.handleInboundMessage(msg);

    expect(res.handled).toBe(true);
    expect(res.type).toBe('COMMAND');
    expect(res.commandResult?.success).toBe(true);
    expect(res.replyText).toContain('TURNAMEN BERHASIL DIBUAT');
    expect(res.replyText).toContain('Flash Peak Grand Cup');

    // Verify tournament in DB
    const dbTourneys = await db.execute("SELECT * FROM tournaments WHERE name = 'Flash Peak Grand Cup'");
    expect(dbTourneys.rows.length).toBe(1);
    expect(dbTourneys.rows[0].status).toBe('DRAFT');
  });

  it('rejects !draw when fewer than 8 teams are verified', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    // Create tournament
    await app.handleInboundMessage(
      createTextMessage(organizerJid, centralGroupJid, '!createtournament Draw Test')
    );

    // Call !draw without enough teams
    const drawMsg = createTextMessage(organizerJid, centralGroupJid, '!draw');
    const res = await app.handleInboundMessage(drawMsg);

    expect(res.handled).toBe(true);
    expect(res.commandResult?.success).toBe(false);
    expect(res.replyText).toContain('minimal 8 tim');
  });

  it('warns organizer when !draw is called with 8 teams but !onboarding was forgotten', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    // Create tournament and add 8 unverified teams (pending delegate)
    await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!createtournament Forgotten Onboarding'));
    for (let i = 1; i <= 8; i++) {
      await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, `!addteam ForgottenTeam${i}`));
    }

    // Call !draw without onboarding
    const drawMsg = createTextMessage(organizerJid, centralGroupJid, '!draw');
    const res = await app.handleInboundMessage(drawMsg);

    expect(res.handled).toBe(true);
    expect(res.commandResult?.success).toBe(false);
    expect(res.replyText).toContain('ONBOARDING DELEGASI BELUM LENGKAP');
    expect(res.replyText).toContain('!onboarding');
  });

  it('successfully executes !draw, creates groups & fixtures, and announces schedule', async () => {
    const app = createApp({
      db,
      organizerPhone,
      centralGroupJid,
    });

    // 1. Create tournament
    await app.handleInboundMessage(
      createTextMessage(organizerJid, centralGroupJid, '!createtournament Autumn League')
    );
    const tourneyRes = await db.execute("SELECT id FROM tournaments WHERE name = 'Autumn League'");
    const tourneyId = String(tourneyRes.rows[0].id);

    // 2. Register 8 verified teams
    const now = new Date().toISOString();
    for (let i = 1; i <= 8; i++) {
      const delId = randomUUID();
      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES (?, ?, 'ACTIVE', ?, ?)`,
        args: [delId, `Delegate ${i}`, now, now],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'VERIFIED', ?, ?)`,
        args: [randomUUID(), tourneyId, `Team ${i}`, delId, now, now],
      });
    }

    // 3. Execute !draw
    const drawMsg = createTextMessage(organizerJid, centralGroupJid, '!draw');
    const res = await app.handleInboundMessage(drawMsg);

    expect(res.handled).toBe(true);
    expect(res.commandResult?.success).toBe(true);
    expect(res.replyText).toContain('HASIL LENGKAP PENGUNDIAN GRUP');
    expect(res.replyText).toContain('JADWAL PERTANDINGAN');
    expect(res.replyText).toContain('GRUP A');
    expect(res.replyText).toContain('GRUP B');

    // 4. Verify Tournament transitioned to ACTIVE
    const updatedTourney = await db.execute({
      sql: 'SELECT status FROM tournaments WHERE id = ?',
      args: [tourneyId],
    });
    expect(updatedTourney.rows[0].status).toBe('ACTIVE');

    // 5. Verify Fixtures were created (for 2 groups of 4: 6 matches per group = 12 total fixtures)
    const fixturesRes = await db.execute({
      sql: 'SELECT COUNT(*) as cnt FROM fixtures WHERE tournament_id = ?',
      args: [tourneyId],
    });
    expect(Number(fixturesRes.rows[0].cnt)).toBe(12);

    // 6. Calling !draw again returns existing draw without rerolling (FR-COMP-006)
    const secondDraw = await app.handleInboundMessage(drawMsg);
    expect(secondDraw.commandResult?.success).toBe(true);
    expect(secondDraw.replyText).toContain('sudah selesai sebelumnya');
  });

  describe('Admin Manual Mode Command (!manualreport)', () => {
    it('rejects !manualreport when invoked by non-organizer', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const msg = createTextMessage(regularUserJid, centralGroupJid, '!manualreport fix-001 2 1');
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.type).toBe('COMMAND');
      expect(res.commandResult?.success).toBe(false);
      expect(res.replyText).toContain('hanya memiliki izin untuk dijalankan oleh Organizer');
    });

    it('shows usage guide when !manualreport is called without arguments by organizer', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const msg = createTextMessage(organizerJid, centralGroupJid, '!manualreport');
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.type).toBe('COMMAND');
      expect(res.commandResult?.success).toBe(false);
      expect(res.replyText).toContain('Format Perintah !manualreport');
      expect(res.replyText).toContain('Format Ringkas');
    });

    it('(a) successfully processes !manualreport with explicit scorers, stages confirmation, and creates draft only after OK confirmation', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const now = new Date().toISOString();
      const tourneyId = 'tourney-manual-01';
      const teamAId = 'team-manual-a';
      const teamBId = 'team-manual-b';
      const delAId = 'del-manual-a';
      const delBId = 'del-manual-b';
      const fixtureId = 'fix-manual-01';
      const gameId = 'game-manual-01';

      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Manual Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
        args: [tourneyId, now, now],
      });

      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES (?, 'Del A', 'ACTIVE', ?, ?), (?, 'Del B', 'ACTIVE', ?, ?)`,
        args: [delAId, now, now, delBId, now, now],
      });

      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
              VALUES (?, ?, 'Alpha Team', ?, 'VERIFIED', ?, ?),
                     (?, ?, 'Beta Team', ?, 'VERIFIED', ?, ?)`,
        args: [teamAId, tourneyId, delAId, now, now, teamBId, tourneyId, delBId, now, now],
      });

      // Seed players: 1 GK + 4 Outfield for each team
      for (let i = 1; i <= 5; i++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-alpha-${i}`, tourneyId, teamAId, `AVO | Alpha${i}`, `AVO | Alpha${i}`, `alpha${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-beta-${i}`, tourneyId, teamBId, `HX · Beta${i}`, `HX · Beta${i}`, `beta${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
      }

      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES (?, ?, 'GROUP', ?, ?, ?, 'SCHEDULED', ?, ?)`,
        args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
              VALUES (?, ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
        args: [gameId, fixtureId, now, now],
      });

      // Step 1: Submit command with explicit scorers (using clan tag stripped names "Alpha2", "Alpha3", "Beta2")
      const commandText = `!manualreport ${fixtureId} 2-1\ngol A: Alpha2, Alpha3\ngol B: Beta2`;
      const msg = createTextMessage(organizerJid, centralGroupJid, commandText);
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.commandResult?.success).toBe(true);
      // Verify confirmation prompt is presented with fuzzy matched names
      expect(res.replyText).toContain('Konfirmasi Pemadanan Nama Pencetak Gol');
      expect(res.replyText).toContain('AVO | Alpha2');
      expect(res.replyText).toContain('AVO | Alpha3');
      expect(res.replyText).toContain('HX · Beta2');
      expect(res.replyText).toContain('Balas *OK*');

      // Verify draft report is NOT created yet in DB!
      const initialVerRes = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(Number(initialVerRes.rows[0].cnt)).toBe(0);

      // Step 2: Organizer replies "OK"
      const confirmMsg = createTextMessage(organizerJid, centralGroupJid, 'OK');
      const confirmRes = await app.handleInboundMessage(confirmMsg);

      expect(confirmRes.handled).toBe(true);
      expect(confirmRes.replyText).toContain('PENDING APPROVAL');
      expect(confirmRes.replyText).toContain('Alpha Team');
      expect(confirmRes.replyText).toContain('Beta Team');
      expect(confirmRes.replyText).toContain('2 - 1');

      // Verify draft report NOW exists in DB with MANUAL_ENTRY provenance
      const finalVerRes = await db.execute({
        sql: 'SELECT provenance, status FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(finalVerRes.rows.length).toBe(1);
      expect(finalVerRes.rows[0].provenance).toBe('MANUAL_ENTRY');
      expect(finalVerRes.rows[0].status).toBe('PENDING_APPROVAL');
    });

    it('(b) rejects !manualreport when scorer goal count does not match reported score', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const now = new Date().toISOString();
      const tourneyId = 'tourney-manual-mismatch';
      const teamAId = 'team-manual-mismatch-a';
      const teamBId = 'team-manual-mismatch-b';
      const fixtureId = 'fix-manual-mismatch';

      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Mismatch Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
        args: [tourneyId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES (?, ?, 'Team One', 'VERIFIED', ?, ?), (?, ?, 'Team Two', 'VERIFIED', ?, ?)`,
        args: [teamAId, tourneyId, now, now, teamBId, tourneyId, now, now],
      });

      for (let i = 1; i <= 5; i++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-t1-${i}`, tourneyId, teamAId, `PlayerOne${i}`, `PlayerOne${i}`, `playerone${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-t2-${i}`, tourneyId, teamBId, `PlayerTwo${i}`, `PlayerTwo${i}`, `playertwo${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
      }

      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES (?, ?, 'GROUP', ?, ?, ?, 'SCHEDULED', ?, ?)`,
        args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
      });

      // Reported score is 2-1, but Team A only lists 1 scorer (PlayerOne2)
      const msg = createTextMessage(
        organizerJid,
        centralGroupJid,
        `!manualreport ${fixtureId} 2-1 A:PlayerOne2 B:PlayerTwo2`
      );
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.commandResult?.success).toBe(false);
      expect(res.replyText).toContain('tidak cocok dengan skor tim');
      expect(res.replyText).toContain('Selisih: 1 gol');

      // Ensure no draft was created
      const verRes = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(Number(verRes.rows[0].cnt)).toBe(0);
    });

    it('(c) handles fallback when no scorer list is given (records unassigned with warning, requires confirmation)', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const now = new Date().toISOString();
      const tourneyId = 'tourney-manual-unassigned';
      const teamAId = 'team-manual-unassigned-a';
      const teamBId = 'team-manual-unassigned-b';
      const fixtureId = 'fix-manual-unassigned';
      const gameId = 'game-manual-unassigned';

      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Unassigned Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
        args: [tourneyId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES (?, ?, 'Foxes', 'VERIFIED', ?, ?), (?, ?, 'Hounds', 'VERIFIED', ?, ?)`,
        args: [teamAId, tourneyId, now, now, teamBId, tourneyId, now, now],
      });

      for (let i = 1; i <= 5; i++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-fox-${i}`, tourneyId, teamAId, `Fox${i}`, `Fox${i}`, `fox${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-hound-${i}`, tourneyId, teamBId, `Hound${i}`, `Hound${i}`, `hound${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
      }

      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES (?, ?, 'GROUP', ?, ?, ?, 'SCHEDULED', ?, ?)`,
        args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
              VALUES (?, ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
        args: [gameId, fixtureId, now, now],
      });

      // Organizer provides only fixture and score, no scorer list
      const msg = createTextMessage(organizerJid, centralGroupJid, `!manualreport ${fixtureId} 2-0 Tanpa daftar nama`);
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.commandResult?.success).toBe(true);
      expect(res.replyText).toContain('Konfirmasi Draf Manual (Tanpa Rincian Pencetak Gol)');
      expect(res.replyText).toContain('TIDAK DIKETAHUI / UNASSIGNED');
      expect(res.replyText).toContain('Balas *OK*');

      // Verify no draft yet
      const preVer = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(Number(preVer.rows[0].cnt)).toBe(0);

      // Confirm with OK
      const confirmMsg = createTextMessage(organizerJid, centralGroupJid, 'OK');
      const confirmRes = await app.handleInboundMessage(confirmMsg);

      expect(confirmRes.handled).toBe(true);
      expect(confirmRes.replyText).toContain('PENDING APPROVAL');
      expect(confirmRes.replyText).toContain('belum ditugaskan ke pencetak gol terdata');

      // Verify draft created
      const postVer = await db.execute({
        sql: 'SELECT provenance, status FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(postVer.rows.length).toBe(1);
      expect(postVer.rows[0].provenance).toBe('MANUAL_ENTRY');
    });

    it('(d) rejects when scorer name fails fuzzy match against team roster', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const now = new Date().toISOString();
      const tourneyId = 'tourney-manual-notfound';
      const teamAId = 'team-manual-notfound-a';
      const teamBId = 'team-manual-notfound-b';
      const fixtureId = 'fix-manual-notfound';

      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'NotFound Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
        args: [tourneyId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES (?, ?, 'Eagles', 'VERIFIED', ?, ?), (?, ?, 'Hawks', 'VERIFIED', ?, ?)`,
        args: [teamAId, tourneyId, now, now, teamBId, tourneyId, now, now],
      });

      for (let i = 1; i <= 5; i++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-eagle-${i}`, tourneyId, teamAId, `Eagle${i}`, `Eagle${i}`, `eagle${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-hawk-${i}`, tourneyId, teamBId, `Hawk${i}`, `Hawk${i}`, `hawk${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
      }

      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES (?, ?, 'GROUP', ?, ?, ?, 'SCHEDULED', ?, ?)`,
        args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
      });

      const msg = createTextMessage(
        organizerJid,
        centralGroupJid,
        `!manualreport ${fixtureId} 1-0 A: PemainFiktif99`
      );
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.commandResult?.success).toBe(false);
      expect(res.replyText).toContain('Tidak ada pemain di roster yang cocok dengan nama "PemainFiktif99"');
    });

    it('(e) supports organizer sending correction before confirming with OK (draft not created until OK)', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const now = new Date().toISOString();
      const tourneyId = 'tourney-manual-correction';
      const teamAId = 'team-manual-corr-a';
      const teamBId = 'team-manual-corr-b';
      const fixtureId = 'fix-manual-corr';
      const gameId = 'game-manual-corr';

      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Correction Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
        args: [tourneyId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
              VALUES (?, ?, 'Wolves', 'VERIFIED', ?, ?), (?, ?, 'Lions', 'VERIFIED', ?, ?)`,
        args: [teamAId, tourneyId, now, now, teamBId, tourneyId, now, now],
      });

      for (let i = 1; i <= 5; i++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-wolf-${i}`, tourneyId, teamAId, `WolfPlayer${i}`, `WolfPlayer${i}`, `wolfplayer${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-lion-${i}`, tourneyId, teamBId, `LionPlayer${i}`, `LionPlayer${i}`, `lionplayer${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
      }

      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES (?, ?, 'GROUP', ?, ?, ?, 'SCHEDULED', ?, ?)`,
        args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
              VALUES (?, ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
        args: [gameId, fixtureId, now, now],
      });

      // 1. Initial manual report with WolfPlayer4
      const msg1 = createTextMessage(
        organizerJid,
        centralGroupJid,
        `!manualreport ${fixtureId} 2-1 A:WolfPlayer2,WolfPlayer4 B:LionPlayer2`
      );
      const res1 = await app.handleInboundMessage(msg1);
      expect(res1.replyText).toContain('WolfPlayer4');
      expect(res1.replyText).toContain('Balas *OK*');

      // 2. Organizer sends correction: "bukan WolfPlayer4 tapi WolfPlayer3"
      const corrMsg = createTextMessage(
        organizerJid,
        centralGroupJid,
        'bukan WolfPlayer4 tapi WolfPlayer3'
      );
      const corrRes = await app.handleInboundMessage(corrMsg);

      expect(corrRes.handled).toBe(true);
      expect(corrRes.replyText).toContain('WolfPlayer3');
      expect(corrRes.replyText).not.toContain('WolfPlayer4');
      expect(corrRes.replyText).toContain('Balas *OK*');

      // Verify draft STILL NOT CREATED yet
      const preVer = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(Number(preVer.rows[0].cnt)).toBe(0);

      // 3. Organizer confirms with "OK"
      const confirmMsg = createTextMessage(organizerJid, centralGroupJid, 'OK');
      const confirmRes = await app.handleInboundMessage(confirmMsg);

      expect(confirmRes.handled).toBe(true);
      expect(confirmRes.replyText).toContain('PENDING APPROVAL');
      expect(confirmRes.replyText).toContain('Wolves');

      // Verify draft NOW created in DB
      const postVer = await db.execute({
        sql: 'SELECT provenance, status FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(postVer.rows.length).toBe(1);
      expect(postVer.rows[0].provenance).toBe('MANUAL_ENTRY');
    });

    it('successfully processes !manualreport via JSON format with specific player statistics', async () => {
      const app = createApp({
        db,
        organizerPhone,
        centralGroupJid,
      });

      const now = new Date().toISOString();
      const tourneyId = 'tourney-manual-02';
      const teamAId = 'team-manual-json-a';
      const teamBId = 'team-manual-json-b';
      const delAId = 'del-manual-json-a';
      const delBId = 'del-manual-json-b';
      const fixtureId = 'fix-manual-json-01';
      const gameId = 'game-manual-json-01';

      await db.execute({
        sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
              VALUES (?, 'Manual JSON Cup', 'ACTIVE', 'Asia/Jakarta', '1.0.0', '{}', ?, ?)`,
        args: [tourneyId, now, now],
      });

      await db.execute({
        sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
              VALUES (?, 'Del JSON A', 'ACTIVE', ?, ?), (?, 'Del JSON B', 'ACTIVE', ?, ?)`,
        args: [delAId, now, now, delBId, now, now],
      });

      await db.execute({
        sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
              VALUES (?, ?, 'Cyber JSON', ?, 'VERIFIED', ?, ?),
                     (?, ?, 'Solar JSON', ?, 'VERIFIED', ?, ?)`,
        args: [teamAId, tourneyId, delAId, now, now, teamBId, tourneyId, delBId, now, now],
      });

      for (let i = 1; i <= 5; i++) {
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-cj-${i}`, tourneyId, teamAId, `CJPlayer${i}`, `CJPlayer${i}`, `cjplayer${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
        await db.execute({
          sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
          args: [
            `p-sj-${i}`, tourneyId, teamBId, `SJPlayer${i}`, `SJPlayer${i}`, `sjplayer${i}`,
            i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, now, now,
          ],
        });
      }

      await db.execute({
        sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
              VALUES (?, ?, 'GROUP', ?, ?, ?, 'SCHEDULED', ?, ?)`,
        args: [fixtureId, tourneyId, teamAId, teamBId, teamAId, now, now],
      });
      await db.execute({
        sql: `INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at)
              VALUES (?, ?, 1, 'IN_PROGRESS', 'PENDING', ?, ?)`,
        args: [gameId, fixtureId, now, now],
      });

      const payload = {
        fixture_id: fixtureId,
        game_id: gameId,
        team_a_score: 3,
        team_b_score: 0,
        team_a_players: [
          { nickname_raw: 'CJPlayer1', goals: 0, assists: 0, passes: 5, defense_raw: 6, goalkeeper_saves: 6 },
          { nickname_raw: 'CJPlayer2', goals: 2, assists: 1, passes: 12, defense_raw: 1 },
          { nickname_raw: 'CJPlayer3', goals: 1, assists: 1, passes: 14, defense_raw: 2 },
          { nickname_raw: 'CJPlayer4', goals: 0, assists: 0, passes: 8, defense_raw: 0 },
          { nickname_raw: 'CJPlayer5', goals: 0, assists: 0, passes: 9, defense_raw: 1 },
        ],
        team_b_players: [
          { nickname_raw: 'SJPlayer1', goals: 0, assists: 0, passes: 4, defense_raw: 3, goalkeeper_saves: 3 },
          { nickname_raw: 'SJPlayer2', goals: 0, assists: 0, passes: 7, defense_raw: 1 },
          { nickname_raw: 'SJPlayer3', goals: 0, assists: 0, passes: 6, defense_raw: 2 },
          { nickname_raw: 'SJPlayer4', goals: 0, assists: 0, passes: 5, defense_raw: 1 },
          { nickname_raw: 'SJPlayer5', goals: 0, assists: 0, passes: 8, defense_raw: 0 },
        ],
        notes: 'Input manual via JSON payload',
      };

      const msg = createTextMessage(
        organizerJid,
        centralGroupJid,
        `!manualreport ${JSON.stringify(payload)}`
      );
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.commandResult?.success).toBe(true);
      expect(res.replyText).toContain('PENDING APPROVAL');
      expect(res.replyText).toContain('Cyber JSON');
      expect(res.replyText).toContain('Solar JSON');
      expect(res.replyText).toContain('3 - 0');

      const verRes = await db.execute({
        sql: 'SELECT provenance, status FROM report_versions WHERE fixture_id = ?',
        args: [fixtureId],
      });
      expect(verRes.rows[0].provenance).toBe('MANUAL_ENTRY');
      expect(verRes.rows[0].status).toBe('PENDING_APPROVAL');
    });
  });

  describe('New Tournament Operational Commands (!rule, !roster, !claimwo)', () => {
    it('responds to !rule with official tournament competition rules', async () => {
      const app = createApp({ db, organizerPhone, centralGroupJid });
      const msg = createTextMessage(regularUserJid, centralGroupJid, '!rule');
      const res = await app.handleInboundMessage(msg);

      expect(res.handled).toBe(true);
      expect(res.commandResult?.success).toBe(true);
      expect(res.replyText).toContain('REGULASI RESMI TURNAMEN FLASH PEAK');
      expect(res.replyText).toContain('Format 5+3');
      expect(res.replyText).toContain('19:59 WIB');
      expect(res.replyText).toContain('D-031');
      expect(res.replyText).toContain('Karakter Unik');
      expect(res.replyText).toContain('double Ford');
    });

    it('allows registering and viewing team roster with format 5+5 (1 GK, 4 Inti, up to 5 Cadangan)', async () => {
      const app = createApp({ db, organizerPhone, centralGroupJid });

      // Create tournament & team
      await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!createtournament Roster Cup'));
      await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!addteam Singa FC'));

      // Register roster: 1 GK, 4 Inti, 3 Cadangan (Total 8)
      const regMsg = createTextMessage(
        organizerJid,
        centralGroupJid,
        '!roster Singa FC GK: KingKiper | Inti: Striker1, Mid1, Def1, Def2 | Cadangan: Sub1, Sub2, Sub3'
      );
      const regRes = await app.handleInboundMessage(regMsg);

      expect(regRes.handled).toBe(true);
      expect(regRes.commandResult?.success).toBe(true);
      expect(regRes.replyText).toContain('ROSTER TIM SINGA FC BERHASIL DIDAFTARKAN');
      expect(regRes.replyText).toContain('KingKiper');
      expect(regRes.replyText).toContain('Striker1');
      expect(regRes.replyText).toContain('Sub1');
      expect(regRes.replyText).toContain('8 / 8');
      expect(regRes.replyText).toContain('Karakter Unik');

      // View roster
      const viewMsg = createTextMessage(regularUserJid, centralGroupJid, '!roster Singa FC');
      const viewRes = await app.handleInboundMessage(viewMsg);

      expect(viewRes.handled).toBe(true);
      expect(viewRes.commandResult?.success).toBe(true);
      expect(viewRes.replyText).toContain('ROSTER RESMI TIM: SINGA FC');
      expect(viewRes.replyText).toContain('KingKiper');
      expect(viewRes.replyText).toContain('Striker1');
      expect(viewRes.replyText).toContain('Sub1');
    });

    it('supports flexible natural language and multiline roster registration', async () => {
      const app = createApp({ db, organizerPhone, centralGroupJid });

      await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!createtournament Flexible Roster Cup'));
      await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!addteam Garuda FC'));
      await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!addteam Elang FC'));

      // 1. Natural Language registration with informal Indonesian
      const nlMsg = createTextMessage(
        organizerJid,
        centralGroupJid,
        '!daftar roster tim Garuda FC kipernya Ikyy, pemain intinya Budi, Joko, Doni, Reza, cadangannya Rian, Kevin'
      );
      const nlRes = await app.handleInboundMessage(nlMsg);

      expect(nlRes.handled).toBe(true);
      expect(nlRes.replyText).toContain('ROSTER TIM GARUDA FC BERHASIL DIDAFTARKAN');
      expect(nlRes.replyText).toContain('Ikyy');
      expect(nlRes.replyText).toContain('Budi');
      expect(nlRes.replyText).toContain('Reza');
      expect(nlRes.replyText).toContain('Rian');
      expect(nlRes.replyText).toContain('7 / 8');

      // 2. Multiline registration with numbers and bullet points
      const multilineText = [
        '!roster Elang FC',
        'Kiper: EagleGK',
        'Inti:',
        '1. P1',
        '2. P2',
        '3. P3',
        '4. P4',
        'Cadangan:',
        '- C1',
        '- C2',
      ].join('\n');

      const multiRes = await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, multilineText));
      expect(multiRes.handled).toBe(true);
      expect(multiRes.replyText).toContain('ROSTER TIM ELANG FC BERHASIL DIDAFTARKAN');
      expect(multiRes.replyText).toContain('EagleGK');
      expect(multiRes.replyText).toContain('P1');
      expect(multiRes.replyText).toContain('C1');
      expect(multiRes.replyText).toContain('7 / 8');

      // 3. Reject duplicate player across teams (Rule 2.7)
      // Attempt to register 'Budi' (already in Garuda FC) into a new roster
      const dupMsg = createTextMessage(
        organizerJid,
        centralGroupJid,
        '!roster tim Elang FC kiper EagleGK, inti Budi, P2, P3, P4, cadangan C1'
      );
      const dupRes = await app.handleInboundMessage(dupMsg);
      expect(dupRes.replyText).toContain('sudah terdaftar di tim *Garuda FC*');
    });

    it('executes !claimwo single forfeit and awards 3-0 win with 3 points', async () => {
      const app = createApp({ db, organizerPhone, centralGroupJid });

      // Create tournament with 8 teams and draw
      await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!createtournament WO Cup'));
      for (let i = 1; i <= 8; i++) {
        await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, `!addteam TeamWO${i}`));
      }
      await app.handleInboundMessage(createTextMessage(organizerJid, centralGroupJid, '!draw'));

      // Find first fixture
      const fRes = await db.execute(`
        SELECT f.id, ta.team_name as team_a_name, tb.team_name as team_b_name 
        FROM fixtures f 
        JOIN teams ta ON f.team_a_id = ta.id 
        JOIN teams tb ON f.team_b_id = tb.id 
        LIMIT 1
      `);
      const fixtureId = String(fRes.rows[0].id);
      const teamAName = String(fRes.rows[0].team_a_name);
      const teamBName = String(fRes.rows[0].team_b_name);

      // Claim WO: Team A forfeits against Team B
      const woMsg = createTextMessage(
        organizerJid,
        centralGroupJid,
        `!claimwo ${fixtureId} ${teamAName} Lawan tidak hadir 10 menit setelah kick-off`
      );
      const woRes = await app.handleInboundMessage(woMsg);

      expect(woRes.handled).toBe(true);
      expect(woRes.commandResult?.success).toBe(true);
      expect(woRes.replyText).toContain('KEPUTUSAN KLAIM WALKOVER (WO)');
      expect(woRes.replyText).toContain(`3 Poin* untuk ${teamBName}`);
      expect(woRes.replyText).toContain('Klasemen grup telah diperbarui');

      // Verify fixture status is WALKOVER in DB
      const checkRes = await db.execute({
        sql: "SELECT status FROM fixtures WHERE id = ?",
        args: [fixtureId],
      });
      expect(checkRes.rows[0].status).toBe('WALKOVER');
    });
  });
});
