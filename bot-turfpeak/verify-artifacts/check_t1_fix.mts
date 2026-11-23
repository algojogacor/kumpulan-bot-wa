// T1/T7/T11 fix check: legit same-pair game applied, tied-slot resend DUPLICATE, late photo IGNORED.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { generateKnockoutFixtures, type KnockoutQualifier } from '../src/competition/fixtures.js';
import { applyKoGameEvidence } from '../src/application/ko-evidence-pipeline.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, 'Team ' + id.slice(0, 4)]);
  const quals: KnockoutQualifier[] = [
    { team_id: ids[0], team_name: 'A', group_code: 'A', group_rank: 1 },
    { team_id: ids[1], team_name: 'C', group_code: 'B', group_rank: 2 },
    { team_id: ids[2], team_name: 'D', group_code: 'C', group_rank: 1 },
    { team_id: ids[3], team_name: 'B', group_code: 'D', group_rank: 2 },
  ];
  const { fixtures } = await generateKnockoutFixtures(db, TID, quals);
  const f = fixtures.find(fx => (fx.team_a_id === ids[0] && fx.team_b_id === ids[3]) || (fx.team_a_id === ids[3] && fx.team_b_id === ids[0]))!;

  // Case 1 (T1): legit game 2 with same pair as game 1 must be APPLIED (previously DUPLICATE).
  const r1 = await applyKoGameEvidence(db, { fixtureId: f.id, teamAScore: 2, teamBScore: 0, submittedByDelegateId: null });
  const r2 = await applyKoGameEvidence(db, { fixtureId: f.id, teamAScore: 2, teamBScore: 0, submittedByDelegateId: null });
  console.log('case1: game1=' + r1.status, 'game2=' + r2.status, 'series=' + r2.seriesScore.team_a + '-' + r2.seriesScore.team_b);

  // Case 2 (slot-scoped duplicate): fresh series; tied game then identical tied resend -> DUPLICATE.
  const f2 = fixtures.find(fx => fx.id !== f.id)!;
  const t1 = await applyKoGameEvidence(db, { fixtureId: f2.id, teamAScore: 1, teamBScore: 1, submittedByDelegateId: null });
  const t2 = await applyKoGameEvidence(db, { fixtureId: f2.id, teamAScore: 1, teamBScore: 1, submittedByDelegateId: null });
  console.log('case2: tied1=' + t1.status, 'tied-resend=' + t2.status);

  // Case 3: late photo after series complete -> SERIES_ALREADY_COMPLETE (unchanged behavior).
  const t3 = await applyKoGameEvidence(db, { fixtureId: f2.id, teamAScore: 2, teamBScore: 0, submittedByDelegateId: null });
  const t4 = await applyKoGameEvidence(db, { fixtureId: f2.id, teamAScore: 2, teamBScore: 0, submittedByDelegateId: null });
  const t5 = await applyKoGameEvidence(db, { fixtureId: f2.id, teamAScore: 9, teamBScore: 9, submittedByDelegateId: null });
  console.log('case3: g2=' + t3.status, 'g3=' + t4.status, 'late=' + t5.status);

  const ok = r1.status === 'GAME_APPLIED' && r2.status === 'SERIES_COMPLETE' && r2.seriesScore.team_a === 2
    && t1.status === 'GAME_APPLIED' && t2.status === 'DUPLICATE'
    && t5.status === 'SERIES_ALREADY_COMPLETE';
  console.log(ok ? 'T1-FIX VERIFIED' : 'T1-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
