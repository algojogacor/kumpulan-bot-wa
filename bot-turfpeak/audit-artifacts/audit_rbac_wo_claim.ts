import { createClient } from '@libsql/client';
import { FlashPeakApp } from '../src/index.js';
import { runMigrations } from '../src/db/migrate.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

async function main() {
  console.log('=== AUDIT TEST: FIX-RBAC-001 (Delegate WO Claim Staging & Organizer Direct Flow) ===\n');

  const db = createClient({ url: 'file::memory:?cache=shared' });
  await runMigrations(db);

  const now = new Date().toISOString();
  const organizerPhone = '6281234567890';
  const organizerJid = `${organizerPhone}@s.whatsapp.net`;
  const delegateAPhone = '6281111111111';
  const delegateAJid = `${delegateAPhone}@s.whatsapp.net`;
  const randomUserPhone = '6289999999999';
  const randomUserJid = `${randomUserPhone}@s.whatsapp.net`;
  const centralGroupJid = '120363000000000001@g.us';

  // Seed organizer
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: ['del-org', 'Tournament Admin', 'ACTIVE', now, now],
  });
  await db.execute({
    sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['wa-org', 'del-org', organizerJid, 'PHONE', 1, now],
  });

  // Seed delegate A
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: ['del-a', 'Captain Garuda', 'ACTIVE', now, now],
  });
  await db.execute({
    sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['wa-del-a', 'del-a', delegateAJid, 'PHONE', 1, now],
  });

  // Seed tournament
  const tId = 'tourney-rbac-1';
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [tId, 'Flash Peak League 2026', 'ACTIVE', '1.0', '{}', now, now],
  });

  // Seed draw & group
  await db.execute({
    sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at)
          VALUES ('draw-1', ?, 'COMPLETED', '{}', '[]', 'CRYPTO_RANDOM', '1.0', ?)`,
    args: [tId, now],
  });
  const gId = 'group-a';
  await db.execute({
    sql: `INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, 'draw-1', 'A', 1)`,
    args: [gId],
  });

  // Seed teams (del-a owns team-a)
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'VERIFIED', ?, ?)`,
    args: ['team-a', tId, 'Garuda FC', 'del-a', now, now],
  });
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', ?, ?)`,
    args: ['team-b', tId, 'Singa FC', now, now],
  });

  await db.execute({
    sql: `INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, 'team-a', 1), (?, 'team-b', 2)`,
    args: [gId, gId],
  });

  await db.execute({
    sql: `INSERT INTO standings (tournament_id, group_id, team_id, played, wins, draws, losses, goals_for, goals_against, goal_difference, points, computed_at, source_revision)
          VALUES (?, ?, 'team-a', 0, 0, 0, 0, 0, 0, 0, 0, ?, 'rev-1'),
                 (?, ?, 'team-b', 0, 0, 0, 0, 0, 0, 0, 0, ?, 'rev-1')`,
    args: [tId, gId, now, tId, gId, now],
  });

  // Fixture 1
  const fix1Id = 'fix-wo-1';
  await db.execute({
    sql: `INSERT INTO fixtures (id, tournament_id, group_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'GROUP', 'R1', 'team-a', 'team-b', 'team-a', 'SCHEDULED', ?, ?)`,
    args: [fix1Id, tId, gId, now, now],
  });
  await db.execute({
    sql: `INSERT INTO games (id, fixture_id, game_number, status, is_walkover, is_draw, evidence_status, created_at, updated_at)
          VALUES ('game-1', ?, 1, 'SCHEDULED', 0, 0, 'PENDING', ?, ?)`,
    args: [fix1Id, now, now],
  });

  // Fixture 2
  const fix2Id = 'fix-wo-2';
  await db.execute({
    sql: `INSERT INTO fixtures (id, tournament_id, group_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'GROUP', 'R2', 'team-a', 'team-b', 'team-a', 'SCHEDULED', ?, ?)`,
    args: [fix2Id, tId, gId, now, now],
  });
  await db.execute({
    sql: `INSERT INTO games (id, fixture_id, game_number, status, is_walkover, is_draw, evidence_status, created_at, updated_at)
          VALUES ('game-2', ?, 1, 'SCHEDULED', 0, 0, 'PENDING', ?, ?)`,
    args: [fix2Id, now, now],
  });

  const app = new FlashPeakApp({
    db,
    organizerPhone,
    organizerJid,
    centralGroupJid,
  });

  const sendMsg = async (senderJid: string, senderPhone: string, text: string) => {
    const msg: NormalizedMessage = {
      message_id: `msg-${Date.now()}-${Math.random()}`,
      chat_id: centralGroupJid,
      sender_id: senderJid,
      sender_phone: senderPhone,
      sender_raw_address: senderJid,
      is_group: true,
      text_body: text,
      timestamp: new Date(),
    };
    return app.handleInboundMessage(msg);
  };

  // Test 1: Random user runs !claimwo -> rejected
  console.log('--- Test 1: Random user runs !claimwo (Unauthorized) ---');
  const res1 = await sendMsg(randomUserJid, randomUserPhone, `!claimwo ${fix1Id} Singa FC Lawan tidak hadir`);
  console.log(res1.replyText);
  if (!res1.replyText?.includes('Hanya panitia atau delegasi')) {
    throw new Error('Test 1 Failed: Expected unauthorized rejection');
  }
  console.log('Result Test 1: PASS\n');

  // Test 2: Verified Delegate runs !claimwo -> staged pending claim
  console.log('--- Test 2: Delegate of Team A submits !claimwo (Staged Pending) ---');
  const res2 = await sendMsg(delegateAJid, delegateAPhone, `!claimwo ${fix1Id} Singa FC Musuh telat lebih dari 15 menit`);
  console.log(res2.replyText);
  if (!res2.replyText?.includes('PENGAJUAN KLAIM WALKOVER (WO)') || !res2.replyText?.includes('!ok')) {
    throw new Error('Test 2 Failed: Expected staged pending prompt');
  }
  if (!app.woClaimSession.hasPending(centralGroupJid)) {
    throw new Error('woClaimSession should have pending claim for centralGroupJid');
  }
  // Fixture status must still be SCHEDULED (not yet forfeit)
  const fCheck1 = await db.execute({ sql: `SELECT status FROM fixtures WHERE id = ?`, args: [fix1Id] });
  if (fCheck1.rows[0]?.status !== 'SCHEDULED') {
    throw new Error('Fixture should still be SCHEDULED before organizer !ok');
  }
  console.log('Result Test 2: PASS\n');

  // Test 3: Organizer confirms with !ok
  console.log('--- Test 3: Organizer confirms staged claim with !ok ---');
  const res3 = await sendMsg(organizerJid, organizerPhone, `!ok`);
  console.log(res3.replyText);
  if (!res3.replyText?.includes('KLAIM WALKOVER (WO) DISAHKAN OLEH PANITIA') || !res3.replyText?.includes('+3 Poin')) {
    throw new Error('Test 3 Failed: Expected confirmation text');
  }
  if (app.woClaimSession.hasPending(centralGroupJid)) {
    throw new Error('woClaimSession should be cleared after !ok');
  }
  const fCheck2 = await db.execute({ sql: `SELECT status FROM fixtures WHERE id = ?`, args: [fix1Id] });
  if (fCheck2.rows[0]?.status !== 'WALKOVER') {
    throw new Error('Fixture status should now be WALKOVER');
  }
  console.log('Result Test 3: PASS\n');

  // Test 4: Organizer directly runs !claimwo -> direct execution
  console.log('--- Test 4: Organizer directly executes !claimwo ---');
  const res4 = await sendMsg(organizerJid, organizerPhone, `!claimwo ${fix2Id} Garuda FC Forfeit administratif panitia`);
  console.log(res4.replyText);
  if (!res4.replyText?.includes('KEPUTUSAN KLAIM WALKOVER (WO)') || !res4.replyText?.includes('Pemenang WO:* *Singa FC*')) {
    throw new Error('Test 4 Failed: Expected direct organizer WO execution');
  }
  const fCheck3 = await db.execute({ sql: `SELECT status FROM fixtures WHERE id = ?`, args: [fix2Id] });
  if (fCheck3.rows[0]?.status !== 'WALKOVER') {
    throw new Error('Fixture 2 status should now be WALKOVER');
  }
  console.log('Result Test 4: PASS\n');

  console.log('=== AUDIT CONCLUSION: FIX-RBAC-001 ===');
  console.log('ALL DELEGATE AND ORGANIZER WO CLAIM TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
