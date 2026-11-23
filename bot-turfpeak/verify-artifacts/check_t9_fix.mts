// T9 fix check: text-only '!kogame <fixture>' reaches the router status handler;
// photo + '!kogame' caption still runs the KO evidence pipeline.
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

  const app = new FlashPeakApp({ db, organizerPhone: '6281234567890', centralGroupJid: 'g@g.us' });

  const mkMsg = (text: string, caption?: string, type = 'TEXT'): NormalizedMessage => ({
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: 'g@g.us',
    sender_raw_address: '6281234567890@s.whatsapp.net',
    sender_normalized_address: '6281234567890@s.whatsapp.net',
    message_type: type as any, text_body: text, caption: caption ?? null,
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage);

  // Text-only '!kogame' with a (bogus) fixture arg: must reach the router
  // handler -> "Series knockout tidak ditemukan untuk fixture ..." (status
  // lookup miss), NOT the canned photo instruction.
  const r1 = await app.handleInboundMessage(mkMsg('!kogame bogus-fixture'));
  const statusLookupReached = (r1.replyText || '').includes('Series knockout tidak ditemukan') || (r1.replyText || '').includes('STATUS SERIES');

  // Text-only bare '!kogame': router help text (cara melapor), not the photo canned reply.
  const r2 = await app.handleInboundMessage(mkMsg('!kogame'));
  const helpReached = (r2.replyText || '').includes('CARA MELAPORKAN HASIL GAME KNOCKOUT');

  // Photo + caption '!kogame': still intercepted by the KO evidence pipeline
  // (here: AI not configured -> that specific reply).
  const r3 = await app.handleInboundMessage(mkMsg('!kogame', '!kogame', 'IMAGE'), Buffer.from('fake'));
  const photoIntercepted = (r3.replyText || '').includes('Tidak ada pertandingan knockout aktif') || (r3.replyText || '').includes('Pipeline AI belum terkonfigurasi') || (r3.replyText || '').includes('Series knockout tidak ditemukan');

  console.log('text !kogame <id>:', (r1.replyText || '').slice(0, 70).replace(/\n/g, ' '));
  console.log('text !kogame     :', (r2.replyText || '').slice(0, 70).replace(/\n/g, ' '));
  console.log('photo !kogame    :', (r3.replyText || '').slice(0, 70).replace(/\n/g, ' '));
  const ok = statusLookupReached && helpReached && photoIntercepted;
  console.log(ok ? 'T9-FIX VERIFIED' : 'T9-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
