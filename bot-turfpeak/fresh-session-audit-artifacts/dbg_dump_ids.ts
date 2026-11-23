import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:fresh-session-audit-artifacts/group_fresh.sqlite' });
const r = await db.execute('SELECT raw_address, delegate_id FROM whatsapp_identities');
for (const row of r.rows as any[]) console.log('id:', row.raw_address, '->', row.delegate_id);
const t = await db.execute('SELECT team_name, delegate_id, registration_status FROM teams');
for (const row of t.rows as any[]) console.log('team:', row.team_name, '->', row.delegate_id, row.registration_status);
db.close();
