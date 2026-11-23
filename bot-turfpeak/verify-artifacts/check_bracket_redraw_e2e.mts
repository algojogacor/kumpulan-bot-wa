// BRACKET-REDRAW end-to-end via the !startknockout command handler:
// QF -> SF (re-draw) -> Final, including a D-032 double-loss bye at SF,
// driven through the CommandRouter like production.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { registerTournamentCommands } from '../src/application/tournament-commands.js';
import { CommandRouter } from '../src/whatsapp/router.js';
import { IdentityResolver } from '../src/identity/resolver.js';
import { getSeriesByFixture } from '../src/competition/series.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'E2E Redraw', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);

  const resolver = new IdentityResolver(db);
  const router = new CommandRouter({ centralGroupJid: 'g@g.us', organizerPhone: '6281234567890', identityResolver: resolver });
  registerTournamentCommands(router, {
    db, identityResolver: resolver,
    manualReportSession: undefined as any, onboardingService: undefined as any, matchdayService: undefined as any,
    woClaimSession: undefined,
  } as any);

  const ORG = '6281234567890@s.whatsapp.net';
  const mk = (text: string): NormalizedMessage => ({
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: 'g@g.us', sender_raw_address: ORG, sender_normalized_address: ORG,
    message_type: 'TEXT', text_body: text, caption: null,
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage);

  // Build groups + standings so deriveKnockoutQualifiers works: 2 groups x 2 qualifiers.
  const drawId = randomUUID();
  await db.execute(`INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at) VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fy', '1', datetime('now'))`, [drawId, TID]);
  const nameOf = new Map<string, string>();
  const teamIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const id = randomUUID();
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, 'Tim ' + i]);
    nameOf.set(id, 'Tim ' + i);
    teamIds.push(id);
  }
  // groups A and B: teams 1,2 in A; 3,4 in B. Standings: rank1 = 1 & 3, rank2 = 2 & 4.
  const grpA = randomUUID(), grpB = randomUUID();
  await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`, [grpA, drawId]);
  await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'B', 2)`, [grpB, drawId]);
  await db.execute(`INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, 1)`, [grpA, teamIds[0]]);
  await db.execute(`INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, 2)`, [grpA, teamIds[1]]);
  await db.execute(`INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, 1)`, [grpB, teamIds[2]]);
  await db.execute(`INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, 2)`, [grpB, teamIds[3]]);
  // group-stage game: rank1 beats rank2 in each group (so rank1/rank2 differ).
  const mkGame = async (grp: string, a: string, b: string, sa: number, sb: number, winner: string) => {
    const fx = randomUUID();
    await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'GROUP', ?, 'MD1', ?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`, [fx, TID, grp, a, b, a]);
    await db.execute(`INSERT INTO games (id, fixture_id, game_number, status, team_a_score, team_b_score, winner_team_id, is_draw, is_walkover, walkover_type, evidence_status, created_at, updated_at) VALUES (?, ?, 1, 'COMPLETED', ?, ?, ?, 0, 0, 'NONE', 'VERIFIED', datetime('now'), datetime('now'))`, [randomUUID(), fx, sa, sb, winner]);
  };
  await mkGame(grpA, teamIds[0], teamIds[1], 2, 0, teamIds[0]);
  await mkGame(grpB, teamIds[2], teamIds[3], 2, 0, teamIds[2]);

  // 1) !startknockout -> SEMI_FINAL (2 fixtures: winner A vs runner B, winner B vs runner A)
  const r1 = await router.handleMessage(mk('!startknockout'));
  const sfRes = await db.execute(`SELECT f.id, f.round_code, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id=? AND f.stage='KNOCKOUT' AND f.round_code='SEMI_FINAL'`, [TID]);
  const semis = sfRes.rows as any[];
  console.log('startknockout #1:', r1?.success ? 'OK' : 'FAIL', '| semis:', semis.length);
  semis.forEach(s => console.log('  SF:', nameOf.get(String(s.team_a_id)), 'vs', nameOf.get(String(s.team_b_id))));
  const step1Ok = r1?.success === true && semis.length === 2;

  // 2) Complete BOTH semis with winners (team_a of each) -> !startknockout -> FINAL
  for (const s of semis) {
    const fid = String(s.id);
    const series = (await getSeriesByFixture(db, fid))!;
    const { recordSeriesGameResult } = await import('../src/competition/series.js');
    await recordSeriesGameResult(db, { series_id: series.id, game_number: 1, team_a_score: 2, team_b_score: 0 });
    await recordSeriesGameResult(db, { series_id: series.id, game_number: 2, team_a_score: 2, team_b_score: 0 });
    await db.execute(`UPDATE fixtures SET status='COMPLETED', updated_at=datetime('now') WHERE id=?`, [fid]);
  }
  const r2 = await router.handleMessage(mk('!startknockout'));
  const finRes = await db.execute(`SELECT f.id, f.round_code, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id=? AND f.stage='KNOCKOUT' AND f.round_code='FINAL'`, [TID]);
  const finals = finRes.rows as any[];
  console.log('startknockout #2:', r2?.success ? 'OK' : 'FAIL: ' + (r2?.responseText || '').slice(0, 60));
  finals.forEach(f => console.log('  FINAL:', nameOf.get(String(f.team_a_id)), 'vs', nameOf.get(String(f.team_b_id))));
  const step2Ok = r2?.success === true && finals.length === 1 && finals[0].team_a_id !== finals[0].team_b_id;

  // 3) Complete FINAL -> tournament COMPLETED (champion)
  const fid = String(finals[0].id);
  const series = (await getSeriesByFixture(db, fid))!;
  const { recordSeriesGameResult } = await import('../src/competition/series.js');
  await recordSeriesGameResult(db, { series_id: series.id, game_number: 1, team_a_score: 3, team_b_score: 0 });
  await recordSeriesGameResult(db, { series_id: series.id, game_number: 2, team_a_score: 3, team_b_score: 0 });
  await recordSeriesGameResult(db, { series_id: series.id, game_number: 3, team_a_score: 3, team_b_score: 0 });
  await db.execute(`UPDATE fixtures SET status='COMPLETED', updated_at=datetime('now') WHERE id=?`, [fid]);
  const finSeries = await db.execute(`SELECT s.status, s.winner_team_id, f.status AS fixture_status FROM series s JOIN fixtures f ON f.id = s.fixture_id WHERE s.fixture_id = ?`, [fid]);
  const fs = finSeries.rows[0] as any;
  console.log('after FINAL (BO5 3-0): series', String(fs.status), '| fixture', String(fs.fixture_status), '| winner', nameOf.get(String(fs.winner_team_id)));
  const finSeriesOk = String(fs.status) === 'COMPLETED' && String(fs.fixture_status) === 'COMPLETED' && fs.winner_team_id !== null;

  // 4) Fresh scenario for odd-pool + bye through the HANDLER: QF with 8 teams,
  //    one semi double-loss -> 3 survivors at the next !startknockout.
  const TID2 = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'E2E Bye', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now', '+1 hour'), datetime('now', '+1 hour'))`, [TID2]);
  const ids2: string[] = [];
  const nameOf2 = new Map<string, string>();
  for (let i = 1; i <= 8; i++) {
    const id = randomUUID();
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID2, 'BT' + i]);
    nameOf2.set(id, 'BT' + i); ids2.push(id);
  }
  const quals = ids2.map((id, i) => ({ team_id: id, team_name: nameOf2.get(id)!, group_code: 'G' + Math.floor(i / 2), group_rank: i % 2 === 0 ? 1 : 2 }));
  const { generateKnockoutFixtures } = await import('../src/competition/fixtures.js');
  const qf = await generateKnockoutFixtures(db, TID2, quals);
  // complete 3 fixtures with winners; fixture 0 double-loss
  for (let i = 0; i < qf.fixtures.length; i++) {
    const f = qf.fixtures[i]!;
    const ser = (await getSeriesByFixture(db, f.id))!;
    if (i === 0) {
      await db.execute(`UPDATE series SET status='COMPLETED', winner_team_id=NULL, updated_at=datetime('now') WHERE id=?`, [ser.id]);
      await db.execute(`UPDATE fixtures SET status='WALKOVER', updated_at=datetime('now') WHERE id=?`, [f.id]);
    } else {
      const { recordSeriesGameResult } = await import('../src/competition/series.js');
      await recordSeriesGameResult(db, { series_id: ser.id, game_number: 1, team_a_score: 2, team_b_score: 0 });
      await recordSeriesGameResult(db, { series_id: ser.id, game_number: 2, team_a_score: 2, team_b_score: 0 });
      await db.execute(`UPDATE fixtures SET status='COMPLETED', updated_at=datetime('now') WHERE id=?`, [f.id]);
    }
  }
  const r3 = await router.handleMessage(mk('!startknockout'));
  const sf2 = await db.execute(`SELECT f.id, f.round_code, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id=? AND f.stage='KNOCKOUT' AND f.round_code='SEMI_FINAL'`, [TID2]);
  const semis2 = sf2.rows as any[];
  console.log('QF w/ double-loss -> startknockout:', r3?.success ? 'OK' : 'FAIL: ' + (r3?.responseText || '').slice(0, 80));
  console.log('  reply snippet:', (r3?.responseText || '').slice(0, 110).replace(/\n/g, ' '));
  const nextKo = await db.execute(`SELECT f.id, f.round_code, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id=? AND f.stage='KNOCKOUT' AND f.round_code IN ('SEMI_FINAL','FINAL') AND f.status='SCHEDULED'`, [TID2]);
  const nextFixtures = nextKo.rows as any[];
  nextFixtures.forEach(x => console.log('  next round:', x.round_code, ':', nameOf2.get(String(x.team_a_id)), 'vs', nameOf2.get(String(x.team_b_id))));
  // 3 unique survivors (winners of fixtures 1-3; bye recipient is fixture 1's
  // winner, already counted) -> ODD pool -> per T2: 1 FINAL fixture + 1 bye.
  const step3Ok = r3?.success === true
    && nextFixtures.length === 1
    && String(nextFixtures[0].round_code) === 'FINAL'
    && nextFixtures[0].team_a_id !== nextFixtures[0].team_b_id
    && (r3?.responseText || '').includes('DRAW ULANG');

  const ok = step1Ok && step2Ok && finSeriesOk && step3Ok;
  console.log(ok ? 'BRACKET-REDRAW E2E VERIFIED' : 'BRACKET-REDRAW E2E FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
