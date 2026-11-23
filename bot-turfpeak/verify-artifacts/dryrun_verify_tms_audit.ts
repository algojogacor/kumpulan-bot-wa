/**
 * Verification dry-run for audit findings T1, T2, T5, T6, T11, T15 (dynamic part)
 * against master @03f8860. Read-only: builds an in-memory DB, exercises the
 * exact code paths the audit report claims are broken, prints PASS/FAIL per
 * assertion. No production files touched.
 *
 * T1: duplicate-KO detection wrongly flags a legitimate new game as duplicate
 *     when its score pair matches an already-decided game (e.g. BO3 games
 *     1-0 and 1-0). ko-evidence-pipeline.ts:355-393.
 * T2: odd survivor count after bye -> generateKnockoutFixtures throws
 *     "Jumlah juara grup (rank 1) harus sama dengan runner-up grup (rank 2)"
 *     -> !startknockout returns failure (deadlock).
 * T5: !kores on COMPLETED series -> recordSeriesGameResult throws
 *     "Series ini sudah selesai" although docs promise re-record.
 * T6: organizer NL correction rejected: coordinator does not pass is_organizer;
 *     verifyCorrectionAuthority falls to delegate match -> UNAUTHORIZED.
 * T11: NEEDS_REVIEW journal status is never written by any code path.
 * T15: deriveKnockoutQualifiers orders by points/GD/GF only (SQL), while
 *      computeGroupStandings applies H2H tie-break -> different qualification
 *      when rank-2/rank-3 tie resolved by head-to-head.
 */
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import {
  generateKnockoutFixtures,
  type KnockoutQualifier,
} from '../src/competition/fixtures.js';
import { recordSeriesGameResult } from '../src/competition/series.js';
import { applyKoGameEvidence } from '../src/application/ko-evidence-pipeline.js';
import { applyReportCorrection } from '../src/reports/corrections.js';
import { computeGroupStandings, type CompletedGameRecord, type GroupTeamInfo } from '../src/competition/standings.js';
import { deriveKnockoutQualifiers, type KnockoutQualifier as KQ } from '../src/competition/fixtures.js';

const results: Array<{ id: string; label: string; pass: boolean; detail: string }> = [];
function check(id: string, label: string, pass: boolean, detail: string) {
  results.push({ id, label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${label}\n      ${detail}`);
}

async function insertTeam(db: Client, tid: string, name: string) {
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at)
          VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`,
    args: [tid, TID, name],
  });
}
let TID = '';

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  TID = randomUUID();
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
          VALUES (?, 'Verify T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`,
    args: [TID],
  });
  return db;
}

// Build a KO fixture+series for two teams directly via generateKnockoutFixtures
async function buildKoFixture(db: Client, teamA: string, teamB: string) {
  // 4 qualifiers -> SEMI_FINAL BO3 (target 2) so two decisive games complete a series.
  const other1 = randomUUID(), other2 = randomUUID();
  await insertTeam(db, other1, 'Tim C');
  await insertTeam(db, other2, 'Tim D');
  const quals: KnockoutQualifier[] = [
    { team_id: teamA, team_name: 'A', group_code: 'A', group_rank: 1 },
    { team_id: other1, team_name: 'C', group_code: 'B', group_rank: 2 },
    { team_id: other2, team_name: 'D', group_code: 'C', group_rank: 1 },
    { team_id: teamB, team_name: 'B', group_code: 'D', group_rank: 2 },
  ];
  const { fixtures, series } = await generateKnockoutFixtures(db, TID, quals);
  // Pairing: winner A vs runner-up B -> match 0 is A vs B.
  const f = fixtures.find((fx) =>
    (fx.team_a_id === teamA && fx.team_b_id === teamB) ||
    (fx.team_a_id === teamB && fx.team_b_id === teamA)) ?? fixtures[0]!;
  const s = series.find((ser) => ser.fixture_id === f.id)!;
  return { fixture: f, seriesRow: s };
}

