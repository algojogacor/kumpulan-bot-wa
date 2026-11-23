import { createClient } from '@libsql/client';

async function main() {
  const dbUrl = process.env.TURSO_DATABASE_URL || 'file:local.sqlite';
  const db = createClient({ url: dbUrl });

  const t = await db.execute('SELECT id, name, status FROM tournaments ORDER BY created_at DESC LIMIT 1');
  console.log('Tournament:', t.rows[0]);

  const groups = await db.execute('SELECT id, group_code FROM groups');
  console.log('Groups:', groups.rows);

  const fixtures = await db.execute(`
    SELECT f.id, f.round_code, g.group_code, ta.team_name as team_a, tb.team_name as team_b, tl.team_name as host, f.status
    FROM fixtures f
    LEFT JOIN groups g ON f.group_id = g.id
    LEFT JOIN teams ta ON f.team_a_id = ta.id
    LEFT JOIN teams tb ON f.team_b_id = tb.id
    LEFT JOIN teams tl ON f.left_side_team_id = tl.id
    WHERE f.stage = 'GROUP'
    ORDER BY g.group_code, f.round_code
  `);

  console.log(`\n=== TOTAL GROUP FIXTURES: ${fixtures.rows.length} ===`);

  const pairCounts = new Map<string, number>();
  const teamMatchCounts = new Map<string, number>();
  const hostCounts = new Map<string, { left: number; right: number }>();

  for (const f of fixtures.rows) {
    const a = String(f.team_a);
    const b = String(f.team_b);
    const host = String(f.host);
    const grp = String(f.group_code);
    const rnd = String(f.round_code);

    console.log(`[Grup ${grp} | ${rnd}] ${a} vs ${b} (Host: ${host})`);

    // Pair (canonical sorted)
    const pair = [a, b].sort().join(' vs ');
    pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);

    // Team matches
    teamMatchCounts.set(a, (teamMatchCounts.get(a) || 0) + 1);
    teamMatchCounts.set(b, (teamMatchCounts.get(b) || 0) + 1);

    // Host counts
    if (!hostCounts.has(a)) hostCounts.set(a, { left: 0, right: 0 });
    if (!hostCounts.has(b)) hostCounts.set(b, { left: 0, right: 0 });

    hostCounts.get(a)!.left += (host === a ? 1 : 0);
    hostCounts.get(a)!.right += (host !== a ? 1 : 0);
    hostCounts.get(b)!.left += (host === b ? 1 : 0);
    hostCounts.get(b)!.right += (host !== b ? 1 : 0);
  }

  console.log('\n=== PAIR ENCOUNTER FREQUENCY (Single vs Double RR Check) ===');
  let hasDuplicates = false;
  for (const [pair, count] of pairCounts.entries()) {
    console.log(` - ${pair}: ${count}x`);
    if (count > 1) hasDuplicates = true;
  }
  console.log(`Any duplicate encounters? ${hasDuplicates ? 'YES (BUG!)' : 'NO (Strict Single Round-Robin)'}`);

  console.log('\n=== MATCHES PLAYED PER TEAM ===');
  for (const [team, count] of teamMatchCounts.entries()) {
    console.log(` - ${team}: ${count} pertandingan`);
  }

  console.log('\n=== HOST (LEFT/RIGHT) BALANCE (FR-COMP-013) ===');
  for (const [team, h] of hostCounts.entries()) {
    const diff = Math.abs(h.left - h.right);
    console.log(` - ${team}: Host/Left = ${h.left}, Away/Right = ${h.right} (Diff = ${diff}) -> ${diff <= 1 ? 'BALANCED (<= 1)' : 'UNBALANCED'}`);
  }
}

main().catch(console.error);
