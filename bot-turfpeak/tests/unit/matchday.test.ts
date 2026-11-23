import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/db/migrate.js';
import { createTournament } from '../../src/competition/tournament.js';
import { MatchdayService } from '../../src/application/matchday-service.js';
import { formatFixturesSchedule } from '../../src/whatsapp/formatters.js';

describe('MatchdayService & 19:59 WIB Cutoff (D-031)', () => {
  let db: Client;
  let service: MatchdayService;

  beforeEach(async () => {
    db = createClient({ url: 'file::memory:?cache=shared' });
    await runMigrations(db);
    service = new MatchdayService({ db, centralGroupJid: '120363000000000000@g.us' });
  });

  afterEach(() => {
    db.close();
  });

  async function setupTournamentWithGroupFixtures(): Promise<{
    tournamentId: string;
    groupId: string;
    teamAId: string;
    teamBId: string;
    fixtureId: string;
  }> {
    const tournament = await createTournament(db, { name: 'Gojiha Turnamen' });
    const tournamentId = tournament.id;
    await db.execute({
      sql: "UPDATE tournaments SET status = 'ACTIVE' WHERE id = ?",
      args: [tournamentId],
    });

    const now = new Date().toISOString();

    // Create group draw & group
    const drawId = randomUUID();
    await db.execute({
      sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at)
            VALUES (?, ?, 'COMPLETED', '{}', '[]', 'FISHER_YATES', 'v1', ?)`,
      args: [drawId, tournamentId, now],
    });

    const groupId = randomUUID();
    await db.execute({
      sql: `INSERT INTO groups (id, draw_id, group_code, display_order)
            VALUES (?, ?, 'A', 1)`,
      args: [groupId, drawId],
    });

    // Create delegates
    const delAId = randomUUID();
    const delBId = randomUUID();
    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, 'Budi', 'ACTIVE', ?, ?)`,
      args: [delAId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, 'Andi', 'ACTIVE', ?, ?)`,
      args: [delBId, now, now],
    });

    const phoneA = `62811${Math.floor(100000 + Math.random() * 900000)}`;
    const phoneB = `62822${Math.floor(100000 + Math.random() * 900000)}`;

    // Create whatsapp identities
    await db.execute({
      sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at)
            VALUES (?, ?, ?, 'JID', 1, ?)`,
      args: [randomUUID(), delAId, `${phoneA}@s.whatsapp.net`, now],
    });
    await db.execute({
      sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at)
            VALUES (?, ?, ?, 'JID', 1, ?)`,
      args: [randomUUID(), delBId, `${phoneB}@s.whatsapp.net`, now],
    });

    // Create teams with delegates
    const teamAId = randomUUID();
    const teamBId = randomUUID();
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
            VALUES (?, ?, 'Garuda FC', ?, 'VERIFIED', ?, ?)`,
      args: [teamAId, tournamentId, delAId, now, now],
    });
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
            VALUES (?, ?, 'Elang FC', ?, 'VERIFIED', ?, ?)`,
      args: [teamBId, tournamentId, delBId, now, now],
    });

    // Add group members
    await db.execute({
      sql: `INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, 1), (?, ?, 2)`,
      args: [groupId, teamAId, groupId, teamBId],
    });

    // Create fixture for ROUND_1
    const fixtureId = randomUUID();
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, 'ROUND_1', ?, ?, ?, 'SCHEDULED', ?, ?)`,
      args: [fixtureId, tournamentId, groupId, teamAId, teamBId, teamAId, now, now],
    });

    // Create fixture for ROUND_2
    const fixture2Id = randomUUID();
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, 'ROUND_2', ?, ?, ?, 'SCHEDULED', ?, ?)`,
      args: [fixture2Id, tournamentId, groupId, teamBId, teamAId, teamBId, now, now],
    });

    return { tournamentId, groupId, teamAId, teamBId, fixtureId };
  }

  it('calculates time remaining to 19:59 WIB deadline', () => {
    const remaining = service.getTimeRemainingToCutoff();
    expect(remaining.hoursLeft).toBeGreaterThanOrEqual(0);
    expect(remaining.minutesLeft).toBeGreaterThanOrEqual(0);
    expect(remaining.formatted).toContain('jam');
    expect(remaining.formatted).toContain('menit');
  });

  it('formats schedule with delegate phone tags (@628...) and mentions', () => {
    const formatted = formatFixturesSchedule('Gojiha Turnamen', [
      {
        roundCode: 'ROUND_1',
        groupCode: 'A',
        teamAName: 'Garuda FC',
        teamBName: 'Elang FC',
        leftSideHostName: 'Garuda FC',
        teamADelegatePhone: '6281111111111',
        teamBDelegatePhone: '6282222222222',
        teamADelegateJid: '6281111111111@s.whatsapp.net',
        teamBDelegateJid: '6282222222222@s.whatsapp.net',
      },
    ]);

    expect(formatted).toContain('Garuda FC* vs *Elang FC* (Host: Garuda FC)');
    expect(formatted).toContain('@6281111111111 vs @6282222222222');
    expect(formatted).toContain('Host: Garuda FC');
  });

  it('auto-resolves unplayed matches at 19:59 WIB as Double Walkover (D-031, 0 points each)', async () => {
    const setup = await setupTournamentWithGroupFixtures();

    // Force daily cutoff
    const result = await service.processDailyCutoff(true);

    expect(result.hasCutoffProcessed).toBe(true);
    expect(result.resolvedFixturesCount).toBe(1);
    expect(result.expiredFixtures[0].id).toBe(setup.fixtureId);

    // Verify announcement includes D-031 explanation
    expect(result.announcementText).toContain('BATAS WAKTU MATCHDAY BERAKHIR (19:59 WIB)');
    expect(result.announcementText).toContain('D-031');
    expect(result.announcementText).toContain('0 poin');
    expect(result.announcementText).toContain('Garuda FC');
    expect(result.announcementText).toContain('Elang FC');

    // Verify next round is announced
    expect(result.nextRoundCode).toBe('ROUND_2');
    expect(result.announcementText).toContain('MATCHDAY BARU RESMI DIMULAI');
    expect(result.announcementText).toContain('Ronde 2');

    // Verify DB state: game record created as walkover with 0-0 score
    const gameRes = await db.execute({
      sql: 'SELECT is_walkover, walkover_type, team_a_score, team_b_score, status FROM games WHERE fixture_id = ?',
      args: [setup.fixtureId],
    });
    expect(gameRes.rows.length).toBe(1);
    expect(gameRes.rows[0].is_walkover).toBe(1);
    expect(gameRes.rows[0].walkover_type).toBe('DOUBLE_ABSENT');
    expect(gameRes.rows[0].team_a_score).toBe(0);
    expect(gameRes.rows[0].team_b_score).toBe(0);
    expect(gameRes.rows[0].status).toBe('WALKOVER');

    // Verify standings: both teams receive 0 points (D-031)
    const standRes = await db.execute({
      sql: 'SELECT team_id, points, played, losses FROM standings WHERE group_id = ?',
      args: [setup.groupId],
    });
    expect(standRes.rows.length).toBe(2);
    for (const row of standRes.rows) {
      expect(Number(row.points)).toBe(0);
      expect(Number(row.played)).toBe(1);
      expect(Number(row.losses)).toBe(1);
    }
  });

  it('formats matchday status display for users (!matchday)', async () => {
    await setupTournamentWithGroupFixtures();
    const statusText = await service.formatMatchdayStatus();

    expect(statusText).toContain('STATUS MATCHDAY TURNAMEN');
    expect(statusText).toContain('Gojiha Turnamen');
    expect(statusText).toContain('Ronde 1');
    expect(statusText).toContain('Batas Waktu Harian:* Pukul 19:59 WIB');
    expect(statusText).toContain('Garuda FC');
    expect(statusText).toContain('Elang FC');
  });
});
