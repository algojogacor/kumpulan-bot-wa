// T15 fix check: H2H-resolved rank-2 tie qualifies the same team as !standings;
// full tie (incl. H2H) still throws for manual resolution.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { computeGroupStandings, type CompletedGameRecord, type GroupTeamInfo } from '../src/competition/standings.js';
import { deriveKnockoutQualifiers } from '../src/competition/fixtures.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
  const drawId = randomUUID();
  await db.execute(`INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at) VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fy', '1', datetime('now'))`, [drawId, TID]);
  const g = randomUUID();
  await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`, [g, drawId]);
  const t1 = randomUUID(), t2 = randomUUID(), t3 = randomUUID();
  let pos = 0;
  for (const [id, name] of [[t1, 'Alpha'], [t2, 'Bravo'], [t3, 'Charlie']] as const) {
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, name]);
    await db.execute(`INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, ?)`, [g, id, ++pos]);
  }
  // Double round-robin: Alpha 6pts; Bravo/Charlie 3pts each, fully tied Pts/GD/GF,
  // H2H 1-1 (Bravo won first, Charlie won second) — h2h_points both 3.
  const games: CompletedGameRecord[] = [
    { id: randomUUID(), fixture_id: 'f1', team_a_id: t1, team_b_id: t2, team_a_score: 2, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'f2', team_a_id: t1, team_b_id: t3, team_a_score: 2, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'f3', team_a_id: t2, team_b_id: t3, team_a_score: 1, team_b_score: 0, winner_team_id: t2, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'f4', team_a_id: t3, team_b_id: t2, team_a_score: 1, team_b_score: 0, winner_team_id: t3, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
  ];
  const teamsInfo: GroupTeamInfo[] = [
    { team_id: t1, team_name: 'Alpha' }, { team_id: t2, team_name: 'Bravo' }, { team_id: t3, team_name: 'Charlie' },
  ];
  const standings = computeGroupStandings(TID, g, teamsInfo, games);
  for (const s of standings as any[]) {
    await db.execute(`INSERT INTO standings (tournament_id, group_id, team_id, played, wins, draws, losses, goals_for, goals_against, goal_difference, points, head_to_head_points, computed_at, source_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'r1')`,
      [TID, g, s.team_id, s.played, s.wins, s.draws, s.losses, s.goals_for, s.goals_against, s.goal_difference, s.points, s.head_to_head_points ?? 0]);
  }
  // With the fix, a full tie INCLUDING h2h_points (3-3) at the rank cut -> throws.
  const dbg = await db.execute('SELECT t.team_name, s.points, s.goal_difference, s.goals_for, s.head_to_head_points FROM standings s JOIN teams t ON s.team_id=t.id WHERE s.group_id = ?', [g]);
  for (const r of dbg.rows as any[]) console.log('  standings:', r.team_name, 'P' + r.points, 'GD' + r.goal_difference, 'GF' + r.goals_for, 'H2H' + r.head_to_head_points);
  let threw = false;
  try { await deriveKnockoutQualifiers(db, TID); } catch (e: any) { threw = true; console.log('  threw:', String(e.message).slice(0, 90)); }
  console.log('full-tie (incl. H2H 3-3) at cut ->', threw ? 'throws for manual resolution (expected)' : 'NO THROW (wrong)');

  // Scenario 2: rank-2/3 tie resolved the way computeGroupStandings resolves it
  // (H2H points when available, else team-name order). 4-team group:
  //   Alpha beats everyone (9 pts, rank 1)
  //   Bravo/Charlie split H2H 1-0 / 0-1, both beat Delta 2-0 -> 6 pts, GF3 GA1 GD+2 (TIED)
  //   Delta loses all (0 pts)
  // H2H between Bravo & Charlie: 1 win each -> h2h_points 3-3 -> computeGroupStandings
  // falls back to team_name order (Bravo first). The qualifier must equal the
  // engine's rank-2, whatever the engine decides.
  await db.execute('DELETE FROM standings');
  const t4 = randomUUID();
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, 'Delta', 'VERIFIED', datetime('now'), datetime('now'))`, [t4, TID]);
  await db.execute(`INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, ?)`, [g, t4, 4]);
  const teamsInfo4: GroupTeamInfo[] = [
    { team_id: t1, team_name: 'Alpha' }, { team_id: t2, team_name: 'Bravo' },
    { team_id: t3, team_name: 'Charlie' }, { team_id: t4, team_name: 'Delta' },
  ];
  const games4: CompletedGameRecord[] = [
    { id: randomUUID(), fixture_id: 'g1', team_a_id: t1, team_b_id: t2, team_a_score: 1, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'g2', team_a_id: t1, team_b_id: t3, team_a_score: 1, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'g3', team_a_id: t1, team_b_id: t4, team_a_score: 1, team_b_score: 0, winner_team_id: t1, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'g4', team_a_id: t2, team_b_id: t3, team_a_score: 1, team_b_score: 0, winner_team_id: t2, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'g5', team_a_id: t3, team_b_id: t2, team_a_score: 1, team_b_score: 0, winner_team_id: t3, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'g6', team_a_id: t2, team_b_id: t4, team_a_score: 2, team_b_score: 0, winner_team_id: t2, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
    { id: randomUUID(), fixture_id: 'g7', team_a_id: t3, team_b_id: t4, team_a_score: 2, team_b_score: 0, winner_team_id: t3, is_draw: 0, is_walkover: 0, walkover_type: null, status: 'COMPLETED' },
  ];
  // NOTE: games are NOT inserted into the games table; deriveKnockoutQualifiers now
  // recomputes from the games table, so insert them there for the engine.
  for (const gm of games4) {
    await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
                      VALUES (?, ?, 'GROUP', ?, 'MD1', ?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`,
      [gm.fixture_id, TID, g, gm.team_a_id, gm.team_b_id, gm.team_a_id]);
    await db.execute(`INSERT INTO games (id, fixture_id, series_id, game_number, status, team_a_score, team_b_score, winner_team_id, is_draw, is_walkover, walkover_type, evidence_status, created_at, updated_at)
                      VALUES (?, ?, NULL, 1, 'COMPLETED', ?, ?, ?, 0, 0, 'NONE', 'VERIFIED', datetime('now'), datetime('now'))`,
      [gm.id, gm.fixture_id, gm.team_a_score, gm.team_b_score, gm.winner_team_id]);
  }
  const engine = computeGroupStandings(TID, g, teamsInfo4, games4);
  const displayRank2 = engine[1]?.team_name;
  const q = await deriveKnockoutQualifiers(db, TID);
  const rank2 = q.find((x: any) => x.group_rank === 2);
  console.log('engine order :', engine.map((x: any) => x.team_name).join(' > '));
  console.log('qualifier rank2:', rank2?.team_name, '| engine rank2:', displayRank2);
  const ok = threw && rank2?.team_name === displayRank2 && !!displayRank2;
  console.log(ok ? 'T15-FIX VERIFIED' : 'T15-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
