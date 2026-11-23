// T2 fix check: odd survivor pool (3) no longer throws; bye reported; even pools unchanged.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { generateKnockoutFixtures, type KnockoutQualifier } from '../src/competition/fixtures.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
  const mk = async (n: number) => { const id = randomUUID(); await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, "T" + n]); return { id, q: { team_id: id, team_name: "T" + n, group_code: "G", group_rank: 0 } as KnockoutQualifier }; };

  // Case 1: 3 survivors (rank 1,2,2) — used to throw.
  const a = await mk(1), b = await mk(2), c = await mk(3);
  const quals3 = [
    { ...a.q, group_rank: 1 },
    { ...b.q, group_rank: 2 },
    { ...c.q, group_rank: 2 },
  ];
  const r3 = await generateKnockoutFixtures(db, TID, quals3);
  console.log('case1(3 survivors): fixtures=' + r3.fixtures.length, 'byeTeamId=' + (r3.byeTeamId ? r3.byeTeamId.slice(0, 8) : 'null'), 'round=' + r3.fixtures[0]?.round_code);
  const allTeams3 = r3.fixtures.flatMap(f => [f.team_a_id, f.team_b_id]);
  const noSelfMatch = r3.fixtures.every(f => f.team_a_id !== f.team_b_id);
  const byeIsOneOf3 = r3.byeTeamId ? [a.id, b.id, c.id].includes(r3.byeTeamId) : false;
  const playing = new Set(allTeams3);
  const byeNotPlaying = r3.byeTeamId ? !playing.has(r3.byeTeamId) : false;

  // Case 2: 5 survivors (odd, >3) — FINAL for 1 fixture + bye.
  const ids5 = [] as Awaited<ReturnType<typeof mk>>[];
  for (let i = 0; i < 5; i++) ids5.push(await mk(i + 10));
  const quals5 = ids5.map((x, i) => ({ ...x.q, group_rank: i < 2 ? 1 : 2 }));
  const r5 = await generateKnockoutFixtures(db, TID, quals5);
  console.log('case2(5 survivors): fixtures=' + r5.fixtures.length, 'bye=' + (r5.byeTeamId ? 'yes' : 'null'));

  // Case 3: 4 survivors (even) — unchanged behavior, no bye.
  const ids4 = [] as Awaited<ReturnType<typeof mk>>[];
  for (let i = 0; i < 4; i++) ids4.push(await mk(i + 20));
  const quals4 = ids4.map((x, i) => ({ ...x.q, group_rank: i < 2 ? 1 : 2 }));
  const r4 = await generateKnockoutFixtures(db, TID, quals4);
  console.log('case3(4 survivors): fixtures=' + r4.fixtures.length, 'bye=' + r4.byeTeamId);

  // Case 4: 2 survivors — FINAL, no bye.
  const ids2 = [] as Awaited<ReturnType<typeof mk>>[];
  for (let i = 0; i < 2; i++) ids2.push(await mk(i + 30));
  const quals2 = ids2.map((x, i) => ({ ...x.q, group_rank: i < 1 ? 1 : 2 }));
  const r2 = await generateKnockoutFixtures(db, TID, quals2);
  console.log('case4(2 survivors): fixtures=' + r2.fixtures.length, 'round=' + r2.fixtures[0]?.round_code, 'bye=' + r2.byeTeamId);

  const ok = r3.fixtures.length === 1 && noSelfMatch && byeIsOneOf3 && byeNotPlaying
    && r5.fixtures.length === 2 && r5.byeTeamId !== null
    && r4.fixtures.length === 2 && r4.byeTeamId === null
    && r2.fixtures.length === 1 && r2.fixtures[0]?.round_code === 'FINAL' && r2.byeTeamId === null;
  console.log(ok ? 'T2-FIX VERIFIED' : 'T2-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
