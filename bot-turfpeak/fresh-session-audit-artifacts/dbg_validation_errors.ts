// Dump the exact validation errors for the draft by re-running validateMatchReport.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
const db = createClient({ url: 'file:fresh-session-audit-artifacts/group_fresh.sqlite' });
// find latest report_version
const v = await db.execute('SELECT id, fixture_id FROM report_versions ORDER BY created_at DESC LIMIT 1');
const row = v.rows[0] as any;
const vid = String(row.id ?? row[0]);
const fid = String(row.fixture_id ?? row[1]);
const f = await db.execute({ sql: 'SELECT team_a_id, team_b_id FROM fixtures WHERE id=?', args: [fid] });
const frow = f.rows[0] as any;
const ta = String(frow.team_a_id ?? frow[0]);
const tb = String(frow.team_b_id ?? frow[1]);
const g = await db.execute({ sql: 'SELECT id FROM games WHERE fixture_id=?', args: [fid] });
const gid = String((g.rows[0] as any).id ?? (g.rows[0] as any)[0]);
const rosterA = await db.execute({ sql: `SELECT nickname_raw FROM players WHERE team_id=? AND status='ACTIVE' ORDER BY roster_slot ASC`, args: [ta] });
const rosterB = await db.execute({ sql: `SELECT nickname_raw FROM players WHERE team_id=? AND status='ACTIVE' ORDER BY roster_slot ASC`, args: [tb] });
const nicksA = rosterA.rows.map((r: any) => String(r.nickname_raw ?? r[0]));
const nicksB = rosterB.rows.map((r: any) => String(r.nickname_raw ?? r[0]));
const { validateMatchReport } = await import('../src/reports/validation.js');
const players = (nicks: string[], goals: number[]) => nicks.map((n, i) => ({
  nickname_raw: n, rating: [8.0, 9.1, 8.0, 7.5, 7.2][i] ?? 7, goals: goals[i] ?? 0,
  assists: 0, passes: 8, defense_raw: 2, goalkeeper_saves: i === 0 ? 5 : null,
}));
const val = await validateMatchReport(db, {
  fixture_id: fid, game_id: gid, team_a_id: ta, team_b_id: tb,
  team_a_score: 3, team_b_score: 1,
  team_a_players: players(nicksA.filter(n => !n.endsWith('S1')), [0, 2, 1, 0, 0]),
  team_b_players: players(nicksB.filter(n => !n.endsWith('S1')), [0, 1, 0, 0, 0]),
});
console.log('isValid:', val.isValid);
console.log('errors:', val.errors);
console.log('warnings:', val.warnings);
db.close();
