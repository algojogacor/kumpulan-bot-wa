import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:fresh-session-audit-artifacts/group_fresh.sqlite' });
const d = await db.execute('SELECT id, display_name FROM delegates');
for (const row of d.rows as any[]) console.log('delegate:', row.id, row.display_name);
db.close();
