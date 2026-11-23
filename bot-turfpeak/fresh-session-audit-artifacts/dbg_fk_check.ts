// FK check: does ko_game_evidence.source_message_id accept an arbitrary message key?
import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:fresh-session-audit-artifacts/fk_check.sqlite' });
await db.execute('CREATE TABLE im (id TEXT PRIMARY KEY)');
await db.execute('CREATE TABLE ev (id TEXT PRIMARY KEY, source_message_id TEXT REFERENCES im(id) ON DELETE SET NULL)');
await db.execute('PRAGMA foreign_keys = ON');
try {
  await db.execute({ sql: 'INSERT INTO ev (id, source_message_id) VALUES (?, ?)', args: ['e1', 'not-an-inbound-id'] });
  console.log('INSERT OK — FK NOT enforced');
} catch (e: any) {
  console.log('INSERT FAILED — FK enforced:', e.message);
}
db.close();
