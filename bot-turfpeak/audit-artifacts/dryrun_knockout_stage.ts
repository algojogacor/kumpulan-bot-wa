/**
 * Dry-run FIX2-KO-001: runtime entry point for the Knockout Stage.
 *
 * Verifies end-to-end on an in-memory SQLite with real migrations:
 *   1. Group stage complete -> !startknockout derives qualifiers (top 2 per
 *      group) and generates the bracket (audit event recorded).
 *   2. !startknockout refuses while group fixtures are unfinished.
 *   3. !kores records individual BO3/BO5 game results via
 *      recordSeriesGameResult; tied game -> mandatory replay (D-028).
 *   4. When all series of a round complete, !startknockout generates the next
 *      round from series winners (2 groups -> SF -> FINAL).
 *   5. Grand Final BO5 win -> tournament COMPLETED with champion announcement.
 *   6. !matchday status now describes the knockout round (FIX2-KO-001).
 */
import { createClient } from '@libsql/client';
import { FlashPeakApp } from '../src/index.js';
import { runMigrations } from '../src/db/migrate.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

async function main() {
  console.log('=== DRY-RUN FIX2-KO-001: Knockout Stage Runtime Entry ===\n');

  const db = createClient({ url: 'file::memory:?cache=shared' });
  await runMigrations(db);

  const now = new Date().toISOString();
  const organizerPhone = '628999000001';
  const organizerJid = `${organizerPhone}@s.whatsapp.net`;
  const centralGroupJid = '120363000000000001@g.us';

  // Seed organizer identity
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: ['del-org', 'Tournament Admin', 'ACTIVE', now, now],
  });
  await db.execute({
    sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['wa-org', 'del-org', organizerJid, 'PHONE', 1, now],
  });

  // Seed tournament + 2 groups of 4 teams
  const tId = 'tourney-ko-1';
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [tId, 'Flash Peak KO Cup', 'ACTIVE', '1.0', '{}', now, now],
  });
  await db.execute({
    sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at)
          VALUES ('draw-ko-1', ?, 'COMPLETED', '{}', '[]', 'CRYPTO_RANDOM', '1.0', ?)`,
    args: [tId, now],
  });

  const teams = [
    { id: 'team-a1', name: 'Alpha FC', group: 'group-a', pos: 1 },
    { id: 'team-a2', name: 'Beta FC', group: 'group-a', pos: 2 },
    { id: 'team-a3', name: 'Gamma FC', group: 'group-a', pos: 3 },
    { id: 'team-a4', name: 'Delta FC', group: 'group-a', pos: 4 },
    { id: 'team-b1', name: 'Epsilon FC', group: 'group-b', pos: 1 },
    { id: 'team-b2', name: 'Zeta FC', group: 'group-b', pos: 2 },
    { id: 'team-b3', name: 'Eta FC', group: 'group-b', pos: 3 },
    { id: 'team-b4', name: 'Theta FC', group: 'group-b', pos: 4 },
  ];

  for (const grp of ['group-a', 'group-b']) {
    await db.execute({
      sql: `INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, 'draw-ko-1', ?, ?)`,
      args: [grp, grp === 'group-a' ? 'A' : 'B', grp === 'group-a' ? 1 : 2],
    });
  }
  for (const t of teams) {
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', ?, ?)`,
      args: [t.id, tId, t.name, now, now],
    });
    await db.execute({
      sql: `INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, ?)`,
      args: [t.group, t.id, t.pos],
    });
  }

  // Seed COMPLETED group fixtures with final standings:
  // Group A: Alpha 6 pts (1st), Beta 3 pts (2nd)
  // Group B: Epsilon 6 pts (1st), Zeta 3 pts (2nd)
  const groupResults = [
    // fixture, group, a, b, scoreA, scoreB
    { f: 'fx-a-1', g: 'group-a', a: 'team-a1', b: 'team-a2', sa: 2, sb: 1 },
    { f: 'fx-a-2', g: 'group-a', a: 'team-a1', b: 'team-a3', sa: 3, sb: 0 },
    { f: 'fx-a-3', g: 'group-a', a: 'team-a1', b: 'team-a4', sa: 1, sb: 0 },
    { f: 'fx-a-4', g: 'group-a', a: 'team-a2', b: 'team-a3', sa: 1, sb: 0 },
    { f: 'fx-a-5', g: 'group-a', a: 'team-a2', b: 'team-a4', sa: 0, sb: 0 },
    { f: 'fx-a-6', g: 'group-a', a: 'team-a3', b: 'team-a4', sa: 1, sb: 1 },
    { f: 'fx-b-1', g: 'group-b', a: 'team-b1', b: 'team-b2', sa: 2, sb: 0 },
    { f: 'fx-b-2', g: 'group-b', a: 'team-b1', b: 'team-b3', sa: 2, sb: 1 },
    { f: 'fx-b-3', g: 'group-b', a: 'team-b1', b: 'team-b4', sa: 1, sb: 0 },
    { f: 'fx-b-4', g: 'group-b', a: 'team-b2', b: 'team-b3', sa: 1, sb: 0 },
    { f: 'fx-b-5', g: 'group-b', a: 'team-b2', b: 'team-b4', sa: 0, sb: 0 },
    { f: 'fx-b-6', g: 'group-b', a: 'team-b3', b: 'team-b4', sa: 1, sb: 1 },
  ];

  for (const r of groupResults) {
    const isDraw = r.sa === r.sb;
    const winner = isDraw ? null : (r.sa > r.sb ? r.a : r.b);
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, group_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'GROUP', 'ROUND_1', ?, ?, ?, 'COMPLETED', ?, ?)`,
      args: [r.f, tId, r.g, r.a, r.b, r.a, now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, team_a_score, team_b_score, winner_team_id, is_draw, is_walkover, walkover_type, evidence_status, created_at, updated_at)
            VALUES (?, ?, 1, 'COMPLETED', ?, ?, ?, ?, 0, 'NONE', 'VERIFIED', ?, ?)`,
      args: [
        `gm-${r.f}`, r.f, r.sa, r.sb, winner, isDraw ? 1 : 0, now, now,
      ],
    });
  }

  // Persist standings per group via the official recalc path
  const { recalculateAndPersistGroupStandings } = await import('../src/competition/standings.js');
  await recalculateAndPersistGroupStandings(db, tId, 'group-a');
  await recalculateAndPersistGroupStandings(db, tId, 'group-b');

  const app = new FlashPeakApp({
    db,
    organizerPhone,
    organizerJid,
    centralGroupJid,
  });

  const sendCmd = async (text: string) => {
    const msg: NormalizedMessage = {
      message_id: `msg-${Date.now()}-${Math.random()}`,
      chat_id: centralGroupJid,
      // MERGE-ALIGN: kontrak NormalizedMessage (sender_raw_address); field
      // legacy sender_id telah dihapus oleh PR #3 (BUGFIX-TS-002).
      sender_raw_address: organizerJid,
      sender_normalized_address: organizerJid,
      sender_phone: organizerPhone,
      is_group: true,
      text_body: text,
      timestamp: new Date(),
    } as unknown as NormalizedMessage;
    return app.handleInboundMessage(msg);
  };

  // --- Test 1: guard — unfinished group fixtures must block !startknockout ---
  console.log('--- Test 1: Guard unfinished group stage ---');
  {
    // Temporarily flip one group fixture back to SCHEDULED
    await db.execute({
      sql: "UPDATE fixtures SET status = 'SCHEDULED' WHERE id = 'fx-b-6'",
    });
    const res = await sendCmd('!startknockout');
    assert(
      res.replyText?.includes('belum selesai') === true,
      'blocked while group fixtures unfinished'
    );
    await db.execute({
      sql: "UPDATE fixtures SET status = 'COMPLETED' WHERE id = 'fx-b-6'",
    });
  }

  // --- Test 2: !startknockout generates the bracket from final standings ---
  console.log('--- Test 2: First knockout round generation ---');
  const res2 = await sendCmd('!startknockout');
  console.log((res2.replyText || '').slice(0, 300));
  const koFixturesRes = await db.execute({
    sql: `SELECT f.id, f.round_code, f.stage, f.team_a_id, f.team_b_id FROM fixtures f
          WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' ORDER BY f.created_at ASC`,
    args: [tId],
  });
  assert(koFixturesRes.rows.length === 2, '2 knockout fixtures generated (semi finals)');
  assert(
    koFixturesRes.rows.every((r: any) => String(r.round_code) === 'SEMI_FINAL'),
    'round code is SEMI_FINAL'
  );
  const seriesRes = await db.execute({
    sql: `SELECT s.id, s.fixture_id, s.format, s.target_wins FROM series s
          JOIN fixtures f ON s.fixture_id = f.id
          WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT'`,
    args: [tId],
  });
  assert(seriesRes.rows.length === 2, '2 series created');
  assert(
    seriesRes.rows.every((r: any) => String(r.format) === 'BO3' && Number(r.target_wins) === 2),
    'semi finals are BO3 target 2'
  );
  // Qualifiers: winners face adjacent group runners-up, no same-group rematch
  const koPairs = koFixturesRes.rows.map((r: any) => [String(r.team_a_id), String(r.team_b_id)]);
  const sameGroupRematch = koPairs.some(([a, b]) =>
    teams.find((t) => t.id === a)!.group === teams.find((t) => t.id === b)!.group
  );
  assert(!sameGroupRematch, 'no same-group rematch in first KO round');
  const auditRes = await db.execute({
    sql: `SELECT COUNT(*) as c FROM audit_events WHERE event_type = 'KNOCKOUT_STAGE_STARTED'`,
  });
  assert(Number(auditRes.rows[0].c) === 1, 'KNOCKOUT_STAGE_STARTED audit event recorded');

  // Idempotency: running again while series pending -> info message
  const res2b = await sendCmd('!startknockout');
  assert(
    res2b.replyText?.includes('sudah berjalan') === true,
    'second !startknockout reports active series instead of duplicating'
  );

  // --- Test 3: !kores records games, tied game forces replay ---
  console.log('--- Test 3: !kores series reporting ---');
  const sf1 = koFixturesRes.rows[0] as any;
  const sf1Id = String(sf1.id);
  const sf1SeriesId = String(
    (await db.execute({
      sql: 'SELECT id FROM series WHERE fixture_id = ?',
      args: [sf1Id],
    })).rows[0].id
  );

  // Game 1 tied 1-1 -> replay required, series score stays 0-0
  const r1 = await sendCmd(`!kores ${sf1Id} 1 1-1`);
  assert(
    r1.replyText?.includes('WAJIB REPLAY') === true || r1.replyText?.includes('dicatat') === true,
    'tied game command accepted'
  );
  const s1 = (await db.execute({
    sql: 'SELECT team_a_game_wins, team_b_game_wins, status FROM series WHERE id = ?',
    args: [sf1SeriesId],
  })).rows[0] as any;
  assert(
    Number(s1.team_a_game_wins) === 0 && Number(s1.team_b_game_wins) === 0,
    'tied game does not advance series wins'
  );

  // Replay of game 1 decisive 2-1
  await sendCmd(`!kores ${sf1Id} 1 2-1`);
  // Game 2: team B wins 0-2 -> series 1-1
  await sendCmd(`!kores ${sf1Id} 2 0-2`);
  const s2 = (await db.execute({
    sql: 'SELECT team_a_game_wins, team_b_game_wins, status FROM series WHERE id = ?',
    args: [sf1SeriesId],
  })).rows[0] as any;
  assert(
    Number(s2.team_a_game_wins) === 1 && Number(s2.team_b_game_wins) === 1,
    'series score 1-1 after two decisive games'
  );

  // Game 3: team A wins -> BO3 complete 2-1
  const r3 = await sendCmd(`!kores ${sf1Id} 3 2-0`);
  const s3 = (await db.execute({
    sql: 'SELECT team_a_game_wins, team_b_game_wins, status, winner_team_id FROM series WHERE id = ?',
    args: [sf1SeriesId],
  })).rows[0] as any;
  assert(
    Number(s3.team_a_game_wins) === 2 && Number(s3.team_b_game_wins) === 1,
    'BO3 completes at 2 wins'
  );
  assert(String(s3.status) === 'COMPLETED', 'series status COMPLETED');
  assert(
    String(s3.winner_team_id) === String(sf1.team_a_id),
    'series winner = team A of fixture'
  );
  const fx1Status = (await db.execute({
    sql: 'SELECT status FROM fixtures WHERE id = ?',
    args: [sf1Id],
  })).rows[0] as any;
  assert(String(fx1Status.status) === 'COMPLETED', 'fixture COMPLETED when series completes');

  // --- Test 4: complete second SF, then next round generation ---
  console.log('--- Test 4: Next round generation ---');
  const sf2 = koFixturesRes.rows[1] as any;
  const sf2Id = String(sf2.id);
  await sendCmd(`!kores ${sf2Id} 1 1-2`); // team B wins game 1
  await sendCmd(`!kores ${sf2Id} 2 1-2`); // team B wins game 2 -> 0-2 complete

  const res4 = await sendCmd('!startknockout');
  const finalRes = await db.execute({
    sql: `SELECT f.id, f.round_code, f.stage FROM fixtures f
          WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' AND f.round_code = 'FINAL'`,
    args: [tId],
  });
  assert(finalRes.rows.length === 1, 'GRAND FINAL fixture generated');
  const finalSeriesRes = await db.execute({
    sql: `SELECT s.format, s.target_wins FROM series s JOIN fixtures f ON s.fixture_id = f.id WHERE f.round_code = 'FINAL' AND f.tournament_id = ?`,
    args: [tId],
  });
  assert(
    finalSeriesRes.rows.length === 1 &&
      String((finalSeriesRes.rows[0] as any).format) === 'BO5' &&
      Number((finalSeriesRes.rows[0] as any).target_wins) === 3,
    'Grand Final is BO5 target 3'
  );
  const nextRoundAudit = await db.execute({
    sql: `SELECT COUNT(*) as c FROM audit_events WHERE event_type = 'KNOCKOUT_ROUND_GENERATED'`,
  });
  assert(Number(nextRoundAudit.rows[0].c) === 1, 'KNOCKOUT_ROUND_GENERATED audit event recorded');

  // --- Test 5: Grand Final completion -> champion + tournament COMPLETED ---
  console.log('--- Test 5: Grand Final champion ---');
  const finalId = String((finalRes.rows[0] as any).id);
  await sendCmd(`!kores ${finalId} 1 2-1`);
  await sendCmd(`!kores ${finalId} 2 0-2`);
  await sendCmd(`!kores ${finalId} 3 2-1`);
  await sendCmd(`!kores ${finalId} 4 2-0`); // 3 wins -> BO5 complete
  const tStatus = (await db.execute({
    sql: 'SELECT status FROM tournaments WHERE id = ?',
    args: [tId],
  })).rows[0] as any;
  assert(String(tStatus.status) === 'COMPLETED', 'tournament transitions to COMPLETED');

  // Further !startknockout after FINAL -> tournament over
  // (must run BEFORE seeding the second tournament below, so the latest
  // ACTIVE tournament lookup still resolves to this completed one)
  const res5b = await sendCmd(`!startknockout ${tId}`);
  assert(
    res5b.replyText?.includes('sudah selesai hingga Grand Final') === true ||
      res5b.replyText?.includes('Belum ada turnamen aktif') === true ||
      res5b.replyText?.includes('JUARA') === true,
    'post-final !startknockout reports tournament over (no further rounds possible)'
  );

  // --- Test 6: !matchday reflects knockout round mid-stage ---
  console.log('--- Test 6: matchday handles KNOCKOUT stage ---');
  // Build a fresh mini-state: tournament with KO fixture pending
  const t2 = 'tourney-ko-2';
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [t2, 'Matchday KO Test', 'ACTIVE', '1.0', '{}', now, now],
  });
  await db.execute({
    sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
          VALUES ('fx-ko-2', ?, 'KNOCKOUT', 'SEMI_FINAL', 'team-a1', 'team-b1', 'team-a1', 'SCHEDULED', ?, ?)`,
    args: [t2, now, now],
  });
  const statusText = await app.matchdayService.formatMatchdayStatus();
  // NOTE: formatMatchdayStatus uses latest ACTIVE tournament — t2 is newer
  assert(
    statusText.includes('SEMI FINAL') === true || statusText.includes('Semi Final') === true,
    '!matchday describes the active knockout round'
  );

  console.log(`\n=== HASIL: ${passed} PASS, ${failed} FAIL ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
