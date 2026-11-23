// Does PRAGMA inside executeMultiple persist for a LATER separate execute() call?
import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:fresh-session-audit-artifacts/fk_session.sqlite' });
await db.execute('CREATE TABLE im (id TEXT PRIMARY KEY)');
await db.execute('CREATE TABLE ev (id TEXT PRIMARY KEY, source_message_id TEXT REFERENCES im(id) ON DELETE SET NULL)');
// simulate migrate.ts: executeMultiple with PRAGMA first
await db.executeMultiple('PRAGMA foreign_keys = ON;');
try {
  await db.execute({ sql: 'INSERT INTO ev (id, source_message_id) VALUES (?, ?)', args: ['e1', 'not-an-inbound-id'] });
  console.log('AFTER executeMultiple PRAGMA: INSERT OK — FK not enforced across statements');
} catch (e: any) {
  console.log('AFTER executeMultiple PRAGMA: FK enforced:', e.message.slice(0, 60));
}
db.close();
