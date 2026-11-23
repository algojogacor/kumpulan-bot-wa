import { createClient } from '@libsql/client';
import { FlashPeakApp } from '../src/index.js';
import { runMigrations } from '../src/db/migrate.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

async function main() {
  console.log('=== AUDIT TEST: FIX-WO-001 (evaluateRoomHostAvailability via !roomcard) ===\n');

  const db = createClient({ url: 'file::memory:?cache=shared' });
  await runMigrations(db);

  const now = new Date().toISOString();
  const organizerPhone = '6281234567890';
  const organizerJid = `${organizerPhone}@s.whatsapp.net`;
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

  // Seed tournament
  const tId = 'tourney-wo-1';
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [tId, 'Flash Peak Cup 2026', 'ACTIVE', '1.0', '{}', now, now],
  });

  // Seed group draw & group
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

  // Seed teams
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', ?, ?)`,
    args: ['team-a', tId, 'Garuda FC', now, now],
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

  // Fixture 1: Group Stage match
  const fix1Id = 'fix-grp-1';
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

  // Fixture 2: Group Stage match (for double WO)
  const fix2Id = 'fix-grp-2';
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

  // Fixture 3: Knockout Stage match (for mandatory reschedule)
  const fix3Id = 'fix-ko-1';
  await db.execute({
    sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, scheduled_at, status, created_at, updated_at)
          VALUES (?, ?, 'KNOCKOUT', 'FINAL', 'team-a', 'team-b', 'team-a', ?, 'SCHEDULED', ?, ?)`,
    args: [fix3Id, tId, now, now, now],
  });
  await db.execute({
    sql: `INSERT INTO series (id, fixture_id, format, target_wins, status, created_at, updated_at)
          VALUES ('series-1', ?, 'BO3', 2, 'IN_PROGRESS', ?, ?)`,
    args: [fix3Id, now, now],
  });
  await db.execute({
    sql: `INSERT INTO games (id, fixture_id, game_number, status, is_walkover, is_draw, evidence_status, created_at, updated_at)
          VALUES ('game-3-1', ?, 1, 'SCHEDULED', 0, 0, 'PENDING', ?, ?)`,
    args: [fix3Id, now, now],
  });

  const app = new FlashPeakApp({
    db,
    organizerPhone,
    organizerJid,
    centralGroupJid,
  });

  // Helper
  const sendCmd = async (text: string) => {
    const msg: NormalizedMessage = {
      message_id: `msg-${Date.now()}-${Math.random()}`,
      chat_id: centralGroupJid,
      // BUGFIX-TS-002 dry-run alignment: build messages per the NormalizedMessage
      // contract (sender_raw_address), not the legacy sender_id field.
      sender_raw_address: organizerJid,
      sender_normalized_address: organizerJid,
      sender_phone: organizerPhone,
      is_group: true,
      text_body: text,
      timestamp: new Date(),
    };
    return app.handleInboundMessage(msg);
  };

  // 1. Info check without status
  console.log('--- Test 1: !roomcard with no arguments (Info Display) ---');
  const res1 = await sendCmd(`!roomcard ${fix1Id}`);
  console.log(res1.replyText);
  if (!res1.replyText?.includes('STATUS KARTU ROOM') || !res1.replyText?.includes('Garuda FC')) {
    throw new Error('Test 1 Failed: Info display incorrect');
  }
  console.log('Result Test 1: PASS\n');

  // 2. Scenario A: Left side has card (ok)
  console.log('--- Test 2: !roomcard ok (Left Side Ready) ---');
  const res2 = await sendCmd(`!roomcard ${fix1Id} ok`);
  console.log(res2.replyText);
  if (!res2.replyText?.includes('PENETAPAN TUAN RUMAH') || !res2.replyText?.includes('Tuan Rumah Terjadwal')) {
    throw new Error('Test 2 Failed: Left side ready incorrect');
  }
  const fCheck1 = await db.execute({ sql: `SELECT host_team_id, host_assignment_reason FROM fixtures WHERE id = ?`, args: [fix1Id] });
  if (fCheck1.rows[0]?.host_team_id !== 'team-a' || fCheck1.rows[0]?.host_assignment_reason !== 'DEFAULT_LEFT_SIDE') {
    throw new Error('DB assertion failed for Test 2');
  }
  console.log('Result Test 2: PASS\n');

  // 3. Scenario B: Left side no card, opponent substitutes (ganti)
  console.log('--- Test 3: !roomcard ganti (Opponent Substitutes) ---');
  const res3 = await sendCmd(`!roomcard ${fix1Id} ganti`);
  console.log(res3.replyText);
  if (!res3.replyText?.includes('SUBSTITUSI') || !res3.replyText?.includes('*Host Pengganti:* *Singa FC*')) {
    throw new Error('Test 3 Failed: Opponent substitute incorrect');
  }
  const fCheck2 = await db.execute({ sql: `SELECT host_team_id, host_assignment_reason FROM fixtures WHERE id = ?`, args: [fix1Id] });
  if (fCheck2.rows[0]?.host_team_id !== 'team-b' || fCheck2.rows[0]?.host_assignment_reason !== 'OPPONENT_SUBSTITUTED') {
    throw new Error('DB assertion failed for Test 3');
  }
  console.log('Result Test 3: PASS\n');

  // 4. Scenario C: Left side no card, opponent refuses (tolak -> opponent wins WO)
  console.log('--- Test 4: !roomcard tolak (Opponent Refuses -> Opponent Wins WO) ---');
  const res4 = await sendCmd(`!roomcard ${fix1Id} tolak`);
  console.log(res4.replyText);
  if (!res4.replyText?.includes('FORFEIT / WO') || !res4.replyText?.includes('Pemenang WO:* *Singa FC*')) {
    throw new Error('Test 4 Failed: Opponent refuse forfeit incorrect');
  }
  const fCheck3 = await db.execute({ sql: `SELECT status FROM fixtures WHERE id = ?`, args: [fix1Id] });
  if (fCheck3.rows[0]?.status !== 'WALKOVER') {
    throw new Error('DB assertion failed for Test 4: fixture status should be WALKOVER');
  }
  console.log('Result Test 4: PASS\n');

  // 5. Scenario D1: Group Stage both teams have no card (habis -> Double Walkover 0 points each)
  console.log('--- Test 5: !roomcard habis in Group Stage (Double WO 0-0, 0 Points) ---');
  const res5 = await sendCmd(`!roomcard ${fix2Id} habis`);
  console.log(res5.replyText);
  if (!res5.replyText?.includes('WO GANDA (DOUBLE WALKOVER)') || !res5.replyText?.includes('0 Poin')) {
    throw new Error('Test 5 Failed: Group Double WO incorrect');
  }
  const fCheck4 = await db.execute({ sql: `SELECT status FROM fixtures WHERE id = ?`, args: [fix2Id] });
  if (fCheck4.rows[0]?.status !== 'WALKOVER') {
    throw new Error('DB assertion failed for Test 5: fixture status should be WALKOVER');
  }
  console.log('Result Test 5: PASS\n');

  // 6. Scenario D2: Knockout Stage both teams have no card (habis -> DOUBLE LOSS per D-032 revised 20 Nov 2026)
  console.log('--- Test 6: !roomcard habis in Knockout Stage (Double Loss, D-032 revised) ---');
  const res6 = await sendCmd(`!roomcard ${fix3Id} habis`);
  console.log(res6.replyText);
  if (!res6.replyText?.includes('KALAH GANDA') || !res6.replyText?.includes('D-032 revisi 20 Nov 2026')) {
    throw new Error('Test 6 Failed: Knockout double-loss message incorrect');
  }
  const fCheck5 = await db.execute({ sql: `SELECT status, scheduled_at FROM fixtures WHERE id = ?`, args: [fix3Id] });
  if (fCheck5.rows[0]?.status !== 'WALKOVER') {
    throw new Error('DB assertion failed for Test 6: fixture should be resolved as WALKOVER (double loss, no winner)');
  }
  const gCheck6 = await db.execute({ sql: `SELECT winner_team_id, is_walkover, walkover_type FROM games WHERE fixture_id = ? AND game_number = 1`, args: [fix3Id] });
  if (gCheck6.rows[0]?.winner_team_id !== null || gCheck6.rows[0]?.is_walkover !== 1) {
    throw new Error('DB assertion failed for Test 6: game should record double walkover with no winner');
  }
  console.log('Result Test 6: PASS\n');

  console.log('=== AUDIT CONCLUSION: FIX-WO-001 ===');
  console.log('ALL ROOM CARD EVALUATION COMMAND TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
