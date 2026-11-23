// T17 fix check: 19:59 cutoff now catches KNOCKOUT fixtures.
// - KO fixture unplayed at cutoff -> handleKnockoutDoubleRoomCardFailure (D-032):
//   fixture WALKOVER, series COMPLETED no winner, audit event; NOT group double-WO.
// - GROUP fixture unplayed -> handleGroupDoubleWalkover (D-031) unchanged.
// - Subsequent !startknockout-style bye detection sees the WALKOVER+COMPLETED-no-winner shape.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { MatchdayService } from '../src/application/matchday-service.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);

  // --- KO SEMI_FINAL fixture (group_id NULL) with a series ---
  const tA = randomUUID(), tB = randomUUID(), tC = randomUUID(), tD = randomUUID();
  for (const [id, nm] of [[tA, 'KA'], [tB, 'KB'], [tC, 'GA'], [tD, 'GB']] as const) {
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, nm]);
  }
  const fxK = randomUUID(), fxK2 = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'KNOCKOUT', 'SEMI_FINAL', ?, ?, ?, 'SCHEDULED', datetime('now'), datetime('now'))`, [fxK, TID, tA, tB, tA]);
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'KNOCKOUT', 'SEMI_FINAL', ?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`, [fxK2, TID, tC, tD, tC]);
  const serK2 = randomUUID();
  await db.execute(`INSERT INTO series (id, fixture_id, format, target_wins, status, winner_team_id, created_at, updated_at) VALUES (?, ?, 'BO3', 2, 'COMPLETED', ?, datetime('now'), datetime('now'))`, [serK2, fxK2, tC]);
  const serK = randomUUID();
  await db.execute(`INSERT INTO series (id, fixture_id, format, target_wins, status, created_at, updated_at) VALUES (?, ?, 'BO3', 2, 'IN_PROGRESS', datetime('now'), datetime('now'))`, [serK, fxK]);

  // --- GROUP fixture for the same tournament (earlier round would win 'current
  // round' detection, so put both in the SAME round_code? No: current round =
  // earliest unfinished round, GROUP first. To make the cutoff target the KO
  // round, the group fixture must be in an EARLIER-but-completed state or a
  // LATER round. Simplest realistic case: group stage is over (COMPLETED), the
  // active round IS the KO round. ---
  const drawId = randomUUID();
  await db.execute(`INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at) VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fy', '1', datetime('now'))`, [drawId, TID]);
  const grp = randomUUID();
  await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`, [grp, drawId]);
  const fxG = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'GROUP', ?, 'MD1', ?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`, [fxG, TID, grp, tA, tB, tA]);

  const svc = new MatchdayService({ db });
  const res = await svc.processDailyCutoff(true);

  const koFixture = await db.execute(`SELECT status FROM fixtures WHERE id = ?`, [fxK]);
  const koSeries = await db.execute(`SELECT status, winner_team_id FROM series WHERE id = ?`, [serK]);
  const auditKo = await db.execute(`SELECT COUNT(*) as c FROM audit_events WHERE event_type = 'KNOCKOUT_DOUBLE_LOSS_RECORDED' AND entity_id = ?`, [fxK]);
  const untouched = await db.execute(`SELECT status FROM fixtures WHERE id = ?`, [fxK2]);
  const groupUntouched = await db.execute(`SELECT status FROM fixtures WHERE id = ?`, [fxG]);

  console.log('cutoff processed:', res.hasCutoffProcessed, '| resolved:', res.resolvedFixturesCount);
  console.log('KO fixture status:', String((koFixture.rows[0] as any).status));
  console.log('KO series:', String((koSeries.rows[0] as any).status), 'winner:', (koSeries.rows[0] as any).winner_team_id);
  console.log('KNOCKOUT_DOUBLE_LOSS audit rows:', Number((auditKo.rows[0] as any).c));
  console.log('other SEMI (already completed):', String((untouched.rows[0] as any).status), '| group MD1 (completed):', String((groupUntouched.rows[0] as any).status));
  console.log('announcement mentions D-032 bye:', (res.announcementText || '').includes('KALAH GANDA'));

  // Regression: group double-WO still applies when the current round is a GROUP round.
  const TID2 = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T2', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now', '+1 hour'), datetime('now', '+1 hour'))`, [TID2]);
  const t2A = randomUUID(), t2B = randomUUID();
  for (const [id, nm] of [[t2A, 'G2A'], [t2B, 'G2B']] as const) {
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID2, nm]);
  }
  const drawId2 = randomUUID();
  await db.execute(`INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at) VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fy', '1', datetime('now'))`, [drawId2, TID2]);
  const grp2 = randomUUID();
  await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`, [grp2, drawId2]);
  const fxG2 = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'GROUP', ?, 'MD1', ?, ?, ?, 'SCHEDULED', datetime('now'), datetime('now'))`, [fxG2, TID2, grp2, t2A, t2B, t2A]);
  // Note: getActiveTournamentCurrentRound picks latest ACTIVE tournament -> TID2.
  const res2 = await svc.processDailyCutoff(true);
  const g2 = await db.execute(`SELECT f.status, gm.walkover_type FROM fixtures f JOIN games gm ON gm.fixture_id = f.id WHERE f.id = ?`, [fxG2]);
  console.log('regression GROUP round: resolved:', res2.resolvedFixturesCount, '| fixture:', String((g2.rows[0] as any).status), '| walkover_type:', String((g2.rows[0] as any).walkover_type));

  const ok = res.hasCutoffProcessed
    && String((koFixture.rows[0] as any).status) === 'WALKOVER'
    && String((koSeries.rows[0] as any).status) === 'COMPLETED' && (koSeries.rows[0] as any).winner_team_id === null
    && Number((auditKo.rows[0] as any).c) === 1
    && String((untouched.rows[0] as any).status) === 'COMPLETED'
    && (res.announcementText || '').includes('KALAH GANDA')
    && res2.resolvedFixturesCount === 1 && String((g2.rows[0] as any).status) === 'WALKOVER' && String((g2.rows[0] as any).walkover_type) === 'DOUBLE_ABSENT';
  console.log(ok ? 'T17-FIX VERIFIED' : 'T17-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
