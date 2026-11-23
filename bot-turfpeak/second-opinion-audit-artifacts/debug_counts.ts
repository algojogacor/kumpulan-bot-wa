/** Debug: hitung pemain per tim & fixture round_code — kenapa 36 pemain & 12 fixture? */
import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../src/db/migrate.js';
import { createApp, type FlashPeakApp } from '../src/index.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';
import type { SendOptions } from '../src/whatsapp/types.js';

class MockSender {
  public sent: any[] = [];
  async sendText(chatId: string, text: string, options?: SendOptions): Promise<string> { return 'k'; }
  async sendQuote(chatId: string, text: string, q: any, o?: SendOptions): Promise<string> { return 'k'; }
}
class MockRouter {
  public calls: any[] = [];
  async execute<T>(req: any): Promise<T> {
    this.calls.push(req.task);
    return { raw_text: '{}', parsed_json: undefined, telemetry: {} } as unknown as T;
  }
}
function textMsg(senderJid: string, chatId: string, text: string): NormalizedMessage {
  return {
    id: randomUUID(), provider_message_key: randomUUID(), chat_id: chatId,
    sender_raw_address: senderJid, sender_normalized_address: senderJid, address_type: 'JID',
    is_from_me: false, participant: senderJid, push_name: 'S',
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
    message_type: 'TEXT', text_body: text, caption: null, reply_to_key: null,
    quoted_participant: null, quoted_text: null, raw_message: {} as any,
  } as NormalizedMessage;
}

async function main() {
  const db = createClient({ url: 'file::memory:?cache=shared' });
  await runMigrations(db);
  const orgJid = '6289999999999@s.whatsapp.net';
  const groupJid = '120363012345678901@g.us';
  const app: FlashPeakApp = createApp({
    db, providerRouter: new MockRouter() as any, sender: new MockSender() as any,
    centralGroupJid: groupJid, organizerJid: orgJid, organizerPhone: '6289999999999',
  });
  await app.handleInboundMessage(textMsg(orgJid, groupJid, '!createtournament Cup'));
  const teams = ['Alpha FC', 'Beta FC', 'Gamma FC', 'Delta FC', 'Epsilon FC', 'Zeta FC', 'Eta FC', 'Theta FC'];
  for (const t of teams) await app.handleInboundMessage(textMsg(orgJid, groupJid, `!addteam ${t}`));
  const r1 = await app.handleInboundMessage(textMsg(orgJid, groupJid, '!roster Alpha FC GK: GkA | Inti: P1, P2, P3, P4 | Cadangan: S1'));
  console.log('Alpha reply ok:', /BERHASIL DIDAFTARKAN/.test(r1?.replyText || ''));
  for (const t of teams.slice(1)) {
    const gk = t[0].toLowerCase() + 'gk';
    const rr = await app.handleInboundMessage(textMsg(orgJid, groupJid, `!roster ${t} GK: ${gk} | Inti: ${t[0]}1, ${t[0]}2, ${t[0]}3, ${t[0]}4`));
    console.log(t, 'ok:', /BERHASIL DIDAFTARKAN/.test(rr?.replyText || ''), (rr?.replyText || '').slice(0, 60));
  }
  const per = await db.execute('SELECT team_id, COUNT(*) c FROM players GROUP BY team_id ORDER BY c DESC');
  for (const row of per.rows) console.log('team players:', Number(row[1]));
  const tot = await db.execute('SELECT COUNT(*) c FROM players');
  console.log('TOTAL players:', Number(tot.rows[0][0]));
  await app.handleInboundMessage(textMsg(orgJid, groupJid, '!draw'));
  const fx = await db.execute("SELECT round_code, COUNT(*) c FROM fixtures GROUP BY round_code ORDER BY round_code");
  for (const row of fx.rows) console.log('fixtures:', String(row[0]), Number(row[1]));
  const totFx = await db.execute('SELECT COUNT(*) c FROM fixtures');
  console.log('TOTAL fixtures:', Number(totFx.rows[0][0]));
  process.exit(0);
}
main();