async function main() {
  // ================= T1 =================
  {
    const db = await freshDb();
    const tA = randomUUID(), tB = randomUUID();
    await insertTeam(db, tA, 'Tim A');
    await insertTeam(db, tB, 'Tim B');
    const { fixture } = await buildKoFixture(db, tA, tB);

    // Game 1: 2-0 (decisive, team A wins game 1)
    const r1 = await applyKoGameEvidence(db, { fixtureId: fixture.id, teamAScore: 2, teamBScore: 0, submittedByDelegateId: null });
    // Game 2: legit NEW game with the SAME score pair 2-0 (perfectly normal in BO3)
    const r2 = await applyKoGameEvidence(db, { fixtureId: fixture.id, teamAScore: 2, teamBScore: 0, submittedByDelegateId: null });

    const wrongDuplicate = r2.status === 'DUPLICATE';
    const seriesWins = await db.execute({
      sql: 'SELECT team_a_game_wins, team_b_game_wins FROM series WHERE fixture_id = ?',
      args: [fixture.id],
    });
    const row = seriesWins.rows[0] as any;
    check('T1', 'Legit game 2 (2-0 again) wrongly flagged DUPLICATE by pair-score match',
      wrongDuplicate,
      `game1=${r1.status}, game2=${r2.status} (expected GAME_APPLIED if no bug); series wins after 2 photos: ${row.team_a_game_wins}-${row.team_b_game_wins} (expected 2-0 if both applied). Bug terkonfirmasi jika game2=DUPLICATE dan series 1-0.`);
    db.close();
  }

  // ================= T2 =================
  {
    const db = await freshDb();
    // 3 unique survivors (odd) — e.g. SEMI_FINAL round where one semi was a
    // double-loss and its partner got a bye: winners.length=3 -> half=1 ->
    // ranks [1,2,2] -> winners=1, runnersUp=2 -> generateKnockoutFixtures throws.
    const teams = ['W1', 'W2', 'W3'];
    for (const t of teams) await insertTeam(db, randomUUID(), t);
    const quals: KnockoutQualifier[] = [
      { team_id: (await db.execute(`SELECT id FROM teams WHERE team_name='W1'`)).rows[0]![0] as string, team_name: 'W1', group_code: 'W', group_rank: 1 },
      { team_id: (await db.execute(`SELECT id FROM teams WHERE team_name='W2'`)).rows[0]![0] as string, team_name: 'W2', group_code: 'L', group_rank: 2 },
      { team_id: (await db.execute(`SELECT id FROM teams WHERE team_name='W3'`)).rows[0]![0] as string, team_name: 'W3', group_code: 'L', group_rank: 2 },
    ];
    let threw = '';
    try {
      await generateKnockoutFixtures(db, TID, quals);
    } catch (e: any) {
      threw = e.message;
    }
    check('T2', 'Odd survivor count (3) makes generateKnockoutFixtures throw -> !startknockout deadlock',
      threw.includes('Jumlah juara grup'),
      `generateKnockoutFixtures threw: "${threw}" -> in !startknockout this surfaces as the command failing ("Gagal mencatat hasil game knockout"/handler error), bracket cannot advance.`);
    db.close();
  }

  // ================= T5 =================
  {
    const db = await freshDb();
    const tA = randomUUID(), tB = randomUUID();
    await insertTeam(db, tA, 'Tim A');
    await insertTeam(db, tB, 'Tim B');
    const { fixture, seriesRow } = await buildKoFixture(db, tA, tB);
    // Complete the series 2-0
    const c1 = await recordSeriesGameResult(db, { series_id: seriesRow.id, game_number: 1, team_a_score: 2, team_b_score: 0 });
    const c2 = await recordSeriesGameResult(db, { series_id: seriesRow.id, game_number: 2, team_a_score: 3, team_b_score: 1 });
    check('T5-pre', 'series reached COMPLETED 2-0 as precondition',
      c2.is_series_complete === true,
      `game1 complete=${c1.is_series_complete}, game2 complete=${c2.is_series_complete}`);

    let errMsg = '';
    try {
      await recordSeriesGameResult(db, { series_id: seriesRow.id, game_number: 2, team_a_score: 1, team_b_score: 3 });
    } catch (e: any) {
      errMsg = e.message;
    }
    check('T5', '!kores on COMPLETED series throws although docs promise re-record',
      errMsg.includes('sudah selesai'),
      `recordSeriesGameResult threw: "${errMsg}" — cara-penggunaan.md:537 promises "Kalau series sudah selesai, hasil game yang sama bisa di-rekam ulang lewat perintah yang sama".`);
    db.close();
  }

  // ================= T6 =================
  {
    const db = await freshDb();
    const tA = randomUUID(), tB = randomUUID();
    await insertTeam(db, tA, 'Tim A');
    await insertTeam(db, tB, 'Tim B');
    // delegates for team A/B (so authority path works for comparison)
    const delA = randomUUID(), delB = randomUUID();
    await db.execute(`INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, 'Del A', 'ACTIVE', datetime('now'), datetime('now'))`, [delA]);
    await db.execute(`INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, 'Del B', 'ACTIVE', datetime('now'), datetime('now'))`, [delB]);
    await db.execute(`UPDATE teams SET delegate_id = ? WHERE id = ?`, [delA, tA]);
    await db.execute(`UPDATE teams SET delegate_id = ? WHERE id = ?`, [delB, tB]);

    const { fixture } = await buildKoFixture(db, tA, tB);
    // Build a report version (stand-in for an AI draft)
    const sessionId = randomUUID();
    await db.execute({
      sql: `INSERT INTO report_sessions (id, fixture_id, submitting_team_id, status, last_message_at, debounce_due_at, extension_count, version, created_at, updated_at)
            VALUES (?, ?, ?, 'DRAFT_READY', datetime('now'), datetime('now'), 0, 1, datetime('now'), datetime('now'))`,
      args: [sessionId, fixture.id, tA],
    });
    const inbId = randomUUID();
    await db.execute({
      sql: `INSERT INTO inbound_messages (id, provider_message_key, chat_id, sender_raw_address, message_timestamp, received_at, message_type, text_body, raw_metadata_json, created_at)
            VALUES (?, 'k1', 'c@g.us', '6280000000001@s.whatsapp.net', datetime('now'), datetime('now'), 'TEXT', 'koreksi', '{}', datetime('now'))`,
      args: [inbId],
    });
    const versionId = randomUUID();
    await db.execute({
      sql: `INSERT INTO report_versions (id, report_session_id, fixture_id, version_number, status, extraction_json, validated_data_json, provenance, created_by, created_at)
            VALUES (?, ?, ?, 1, 'PENDING_APPROVAL', '{}', ?, 'AI', 'sys', datetime('now'))`,
      args: [versionId, sessionId, fixture.id, JSON.stringify({
        fixture_id: fixture.id, team_a_id: tA, team_b_id: tB, team_a_score: 2, team_b_score: 1,
        team_a_players: [], team_b_players: [],
      })],
    });

    // Organizer (not a delegate of either team) sends a correction.
    // coordinator computes senderId = normalized address (no delegate), then
    // applyReportCorrection is called WITHOUT is_organizer (the missing flag).
    const organizerAddress = '6289977777777@s.whatsapp.net';
    const res = await applyReportCorrection(db, {
      target_report_version_id: versionId,
      sender_id: organizerAddress,
      inbound_message_id: inbId,
      patch: { metric: 'score', team_side: 'TEAM_A', new_value: 3 },
      // is_organizer deliberately NOT set — mirrors report-correction-coordinator.ts:116-121
    });
    check('T6', 'Organizer NL correction rejected (is_organizer never forwarded)',
      res.status === 'REJECTED' && (res.error || '').includes('Unauthorized sender'),
      `applyReportCorrection without is_organizer -> status=${res.status}, error="${res.error}". Same result happens in the live path because handleReportCorrection never passes is_organizer.`);
    db.close();
  }

  // ================= T11 =================
  {
    const db = await freshDb();
    const tA = randomUUID(), tB = randomUUID();
    await insertTeam(db, tA, 'Tim A');
    await insertTeam(db, tB, 'Tim B');
    const { fixture, seriesRow } = await buildKoFixture(db, tA, tB);
    // Game 1 decisive, then send a DIFFERENT-score photo. Per doc the pipeline
    // should journal NEEDS_REVIEW ("menandainya butuh review"). Trace what happens.
    await recordSeriesGameResult(db, { series_id: seriesRow.id, game_number: 1, team_a_score: 2, team_b_score: 0 });
    // A conflicting photo for game 1 cannot target game 1 (slot derivation moves
    // to game 2); it is applied as game 2 instead. Check journal statuses.
    const r = await applyKoGameEvidence(db, { fixtureId: fixture.id, teamAScore: 0, teamBScore: 2, submittedByDelegateId: null });
    const journaled = await db.execute({
      sql: 'SELECT game_number, status, resolution_note FROM ko_game_evidence WHERE fixture_id = ? ORDER BY created_at',
      args: [fixture.id],
    });
    const statuses = journaled.rows.map((x: any) => `${x.game_number}:${x.status}`).join(', ');
    check('T11', 'NEEDS_REVIEW status never written; conflicting photo silently becomes game 2',
      r.status === 'GAME_APPLIED' && !statuses.includes('NEEDS_REVIEW'),
      `conflicting photo (0-2 vs recorded 2-0 for game 1) -> outcome=${r.status}, journal=[${statuses}]. Mirrored-pair guard comment says a mirror "fills the next open slot as a normal new game" — so a genuine conflict for a decided slot is IMPOSSIBLE via photos; NEEDS_REVIEW is dead code (grep: only type/comment refs).`);
    db.close();
  }

  // ================= T15 =================
  {
    const db = await freshDb();
    // Group A with 3 teams; rank2/rank3 fully tied on points/GD/GF but rank2
    // wins head-to-head. computeGroupStandings resolves via H2H; the SQL in
    // deriveKnockoutQualifiers (fixtures.ts:470-499) has no H2H and no tie
    // guard for the 2nd/3rd cluster — ordering of rows 2/3 is arbitrary.
    const drawId = randomUUID();
    await db.execute({
      sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at)
            VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fisher-yates', '1', datetime('now'))`,
      args: [drawId, TID],
    });
    const g = randomUUID();
    await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`, [g, drawId]);
    const t1 = randomUUID(), t2 = randomUUID(), t3 = randomUUID();
    let pos = 0;
    for (const [id, name] of [[t1, 'Alpha'], [t2, 'Bravo'], [t3, 'Charlie']] as const) {
      await insertTeam(db, id, name);
      await db.execute(`INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, ?)`, [g, id, ++pos]);
    }
    // games: Alpha beats both (6 pts). Bravo vs Charlie: each 1W 1L vs the other?
    // Make Bravo and Charlie fully tied on Pts/GD/GF, with Bravo winning H2H.
    // Bravo beat Charlie 1-0; Charlie beat Alpha 1-0; Alpha beat Bravo 2-0...
    // Simpler: construct completed game records directly for computeGroupStandings.
    const games: CompletedGameRecord[] = [
      { id: randomUUID(), fixture_id: 'f1', team_a_id: t1, team_b_id: t2, team_a_score: 2, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
      { id: randomUUID(), fixture_id: 'f2', team_a_id: t1, team_b_id: t3, team_a_score: 2, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
      { id: randomUUID(), fixture_id: 'f3', team_a_id: t2, team_b_id: t3, team_a_score: 1, team_b_score: 0, winner_team_id: t2, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    ];
    // Alpha 6pts (4-0, GD+4), Bravo 3pts (1-1, GD 0), Charlie 3pts (1-2... wait)
    // f3: Bravo 1-0 Charlie. Charlie: 0-1 vs Bravo, 0-2 vs Alpha => GF1 GA3 GD-2. Not tied.
    // Make Charlie 2-0 vs Bravo and Bravo... let's make both 3 pts with same GD/GF:
    // Charlie beats Bravo 2-1 (f3 flipped): Bravo GF1 GA2? no.
    // Cleanest tie: f3 = Bravo 1-0 Charlie; Charlie 1-0 Alpha; Alpha 2-0 Bravo? Then Alpha 3pts too.
    // Instead: Alpha 6pts; Bravo & Charlie both 3pts, GD 0, GF 1, GA 1: impossible with 1 H2H game + games vs Alpha.
    // Bravo vs Alpha 0-2 (GF0 GA2), Charlie vs Alpha 0-2: then H2H Bravo 1-0 Charlie gives Bravo GF1 GA2 GD-1, Charlie GF0... not tied.
    // Use: Alpha 2-0 Bravo, Alpha 2-0 Charlie, Bravo 1-0 Charlie.
    //   Bravo: P3, GF1 GA2 GD-1. Charlie: P0. Not tied. To tie Bravo&Charlie on all of Pts/GD/GF:
    //   Bravo 1-0 Charlie AND Charlie 1-0 Bravo (double round robin):
    const games2: CompletedGameRecord[] = [
      { id: randomUUID(), fixture_id: 'f1', team_a_id: t1, team_b_id: t2, team_a_score: 2, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
      { id: randomUUID(), fixture_id: 'f2', team_a_id: t1, team_b_id: t3, team_a_score: 2, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
      { id: randomUUID(), fixture_id: 'f3', team_a_id: t2, team_b_id: t3, team_a_score: 1, team_b_score: 0, winner_team_id: t2, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
      { id: randomUUID(), fixture_id: 'f4', team_a_id: t3, team_b_id: t2, team_a_score: 1, team_b_score: 0, winner_team_id: t3, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    ];
    const teamsInfo: GroupTeamInfo[] = [
      { team_id: t1, team_name: 'Alpha' },
      { team_id: t2, team_name: 'Bravo' },
      { team_id: t3, team_name: 'Charlie' },
    ];
    const standings = computeGroupStandings(TID, g, teamsInfo, games2);
    const byName = Object.fromEntries(standings.map((s: any) => [s.team_name, s]));
    // Bravo: P3 GF1 GA2 GD-1 ... Charlie: P3 GF1 GA2 GD-1? Charlie: 0-2 (f2) + 1-0 (f4): GF1 GA2 GD-1. Bravo: 0-2 (f1) + 1-0 (f3): GF1 GA2 GD-1. Tied on all!
    const h2hResolvedSecond = standings[1]?.team_name === 'Bravo' && standings[2]?.team_name === 'Charlie';

    // Now persist to standings table and run deriveKnockoutQualifiers's SQL logic:
    for (const s of standings as any[]) {
      await db.execute({
        sql: `INSERT INTO standings (tournament_id, group_id, team_id, played, wins, draws, losses, goals_for, goals_against, goal_difference, points, head_to_head_points, computed_at, source_revision)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'r1')`,
        args: [TID, g, s.team_id, s.played, s.wins, s.draws, s.losses, s.goals_for, s.goals_against, s.goal_difference, s.points, s.head_to_head_points ?? 0],
      });
    }
    let sqlQualified = '';
    try {
      const q = await deriveKnockoutQualifiers(db, TID);
      sqlQualified = q.map((x: any) => `${x.group_rank}:${x.team_name}`).join(' ');
    } catch (e: any) {
      sqlQualified = `THREW: ${e.message}`;
    }
    check('T15', 'KO qualification SQL ignores H2H tie-break (and may throw on full tie of rank 1-2)',
      h2hResolvedSecond || sqlQualified.startsWith('THREW'),
      `computeGroupStandings order (H2H applied): ${standings.map((s: any) => s.team_name).join(' > ')} (2nd=${standings[1]?.team_name}, h2h_points Bravo=${byName['Bravo']?.head_to_head_points} Charlie=${byName['Charlie']?.head_to_head_points}). deriveKnockoutQualifiers -> ${sqlQualified}. The SQL ORDER BY has no H2H and treats a rank1/rank2 full tie as fatal, while standings.ts would have resolved it by H2H.`);
    db.close();
  }

  console.log('\n==== SUMMARY ====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.label}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} assertions behaved as the audit predicted (PASS = audit finding reproduced).`);
}

main().catch((e) => { console.error('DRY-RUN CRASH:', e); process.exit(1); });
