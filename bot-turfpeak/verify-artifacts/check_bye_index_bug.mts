// Verification of suspected "new bug #3": bye partner computed from ARRAY INDEX
// (tournament-commands.ts:2923-2924) — is the bracket pairing actually adjacent
// by index? Pairings for round N are created by generateKnockoutFixtures in a
// deterministic insertion order, but roundFixtures is re-queried with
// ORDER BY f.created_at ASC. Question: does created_at ordering equal bracket
// pairing adjacency?
//
// generateKnockoutFixtures inserts fixtures sequentially in one loop with the
// SAME `now` timestamp for every fixture of the round (single `new Date()`
// captured once per call). SQLite ORDER BY on equal keys is unstable in
// principle; with random UUID PKs the row order after equality is not
// guaranteed to follow insertion order. Also the current-round filter slices
// roundFixtures to currentRoundCode, so adjacency holds only if ordering is
// stable AND complete per round.
//
// Reproduction strategy: create a QUARTER_FINAL round (4 fixtures = 4 pairs?
// 4 fixtures = 8 teams -> pairs (0,1) (2,3)), complete series so that ONE
// fixture of pair (2,3) ends double-loss, then run the seed-collection logic
// path via a direct port of the query + loop, and check WHICH team gets the bye.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { generateKnockoutFixtures, type KnockoutQualifier } from '../src/competition/fixtures.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);

  const teams: Array<[string, string]> = [];
  for (let i = 1; i <= 8; i++) {
    const id = randomUUID();
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, 'T' + i]);
    teams.push([id, 'T' + i]);
  }
  // ranks alternate 1,2,1,2,... -> generateKnockoutFixtures pairs (0,1),(2,3),(4,5),(6,7) as adjacent rotation
  const quals: KnockoutQualifier[] = teams.map(([id, name], i) => ({
    team_id: id, team_name: name,
    group_code: i % 2 === 0 ? 'G' + Math.floor(i / 2) : 'G' + Math.floor(i / 2),
    group_rank: i % 2 === 0 ? 1 : 2,
  }));
  // winners=[T1,T3,T5,T7] (rank1), runners=[T2,T4,T6,T8]; pairing i: winner i vs runner (i+1)%4
  // => matches: T1-T4? wait: winner[0]=T1 vs runner[1]=T4; winner[1]=T3 vs runner[2]=T6;
  //    winner[2]=T5 vs runner[3]=T8; winner[3]=T7 vs runner[0]=T2.
  const { fixtures } = await generateKnockoutFixtures(db, TID, quals);
  console.log('generated pairings (insertion order):');
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i]!;
    const a = teams.find(t => t[0] === f.team_a_id)![1];
    const b = teams.find(t => t[0] === f.team_b_id)![1];
    console.log(`  index ${i}: ${a} vs ${b} (${f.round_code})`);
  }

  // Simulate results: every fixture gets a winner EXCEPT fixture index 2 (T5 vs T8)
  // which ends double-loss (WALKOVER, series COMPLETED no winner). True bracket
  // semantics: T5's partner in the bracket is whoever it would meet next round —
  // but the CODE's semantics is: partner = adjacent INDEX (3), i.e. T7 vs T2's
  // winner. In the code's own model the "pairing slot" IS index adjacency, so
  // the bye should go to the winner of index 3.
  const winnersMap = new Map<string, string>(); // fixture_id -> winner team_id
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i]!;
    if (i === 2) continue; // double-loss
    // winner: team_a for even index, team_b for odd (arbitrary but deterministic)
    winnersMap.set(f.id, i % 2 === 0 ? f.team_a_id : f.team_b_id);
  }
  for (const f of fixtures) {
    const w = winnersMap.get(f.id) ?? null;
    if (w) {
      await db.execute(`UPDATE series SET status='COMPLETED', winner_team_id=?, updated_at=datetime('now') WHERE fixture_id=?`, [w, f.id]);
      await db.execute(`UPDATE fixtures SET status='COMPLETED', updated_at=datetime('now') WHERE id=?`, [f.id]);
    } else {
      await db.execute(`UPDATE series SET status='COMPLETED', winner_team_id=NULL, updated_at=datetime('now') WHERE fixture_id=?`, [f.id]);
      await db.execute(`UPDATE fixtures SET status='WALKOVER', updated_at=datetime('now') WHERE id=?`, [f.id]);
    }
  }

  // Now run the EXACT query + loop from tournament-commands.ts:2865-2938.
  const roundFixturesRes = await db.execute({
    sql: `SELECT f.id AS fixture_id, f.round_code, f.team_a_id, f.team_b_id, f.status,
                 s.winner_team_id, s.status AS series_status,
                 ta.team_name AS team_a_name, tb.team_name AS team_b_name
          FROM fixtures f
          LEFT JOIN series s ON s.fixture_id = f.id
          JOIN teams ta ON f.team_a_id = ta.id
          JOIN teams tb ON f.team_b_id = tb.id
          WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT'
          ORDER BY f.created_at ASC`,
    args: [TID],
  });
  const roundFixtures: any[] = roundFixturesRes.rows.map((r: any) => ({
    fixture_id: String(r.fixture_id), round_code: String(r.round_code || ''),
    status: String(r.status), winner_team_id: r.winner_team_id ? String(r.winner_team_id) : null,
    series_status: r.series_status ? String(r.series_status) : null,
    team_a_name: String(r.team_a_name), team_b_name: String(r.team_b_name),
  }));
  const currentRoundFixtures = roundFixtures.filter((f) => f.round_code === 'QUARTER_FINAL');
  console.log('query order (created_at ASC) after updates:');
  currentRoundFixtures.forEach((f, i) => {
    const wname = f.winner_team_id ? (f.winner_team_id === f.fixture_id ? '' : teams.find(t => t[0] === f.winner_team_id)![1]) : 'DOUBLE-LOSS';
    console.log(`  index ${i}: ${f.team_a_name} vs ${f.team_b_name} -> winner: ${wname}`);
  });

  // NOTE: the update statements set updated_at but created_at is UNCHANGED —
  // all four rows share the SAME created_at (single `now` in generateKnockoutFixtures).
  // So ORDER BY created_at ASC on 4 equal keys -> engine-defined order (typically rowid).
  const seeds: Array<{ team_id: string; team_name: string; from_double_loss_bye: boolean }> = [];
  const byeRecipients: string[] = [];
  for (const f of currentRoundFixtures) {
    if (f.winner_team_id) {
      const winnerName = f.winner_team_id === teams.find(t => t[1] === f.team_a_name)![0] ? f.team_a_name : f.team_b_name;
      seeds.push({ team_id: f.winner_team_id, team_name: winnerName, from_double_loss_bye: false });
    } else if (f.status === 'WALKOVER' && (f.series_status === 'COMPLETED' || f.series_status === null)) {
      const fixtureIndex = currentRoundFixtures.indexOf(f);
      const partner = currentRoundFixtures[fixtureIndex % 2 === 0 ? fixtureIndex + 1 : fixtureIndex - 1];
      if (partner && partner.winner_team_id) {
        const byeTeamName = teams.find(t => t[0] === partner.winner_team_id)![1];
        seeds.push({ team_id: partner.winner_team_id, team_name: byeTeamName, from_double_loss_bye: true });
        byeRecipients.push(byeTeamName);
      }
    }
  }
  console.log('seeds:', seeds.map(s => s.team_name + (s.from_double_loss_bye ? '(bye)' : '')).join(', '));
  console.log('bye recipient per index-adjacency logic:', byeRecipients.join(', ') || 'none');

  // Which team SHOULD get the bye under true bracket semantics? The bracket
  // pairing model in this codebase IS index adjacency for the CURRENT round
  // (match i pairs with match i^1), so if query order == insertion order, the
  // bye goes to the winner of the ADJACENT FIXTURE — which is what the code
  // intends. The suspected bug only fires if query order != insertion order.
  const insertionOrderIds = fixtures.map(f => f.id);
  const queryOrderIds = currentRoundFixtures.map(f => f.fixture_id);
  const orderMatches = JSON.stringify(insertionOrderIds) === JSON.stringify(queryOrderIds);
  console.log('query order == insertion order:', orderMatches);
  db.close();
}
main();
