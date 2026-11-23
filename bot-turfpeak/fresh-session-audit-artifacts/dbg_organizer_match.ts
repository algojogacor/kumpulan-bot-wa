// Why did claimwo take the ORGANIZER path? Check isSenderOrganizer against the winJid.
import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:fresh-session-audit-artifacts/group_fresh.sqlite' });
const wi = await db.execute(`SELECT raw_address FROM whatsapp_identities ORDER BY created_at ASC`);
for (const r of wi.rows as any[]) console.log('identity:', r.raw_address ?? r[0]);
// app config: organizerJid = 628999000001@s.whatsapp.net
db.close();
