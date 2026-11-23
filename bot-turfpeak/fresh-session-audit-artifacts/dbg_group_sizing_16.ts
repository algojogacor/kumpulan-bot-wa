// Trace computeGroupSizing(16) + knockout bracket with REAL repo functions (fixed call signature).
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { computeGroupSizing } from '../src/competition/draw.js';
import { generateBalancedRoundRobin, generateKnockoutFixtures, deriveKnockoutQualifiers } from '../src/competition/fixtures.js';

const cfg = computeGroupSizing(16);
console.log('GROUP CONFIG (16 tim):', JSON.stringify(cfg));

const db = createClient({ url: 'file:fresh-session-audit-artifacts/grp16.sqlite' });
await runMigrations(db);
const now = new Date().toISOString();
await db.execute({ sql: `INSERT INTO tournaments (id,name,status,timezone,rules_version,config_json,created_at,updated_at) VALUES ('t16','Cup 16','ACTIVE','Asia/Jakarta','1','{}',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO group_draws (id,tournament_id,status,group_config_json,eligible_team_snapshot_json,algorithm,algorithm_version,commitment_hash,seed_reveal,result_json,next_reveal_index,created_at,completed_at) VALUES ('gd16','t16','COMPLETED',?,'[]','circle','v1','h',NULL,'[]',16,?,?)`, args: [JSON.stringify(cfg), now, now] });

const codes = ['A', 'B', 'C', 'D'];
let teamNo = 1;
for (let gi = 0; gi < cfg.group_sizes.length; gi++) {
  const size = cfg.group_sizes[gi]!;
  const gid = `grp16-${codes[gi]}`;
  await db.execute({ sql: `INSERT INTO groups (id,draw_id,group_code,display_order) VALUES (?,'gd16',?,?)`, args: [gid, codes[gi], gi + 1] });
  for (let pos = 1; pos <= size; pos++) {
    const tid = `t16-${teamNo}`;
    await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES (?,'t16',?,'VERIFIED',?,?)`, args: [tid, `Tim ${teamNo}`, now, now] });
    await db.execute({ sql: `INSERT INTO group_members (group_id,team_id,draw_position) VALUES (?,?,?)`, args: [gid, tid, pos] });
    // standings: distinct points so rank 1..4 deterministic (pos 1..4 in each group)
    await db.execute({ sql: `INSERT INTO standings (tournament_id,group_id,team_id,played,wins,draws,losses,goals_for,goals_against,goal_difference,points,head_to_head_points,computed_at,source_revision) VALUES ('t16',?,?,3,?,0,?,6,3,3,?,'{}',?,'audit16')`, args: [gid, tid, pos === 1 ? 3 : pos === 2 ? 2 : 1, 6 - pos, 9 - (pos - 1) * 3, now] });
    teamNo++;
  }
}

const quals = await deriveKnockoutQualifiers(db, 't16');
console.log(`\nKualifikasi: ${quals.length} tim (top 2 per grup):`);
for (const q of quals) console.log(`  ${q.group_code} rank ${q.group_rank}: Tim ${q.team_id.split('-')[1]}`);

const res = await generateKnockoutFixtures(db, 't16', quals);
console.log(`\nBRACKET ${res.fixtures[0]?.round_code} (${res.fixtures.length} pasangan):`);
for (const f of res.fixtures) {
  const s = res.series.find(x => x.fixture_id === f.id);
  console.log(`  Tim ${f.team_a_id.split('-')[1]} vs Tim ${f.team_b_id.split('-')[1]}  [${s?.format} target ${s?.target_wins}]`);
}
// Round-robin match count sanity per group size
console.log(`\nRR: grup 5 tim = ${generateBalancedRoundRobin([1,2,3,4,5].map(i => ({ team_id: 't'+i, team_name: 'T'+i }))).length} pertandingan; grup 4 tim = ${generateBalancedRoundRobin([1,2,3,4].map(i => ({ team_id: 't'+i, team_name: 'T'+i }))).length} pertandingan`);
db.close();
