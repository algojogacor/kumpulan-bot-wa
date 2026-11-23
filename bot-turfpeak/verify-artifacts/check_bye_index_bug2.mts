// Probe 2: stress the equality-ordering assumption with MANY rounds and many
// runs — force SQLite to return equal-created_at rows in a different physical
// order by re-inserting round-2 fixtures BETWEEN round-1 insertions (simulating
// real interleaved timestamps), and by running the query repeatedly with an
// index hint absent. Also test the ROUND MIXING case: query has NO round filter
// (WHERE stage='KNOCKOUT' only); if two rounds share the same created_at
// second, .filter(round_code===current) preserves order but adjacency indices
// are per-round so that part is safe. The real risk is WITHIN-round order.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { generateKnockoutFixtures, type KnockoutQualifier } from '../src/competition/fixtures.js';

async function main() {
  let mismatches = 0;
  const RUNS = 30;
  for (let run = 0; run < RUNS; run++) {
    const db = createClient({ url: ':memory:' });
    await runMigrations(db);
    const TID = randomUUID();
    await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
    const mk = async (n: number) => { const id = randomUUID(); await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, 'T' + n]); return id; };
    const ids: string[] = [];
    for (let i = 1; i <= 8; i++) ids.push(await mk(i));
    const quals: KnockoutQualifier[] = ids.map((id, i) => ({ team_id: id, team_name: 'T' + (i + 1), group_code: 'G' + Math.floor(i / 2), group_rank: i % 2 === 0 ? 1 : 2 }));
    const { fixtures } = await generateKnockoutFixtures(db, TID, quals);
    // Simulate OUT-OF-ORDER physical insertion is impossible (rows already in),
    // but simulate the equality by checking: does ORDER BY created_at ASC with
    // all-equal values return rowid order consistently?
    const res = await db.execute(`SELECT f.id FROM fixtures f WHERE f.tournament_id = ? AND f.stage='KNOCKOUT' ORDER BY f.created_at ASC`, [TID]);
    const queryIds = res.rows.map((r: any) => String(r.id));
    const insertIds = fixtures.map(f => f.id);
    if (JSON.stringify(queryIds) !== JSON.stringify(insertIds)) {
      mismatches++;
      if (mismatches <= 2) {
        console.log(`run ${run}: ORDER MISMATCH`);
        console.log('  insertion:', insertIds.map(x => x.slice(0, 6)).join(' '));
        console.log('  query    :', queryIds.map(x => x.slice(0, 6)).join(' '));
      }
    }
    db.close();
  }
  console.log(`${RUNS} runs, ${mismatches} ordering mismatches (equal created_at keys)`);
  console.log(mismatches > 0
    ? 'SUSPECTED BUG #3 CONFIRMED as a real (if rare) ordering hazard: index-adjacency assumes insertion order, but ORDER BY on equal created_at is engine-defined and CAN diverge.'
    : 'SUSPECTED BUG #3 NOT reproduced dynamically: with all-equal created_at, SQLite consistently returned insertion (rowid) order in this environment. Structural risk remains (ordering on equal keys is not contractual), and the redesign removes the assumption entirely.');
}
main();
