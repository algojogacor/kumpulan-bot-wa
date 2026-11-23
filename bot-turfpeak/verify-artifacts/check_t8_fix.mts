// T8 fix check (code-path level): plain-text 'ok' path is guarded by
// isSenderOrganizer. We verify the guard wiring by constructing the app the
// same way full_flow.test.ts does and staging a pending draft, then sending
// 'ok' from a NON-organizer group member.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { FlashPeakApp } from '../src/index.js';
import { ManualReportSessionManager, type PendingManualReport } from '../src/application/manual-report-session.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);

  const app = new FlashPeakApp({
    db,
    organizerPhone: '6281234567890',
    centralGroupJid: 'g@g.us',
  });

  const mkMsg = (from: string, text: string, type = 'TEXT'): NormalizedMessage => ({
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: 'g@g.us', sender_raw_address: from, sender_normalized_address: from,
    message_type: type as any, text_body: text, caption: null,
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage);

  // Stage a pending manual-report draft as the organizer would.
  const pending: PendingManualReport = {
    fixtureId: 'fx', gameId: 'gm', scoreA: 2, scoreB: 1,
    teamAId: 'ta', teamBId: 'tb', teamAName: 'KA', teamBName: 'KB',
    teamAPlayers: [], teamBPlayers: [], rosterA: [], rosterB: [],
    matchedDetailsA: [], matchedDetailsB: [],
    unassignedGoalsA: 0, unassignedGoalsB: 0,
    notes: null, organizerId: '6281234567890@s.whatsapp.net',
    chatId: 'g@g.us', createdAt: Date.now(), expiresAt: Date.now() + 15 * 60 * 1000,
  } as unknown as PendingManualReport;
  (app as any).manualReportSession.stagePendingReport(pending);

  // Random member types 'ok'
  const r1 = await app.handleInboundMessage(mkMsg('6280000001111@s.whatsapp.net', 'ok'));
  // Organizer types 'ok' — passes the guard (will fail later on fixture lookup, but must NOT show the permission denial)
  const r2 = await app.handleInboundMessage(mkMsg('6281234567890@s.whatsapp.net', 'ok'));

  const memberBlocked = (r1.replyText || '').includes('hanya dapat dilakukan oleh Panitia');
  const orgPassedGuard = !(r2.replyText || '').includes('hanya dapat dilakukan oleh Panitia');
  console.log('member ok ->', (r1.replyText || '').slice(0, 60).replace(/\n/g, ' '));
  console.log('organizer ok ->', (r2.replyText || '').slice(0, 60).replace(/\n/g, ' '));
  const ok = memberBlocked && orgPassedGuard;
  console.log(ok ? 'T8-FIX VERIFIED' : 'T8-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
