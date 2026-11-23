// Check how libsql returns aliased columns: named or positional?
import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:fresh-session-audit-artifacts/group_fresh.sqlite' });
const r = await db.execute(`SELECT f.id, ta.team_name AS an, tb.team_name AS bn, ta.delegate_id AS da FROM fixtures f JOIN teams ta ON f.team_a_id=ta.id JOIN teams tb ON f.team_b_id=tb.id WHERE f.stage='GROUP' AND f.status='SCHEDULED' LIMIT 1`);
const row: any = r.rows[0];
console.log('keys sample:', Object.keys(row).slice(0, 8));
console.log('row.an =', row.an, '| row[1] =', row[1], '| row.da =', row.da, '| row[3] =', row[3]);
db.close();
