import { createClient } from '@libsql/client';
import { FlashPeakApp } from '../src/index.js';
import { runMigrations } from '../src/db/migrate.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

async function main() {
  console.log('=== AUDIT TEST: FIX-SYNC-001 (centralGroupJid Synchronization) ===\n');

  const db = createClient({ url: 'file::memory:?cache=shared' });
  await runMigrations(db);

  // Seed organizer identity in DB
  const organizerPhone = '6281234567890';
  const organizerJid = `${organizerPhone}@s.whatsapp.net`;
  const organizerDelegateId = 'del-org-1';

  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: [organizerDelegateId, 'Tournament Organizer', 'ACTIVE', now, now],
  });
  await db.execute({
    sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['wa-org-1', organizerDelegateId, organizerJid, 'PHONE', 1, now],
  });

  // 1. Initialize FlashPeakApp with NO initial centralGroupJid
  const app = new FlashPeakApp({
    db,
    organizerPhone,
    organizerJid,
  });

  console.log('Initial State:');
  console.log(' - app.getCentralGroupJid():', app.getCentralGroupJid());
  console.log(' - commandRouter.getCentralGroupJid():', app.commandRouter.getCentralGroupJid());
  console.log(' - matchdayService.getCentralGroupJid():', app.matchdayService.getCentralGroupJid());

  if (app.getCentralGroupJid() || app.commandRouter.getCentralGroupJid() || app.matchdayService.getCentralGroupJid()) {
    throw new Error('Initial state expected to be empty/undefined');
  }

  // 2. Organizer runs !setgroup in group 1
  const group1Jid = '120363111111111111@g.us';
  const setgroupMsg: NormalizedMessage = {
    message_id: 'msg-setgroup-1',
    chat_id: group1Jid,
    // BUGFIX-TS-002 dry-run alignment: sender_raw_address per the type contract.
    sender_raw_address: organizerJid,
    sender_normalized_address: organizerJid,
    sender_phone: organizerPhone,
    is_group: true,
    text_body: '!setgroup',
    timestamp: new Date(),
  };

  const setgroupRes = await app.handleInboundMessage(setgroupMsg);
  console.log('\n--- Scenario 1: !setgroup in Group 1 ---');
  console.log('Command Response:', setgroupRes.replyText);
  console.log('Updated State:');
  console.log(' - app.getCentralGroupJid():', app.getCentralGroupJid());
  console.log(' - commandRouter.getCentralGroupJid():', app.commandRouter.getCentralGroupJid());
  console.log(' - matchdayService.getCentralGroupJid():', app.matchdayService.getCentralGroupJid());

  if (app.getCentralGroupJid() !== group1Jid ||
      app.commandRouter.getCentralGroupJid() !== group1Jid ||
      app.matchdayService.getCentralGroupJid() !== group1Jid) {
    throw new Error(`Synchronization failed after !setgroup: expected ${group1Jid}`);
  }
  console.log('Result Scenario 1: PASS');

  // 3. Direct app.setCentralGroupJid() update
  const group2Jid = '120363222222222222@g.us';
  console.log('\n--- Scenario 2: Direct app.setCentralGroupJid(group2) ---');
  app.setCentralGroupJid(group2Jid);

  console.log('Updated State:');
  console.log(' - app.getCentralGroupJid():', app.getCentralGroupJid());
  console.log(' - commandRouter.getCentralGroupJid():', app.commandRouter.getCentralGroupJid());
  console.log(' - matchdayService.getCentralGroupJid():', app.matchdayService.getCentralGroupJid());

  if (app.getCentralGroupJid() !== group2Jid ||
      app.commandRouter.getCentralGroupJid() !== group2Jid ||
      app.matchdayService.getCentralGroupJid() !== group2Jid) {
    throw new Error(`Synchronization failed after direct set: expected ${group2Jid}`);
  }
  console.log('Result Scenario 2: PASS');

  // 4. Organizer runs !createtournament in group 3
  // FIX2-GROUP-001: admin commands in a non-official group are now REJECTED
  // (no silent auto-adopt). !setgroup remains the explicit official switch.
  const group3Jid = '120363333333333333@g.us';
  console.log('\n--- Scenario 3: Organizer runs !createtournament in unofficial Group 3 (FIX2-GROUP-001) ---');
  const createMsg: NormalizedMessage = {
    message_id: 'msg-create-1',
    chat_id: group3Jid,
    // BUGFIX-TS-002 dry-run alignment: sender_raw_address per the type contract.
    sender_raw_address: organizerJid,
    sender_normalized_address: organizerJid,
    sender_phone: organizerPhone,
    is_group: true,
    text_body: '!createtournament Flash Peak Winter Cup',
    timestamp: new Date(),
  };

  const createRes = await app.handleInboundMessage(createMsg);
  console.log('Command Handled:', createRes.handled);
  console.log('Response:', createRes.replyText);
  console.log('State (must remain group 2):');
  console.log(' - app.getCentralGroupJid():', app.getCentralGroupJid());
  console.log(' - commandRouter.getCentralGroupJid():', app.commandRouter.getCentralGroupJid());
  console.log(' - matchdayService.getCentralGroupJid():', app.matchdayService.getCentralGroupJid());

  if (!createRes.replyText || !createRes.replyText.includes('grup turnamen resmi')) {
    throw new Error('FIX2-GROUP-001: !createtournament in unofficial group must be rejected with a clear message');
  }
  if (app.getCentralGroupJid() !== group2Jid ||
      app.commandRouter.getCentralGroupJid() !== group2Jid ||
      app.matchdayService.getCentralGroupJid() !== group2Jid) {
    throw new Error(`FIX2-GROUP-001: central group must NOT auto-switch to ${group3Jid}`);
  }
  console.log('Result Scenario 3: PASS (rejected, no auto-adopt)');

  // 5. !setgroup in group 3 remains the explicit way to switch official group
  console.log('\n--- Scenario 4: !setgroup in Group 3 switches official group explicitly ---');
  const setMsg: NormalizedMessage = {
    message_id: 'msg-set-1',
    chat_id: group3Jid,
    // MERGE-ALIGN: pesan dibangun sesuai kontrak NormalizedMessage
    // (sender_raw_address) — field legacy sender_id dihapus oleh PR #3
    // (BUGFIX-TS-002), sehingga fallback sender_id tidak lagi tersedia.
    sender_raw_address: organizerJid,
    sender_normalized_address: organizerJid,
    sender_phone: organizerPhone,
    is_group: true,
    text_body: '!setgroup',
    timestamp: new Date(),
  };
  await app.handleInboundMessage(setMsg);
  if (app.getCentralGroupJid() !== group3Jid ||
      app.commandRouter.getCentralGroupJid() !== group3Jid ||
      app.matchdayService.getCentralGroupJid() !== group3Jid) {
    throw new Error(`Synchronization failed after !setgroup: expected ${group3Jid}`);
  }
  console.log('Result Scenario 4: PASS');

  console.log('\n=== AUDIT CONCLUSION: FIX-SYNC-001 + FIX2-GROUP-001 ===');
  console.log('ALL SYNCHRONIZATION TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
