/**
 * Dry-run verifikasi task flash-peak-tms-fix-preexisting-ts-bugs-v1.
 *
 * BUGFIX-TS-001 — PendingWoClaim.id tidak terisi di jalur !claimwo:
 *   1. Delegasi submit !claimwo -> staged pending claim HARUS punya id non-kosong
 *      (sebelumnya undefined; interface mensyaratkan string). reportedByAddress
 *      juga harus berupa sender_raw_address delegasi (bukan undefined).
 *   2. Alur end-to-end tetap utuh: prompt -> organizer !ok -> WO 3-0 tersimpan.
 *
 * BUGFIX-TS-002 — 4 pemakaian sender_id (field yang tidak pernah ada di
 * NormalizedMessage) dihapus; keempat jalur harus menerima nilai valid dari
 * sender_raw_address saat runtime:
 *   A. router.isSenderOrganizer — jalur cocok JID organizer (router.ts isSenderOrganizer).
 *   B. router.isSenderOrganizer — jalur fallback cocok nomor telepon organizer
 *      (rawDigits path) dengan sender_normalized_address yang TIDAK cocok.
 *   C. router.handleMessage delegate resolution — resolveIdentity menerima
 *      sender_raw_address delegasi terverifikasi (bukan undefined).
 *   D. tournament-commands !claimwo — reportedByAddress = sender_raw_address.
 */
import { createClient } from '@libsql/client';
import { FlashPeakApp } from '../src/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { CommandRouter } from '../src/whatsapp/router.js';
import { IdentityResolver } from '../src/identity/resolver.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

