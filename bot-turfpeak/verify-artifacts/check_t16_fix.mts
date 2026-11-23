// T16 fix check: manualreport on KNOCKOUT fixture rejected with guidance;
// GROUP fixture still accepted.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { handleManualReport } from '../src/reports/manual.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
  const tA = randomUUID(), tB = randomUUID(), tC = randomUUID(), tD = randomUUID();
  for (const [id, nm] of [[tA, 'KA'], [tB, 'KB'], [tC, 'GA'], [tD, 'GB']] as const) {
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, nm]);
  }
  // KO fixture
  const fxK = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'KNOCKOUT', 'SEMI_FINAL', ?, ?, ?, 'SCHEDULED', datetime('now'), datetime('now'))`, [fxK, TID, tA, tB, tA]);
  // GROUP fixture
  const drawId = randomUUID();
  await db.execute(`INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at) VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fy', '1', datetime('now'))`, [drawId, TID]);
  const grp = randomUUID();
  await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`, [grp, drawId]);
  const fxG = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'GROUP', ?, 'MD1', ?, ?, ?, 'SCHEDULED', datetime('now'), datetime('now'))`, [fxG, TID, grp, tC, tD, tC]);
  const gmG = randomUUID();
  await db.execute(`INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at) VALUES (?, ?, 1, 'REPORT_PENDING', 'RECEIVED', datetime('now'), datetime('now'))`, [gmG, fxG]);
  // register rosters so validation passes
  for (const [tid, p] of [[tC, 'C'], [tD, 'D']] as const) {
    for (let i = 1; i <= 5; i++) {
      const nick = p + i;
      await db.execute(`INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', datetime('now'), datetime('now'))`,
        [randomUUID(), TID, tid, nick, nick, nick.toLowerCase(), i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i]);
    }
  }

  const players = (p: string) => Array.from({ length: 5 }, (_, i) => ({ nickname_raw: p + (i + 1), goals: 0, assists: 0, passes: 5, defense_raw: 2, rating: 7, goalkeeper_saves: 0 }));

  const rKo = await handleManualReport(db, {
    organizer_id: 'ORGANIZER', is_organizer: true,
    fixture_id: fxK, team_a_score: 2, team_b_score: 1,
    team_a_players: players('A'), team_b_players: players('B'), allow_unassigned_goals: true,
  });
  const rGr = await handleManualReport(db, {
    organizer_id: 'ORGANIZER', is_organizer: true,
    fixture_id: fxG, game_id: gmG, team_a_score: 2, team_b_score: 1,
    team_a_players: players('C'), team_b_players: players('D'), allow_unassigned_goals: true,
  });
  console.log('KO fixture ->', rKo.success, JSON.stringify((rKo.errors || [])[0] || '').slice(0, 80));
  console.log('GROUP fixture ->', rGr.success);
  const ok = rKo.success === false && (rKo.errors?.[0] || '').includes('KNOCKOUT') && rGr.success === true;
  console.log(ok ? 'T16-FIX VERIFIED' : 'T16-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
