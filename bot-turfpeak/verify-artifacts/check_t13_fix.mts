// T13 fix check: NL intents / photos from a NON-central group are ignored;
// central group still answers.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { FlashPeakApp } from '../src/index.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
  const app = new FlashPeakApp({ db, organizerPhone: '6281234567890', centralGroupJid: 'central@g.us' });

  const mk = (chat: string, text: string, type = 'TEXT'): NormalizedMessage => ({
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: chat, sender_raw_address: '6281@s.whatsapp.net', sender_normalized_address: '6281@s.whatsapp.net',
    message_type: type as any, text_body: text, caption: null,
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage);

  // NL intent from a foreign group -> ignored (handled=false)
  const r1 = await app.handleInboundMessage(mk('random-group@g.us', '!lihat klasemen grup A'));
  // Photo from a foreign group -> ignored
  const r2 = await app.handleInboundMessage(mk('random-group@g.us', null as any, 'IMAGE'), Buffer.from('x'));
  // NL intent from the central group -> answered (help/unknown-command reply is fine; must be handled)
  const r3 = await app.handleInboundMessage(mk('central@g.us', '!lihat klasemen grup A'));
  // Organizer DM (not a group) still processed
  const r4 = await app.handleInboundMessage(mk('6281234567890@s.whatsapp.net', '!ping'));

  const ok = r1.handled === false && r2.handled === false && r3.handled === true && r4.handled === true;
  console.log('foreign NL intent handled:', r1.handled, '| foreign photo handled:', r2.handled);
  console.log('central NL intent handled:', r3.handled, '| organizer DM handled:', r4.handled);
  console.log(ok ? 'T13-FIX VERIFIED' : 'T13-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