async function main() {
  console.log('=== DRY-RUN FIX-PREEXISTING-TS-BUGS (BUGFIX-TS-001 + BUGFIX-TS-002) ===\n');

  const db = createClient({ url: `file::memory:tsbugs-${Date.now()}` });
  await runMigrations(db);

  const now = new Date().toISOString();
  const organizerJid = '6281234567890@s.whatsapp.net';
  const organizerPhone = '6281234567890';
  const delegateAJid = '6281111111111@s.whatsapp.net';
  const delegateAPhone = '6281111111111';
  const centralGroupJid = '120363000000000001@g.us';

  // Seed: organizer + delegasi tim A
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES ('del-org', 'Tournament Admin', 'ACTIVE', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at) VALUES ('wa-org', 'del-org', ?, 'PHONE', 1, ?)`,
    args: [organizerJid, now],
  });
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES ('del-a', 'Captain Garuda', 'ACTIVE', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at) VALUES ('wa-del-a', 'del-a', ?, 'PHONE', 1, ?)`,
    args: [delegateAJid, now],
  });

  // Seed: turnamen + grup + 2 tim + fixture
  const tId = 'tourney-tsbug-1';
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at) VALUES (?, 'TS Bug Cup', 'ACTIVE', '1.0', '{}', ?, ?)`,
    args: [tId, now, now],
  });
  await db.execute({
    sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at)
          VALUES ('draw-1', ?, 'COMPLETED', '{}', '[]', 'CRYPTO_RANDOM', '1.0', ?)`,
    args: [tId, now],
  });
  await db.execute({
    sql: `INSERT INTO groups (id, draw_id, group_code, display_order) VALUES ('group-a', 'draw-1', 'A', 1)`,
  });
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES ('team-a', ?, 'Garuda FC', 'del-a', 'VERIFIED', ?, ?)`,
    args: [tId, now, now],
  });
  await db.execute({
    sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES ('team-b', ?, 'Singa FC', 'VERIFIED', ?, ?)`,
    args: [tId, now, now],
  });
  await db.execute({
    sql: `INSERT INTO group_members (group_id, team_id, draw_position) VALUES ('group-a', 'team-a', 1), ('group-a', 'team-b', 2)`,
  });
  const fixId = 'fix-wo-1';
  await db.execute({
    sql: `INSERT INTO fixtures (id, tournament_id, group_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'GROUP', 'R1', 'team-a', 'team-b', 'team-a', 'SCHEDULED', ?, ?)`,
    args: [fixId, tId, 'group-a', now, now],
  });
  await db.execute({
    sql: `INSERT INTO games (id, fixture_id, game_number, status, is_walkover, is_draw, evidence_status, created_at, updated_at)
          VALUES ('game-1', ?, 1, 'SCHEDULED', 0, 0, 'PENDING', ?, ?)`,
    args: [fixId, now, now],
  });

  const app = new FlashPeakApp({ db, organizerPhone, organizerJid, centralGroupJid });

  // Konstruksi pesan sesuai kontrak tipe NormalizedMessage — tanpa field palsu.
  const mkMsg = (senderJid: string, text: string): NormalizedMessage =>
    ({
      message_id: `msg-${Math.random()}`,
      chat_id: centralGroupJid,
      sender_raw_address: senderJid,
      sender_normalized_address: senderJid,
      sender_phone: senderJid.split('@')[0],
      is_group: true,
      text_body: text,
      timestamp: new Date(),
    } as unknown as NormalizedMessage);

  // ================================================================
  console.log('--- BUGFIX-TS-001: !claimwo -> PendingWoClaim.id terisi ---');
  {
    const res = await app.handleInboundMessage(
      mkMsg(delegateAJid, `!claimwo ${fixId} Singa FC lawan tidak hadir lebih dari 15 menit`)
    );
    assert(res.replyText?.includes('PENGAJUAN KLAIM WALKOVER (WO)') === true, 'T1: prompt klaim WO staged (jalur !claimwo)');

    const pending = (app as any).woClaimSession?.getPending?.(centralGroupJid) ?? null;
    assert(pending !== null, 'T1: pending claim tersedia di sesi');
    assert(typeof pending?.id === 'string' && pending.id.length > 0, 'T1: pending.id adalah string non-kosong (sebelumnya undefined)');
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(pending?.id)), 'T1: pending.id format UUID valid');
    assert(pending?.reportedByAddress === delegateAJid, 'T1: reportedByAddress = sender_raw_address delegasi (valid, bukan undefined)');

    // End-to-end: organizer !ok -> WO tersimpan 3-0
    const okRes = await app.handleInboundMessage(mkMsg(organizerJid, '!ok'));
    assert(okRes.replyText?.includes('DISAHKAN') === true, 'T1: !ok organizer mengesahkan klaim (e2e utuh)');
    const game = (await db.execute({
      sql: 'SELECT team_a_score, team_b_score, winner_team_id, is_walkover FROM games WHERE fixture_id = ? AND game_number = 1',
      args: [fixId],
    })).rows[0] as any;
    assert(Number(game.team_a_score) === 3 && Number(game.team_b_score) === 0 && Number(game.is_walkover) === 1, 'T1: WO 3-0 tercatat di games');
    const cleared = (app as any).woClaimSession?.getPending?.(centralGroupJid) ?? null;
    assert(cleared === null, 'T1: pending claim ter-clear setelah konfirmasi');
  }

  // ================================================================
  console.log('--- BUGFIX-TS-002.A: isSenderOrganizer — jalur JID organizer ---');
  {
    const router = new CommandRouter({
      centralGroupJid,
      organizerJid,
      organizerPhone,
      identityResolver: new IdentityResolver(db),
    });
    const msg = mkMsg(organizerJid, '!ping');
    assert(router.isSenderOrganizer(msg) === true, 'T2.A: organizer dikenali via sender_raw_address (JID path)');
    const nonOrg = mkMsg('6287777777777@s.whatsapp.net', '!ping');
    assert(router.isSenderOrganizer(nonOrg) === false, 'T2.A: non-organizer tidak dikenali');
  }

  console.log('--- BUGFIX-TS-002.B: isSenderOrganizer — jalur nomor telepon (rawDigits) ---');
  {
    // Router TANPA organizerJid tapi DENGAN organizerPhone: satu-satunya jalur
    // mencocokkan adalah rawDigits dari sender_raw_address (lokasi fix kedua).
    const router = new CommandRouter({
      centralGroupJid,
      organizerJid: '6280000000000@s.whatsapp.net', // berbeda — JID path tidak akan cocok
      organizerPhone,
      identityResolver: new IdentityResolver(db),
    });
    const viaPhone = mkMsg(organizerJid, '!ping');
    assert(router.isSenderOrganizer(viaPhone) === true, 'T2.B: organizer dikenali via rawDigits (sender_raw_address path)');
    assert(router.isSenderOrganizer(mkMsg('6287777777777@s.whatsapp.net', '!ping')) === false, 'T2.B: nomor lain tidak cocok');
  }

  console.log('--- BUGFIX-TS-002.C: resolusi delegasi via resolveIdentity (handleMessage) ---');
  {
    // Command apa pun dari delegasi non-organizer akan melewati
    // handleMessage -> resolveIdentity(sender_raw_address, chat_id).
    // Gunakan command !help (role ANY) dan pastikan tidak error & reply ada.
    const res = await app.handleInboundMessage(mkMsg(delegateAJid, '!help'));
    assert(res.handled === true, 'T2.C: command dari delegasi terproses (resolveIdentity menerima sender_raw_address valid)');
    assert(typeof res.replyText === 'string' && res.replyText.length > 0, 'T2.C: balasan !help non-kosong');

    // Resolusi identitas langsung dengan nilai yang kini dikirim router
    const resolver = new IdentityResolver(db);
    const resolution = await resolver.resolveIdentity(delegateAJid, centralGroupJid);
    assert(resolution.status === 'VERIFIED' && resolution.delegate?.id === 'del-a', 'T2.C: resolveIdentity VERIFIED untuk sender_raw_address delegasi');
  }

  console.log('--- BUGFIX-TS-002.D: !claimwo — reportedByAddress dari sender_raw_address ---');
  {
    // Sudah diverifikasi di T1 (reportedByAddress === delegateAJid), tapi
    // jalur ini adalah lokasi ke-4 pemakaian sender_id — tegas di sini:
    const res = await app.handleInboundMessage(
      mkMsg(delegateAJid, `!claimwo ${fixId} Singa FC untuk revisi — uji jalur reportedByAddress`)
    );
    // Fixture sudah WO (completed) — balasan apapun itu, command harus tetap
    // berjalan tanpa crash dari undefined reportedByAddress.
    assert(res.handled === true && typeof res.replyText === 'string', 'T2.D: jalur !claimwo tetap aman setelah fix (tanpa undefined)');
  }

  console.log(`\n=== HASIL: ${passed} PASS, ${failed} FAIL ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
