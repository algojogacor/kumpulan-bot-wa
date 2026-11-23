// T5 fix check: !kores path (allow_completed_series) can re-record a completed
// series and the series recomputes; photo pipeline still rejects completed.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { generateKnockoutFixtures, type KnockoutQualifier } from '../src/competition/fixtures.js';
import { recordSeriesGameResult, getSeriesByFixture } from '../src/competition/series.js';
import { applyKoGameEvidence } from '../src/application/ko-evidence-pipeline.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
  const mk = async (n: number) => { const id = randomUUID(); await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, 'T' + n]); return id; };
  const tA = await mk(1), tB = await mk(2), tC = await mk(3), tD = await mk(4);
  const quals: KnockoutQualifier[] = [
    { team_id: tA, team_name: 'A', group_code: 'A', group_rank: 1 },
    { team_id: tB, team_name: 'B', group_code: 'B', group_rank: 2 },
    { team_id: tC, team_name: 'C', group_code: 'C', group_rank: 1 },
    { team_id: tD, team_name: 'D', group_code: 'D', group_rank: 2 },
  ];
  const { fixtures } = await generateKnockoutFixtures(db, TID, quals);
  const f = fixtures.find(fx => (fx.team_a_id === tA && fx.team_b_id === tD) || (fx.team_a_id === tD && fx.team_b_id === tA))!;
  const series = (await getSeriesByFixture(db, f.id))!;

  // Complete 2-0 for team A.
  await recordSeriesGameResult(db, { series_id: series.id, game_number: 1, team_a_score: 2, team_b_score: 0 });
  await recordSeriesGameResult(db, { series_id: series.id, game_number: 2, team_a_score: 3, team_b_score: 1 });
  const after = await getSeriesByFixture(db, f.id);
  console.log('after completion:', after!.status, after!.team_a_game_wins + '-' + after!.team_b_game_wins, 'winner=' + (after!.winner_team_id === tA ? 'A' : after!.winner_team_id === tD ? 'D' : 'other'));

  // Organizer re-record game 2 as a B win (1-3) — allowed now.
  const rec = await recordSeriesGameResult(db, { series_id: series.id, game_number: 2, team_a_score: 1, team_b_score: 3, allow_completed_series: true });
  const after2 = await getSeriesByFixture(db, f.id);
  console.log('after !kores re-record:', after2!.status, after2!.team_a_game_wins + '-' + after2!.team_b_game_wins, 'is_series_complete=' + rec.is_series_complete);

  // Re-record made the series IN_PROGRESS 1-1 — a new photo now legitimately
  // completes it again (the reopened state is live). Complete it 2-1 via photo:
  const photo = await applyKoGameEvidence(db, { fixtureId: f.id, teamAScore: 2, teamBScore: 1, submittedByDelegateId: null });
  const after3 = await getSeriesByFixture(db, f.id);
  console.log('photo-after-reopen:', photo.status, 'series:', after3!.team_a_game_wins + '-' + after3!.team_b_game_wins);

  // Photo pipeline on a COMPLETED series still IGNORES (second fixture, never re-opened).
  const f2 = fixtures.find(fx => fx.id !== f.id)!;
  const series2 = (await getSeriesByFixture(db, f2.id))!;
  await recordSeriesGameResult(db, { series_id: series2.id, game_number: 1, team_a_score: 2, team_b_score: 0 });
  await recordSeriesGameResult(db, { series_id: series2.id, game_number: 2, team_a_score: 2, team_b_score: 0 });
  const photo2 = await applyKoGameEvidence(db, { fixtureId: f2.id, teamAScore: 5, teamBScore: 0, submittedByDelegateId: null });
  console.log('photo-on-completed(series2):', photo2.status);

  const ok = after!.status === 'COMPLETED' && after2!.status === 'IN_PROGRESS' && after2!.team_a_game_wins === 1 && after2!.team_b_game_wins === 1
    && photo.status === 'SERIES_COMPLETE' && after3!.team_a_game_wins === 2 && after3!.team_b_game_wins === 1
    && photo2.status === 'SERIES_ALREADY_COMPLETE';
  console.log(ok ? 'T5-FIX VERIFIED' : 'T5-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
