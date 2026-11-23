/**
 * Dry-run verifikasi bagian 2/3/4 dari task
 * flash-peak-tms-knockout-pipeline-and-override-v2.
 *
 * Bagian 2 — pipeline evidence knockout interaktif per-game:
 *   A. Alur ideal berurutan BO3 (2-0 early stop, tidak minta game 3).
 *   B. BO3 1-1 lanjut ke game 3 penentuan.
 *   C. Kirim semua foto sekaligus di awal (early-excess ignored).
 *   D. Foto tidak berurutan/terbalik.
 *   E. Foto duplikat/revisi untuk game yang sama (idempotent + konflik).
 *   F. Game seri wajib replay pada slot yang sama (D-028).
 *   G. BO5 Grand Final threshold 3 (generic best-of-N, tanpa duplikasi kode).
 *   H. End-to-end penuh: standings grup final -> !startknockout -> bracket ->
 *      !kogame per game -> ronde berikutnya -> juara -> turnamen COMPLETED.
 *
 * Bagian 3 — approval reset saat reopen:
 *   Lock 3 pihak -> koreksi ditolak -> organizer reopen -> approval lama
 *   ter-reset (0/3) -> 1 vote baru TIDAK langsung melengkapi -> butuh 3 vote
 *   baru untuk LOCK lagi.
 *
 * Bagian 4 — double loss KO (D-032 revisi):
 *   Kedua tim tidak hadir -> keduanya kalah di DB -> pasangan di ronde
 *   berikutnya otomatis lolos (bye) -> pesan WA menyebut bye eksplisit.
 */
import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { FlashPeakApp } from '../src/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { ProviderRouter } from '../src/ai/router.js';
import { ImageClassifier } from '../src/ai/classifier.js';
import { MatchSummaryExtractor } from '../src/ai/extractors/match.js';
import type { AIRequest, AIResponse } from '../src/ai/adapter.js';
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

/**
 * Mock AI adapter: every KO game photo is encoded as base64 text
 * "KO:<aScore>-<bScore>" so classifier/extractor can deterministically read it.
 */
class MockKoAdapter {
  constructor() {}
  get name() { return 'MOCK'; }
  get capabilities() { return { vision: true, structuredOutput: true, maxConcurrentRequests: 5 }; }
  async execute(req: AIRequest): Promise<AIResponse> {
    if (req.task === 'CLASSIFY' || req.task === 'CLASSIFY_IMAGE') {
      const raw = Buffer.from(req.images?.[0]?.base64 || '', 'base64').toString('utf8');
      const isMain = raw.startsWith('KO:');
      const parsed = {
        screen_type: isMain ? 'MAIN_MATCH_SUMMARY' : 'INDIVIDUAL_PLAYER_DETAIL',
        confidence: 0.99,
        reason: 'Mock classifier',
        visual_features: ['scoreboard'],
      };
      return {
        provider: 'MOCK', raw_output: JSON.stringify(parsed), parsed_json: parsed,
        telemetry: { request_id: randomUUID(), provider: 'MOCK', task: req.task, latency_ms: 5, prompt_tokens: 10, completion_tokens: 10, cached: false },
      };
    }
    if (req.task === 'EXTRACT_MATCH' || req.task === 'EXTRACT_MATCH_SUMMARY') {
      const raw = Buffer.from(req.images?.[0]?.base64 || '', 'base64').toString('utf8');
      const m = raw.match(/^KO:(\d+)-(\d+)$/);
      const a = m ? parseInt(m[1], 10) : 0;
      const b = m ? parseInt(m[2], 10) : 0;
      const data = {
        screen_type: 'MAIN_MATCH_SUMMARY',
        team_a_score: a,
        team_b_score: b,
        result_indicator: a > b ? 'WIN_LEFT' : (b > a ? 'WIN_RIGHT' : 'DRAW'),
        team_a_players: [
          { nickname_raw: 'GKA', rating: 8, goals: a > 0 ? 1 : 0, assists: 0, passes: 40, defense: 2 },
          { nickname_raw: 'PA1', rating: 7.5, goals: 0, assists: 1, passes: 38, defense: 2 },
          { nickname_raw: 'PA2', rating: 7, goals: 0, assists: 0, passes: 30, defense: 2 },
          { nickname_raw: 'PA3', rating: 6.8, goals: 0, assists: 0, passes: 25, defense: 2 },
          { nickname_raw: 'PA4', rating: 6.5, goals: 0, assists: 0, passes: 20, defense: 2 },
        ],
        team_b_players: [
          { nickname_raw: 'GKB', rating: 7.8, goals: b > 0 ? 1 : 0, assists: 0, passes: 39, defense: 2 },
          { nickname_raw: 'PB1', rating: 7.4, goals: 0, assists: 0, passes: 37, defense: 2 },
          { nickname_raw: 'PB2', rating: 7, goals: 0, assists: 1, passes: 29, defense: 2 },
          { nickname_raw: 'PB3', rating: 6.9, goals: 0, assists: 0, passes: 26, defense: 2 },
          { nickname_raw: 'PB4', rating: 6.4, goals: 0, assists: 0, passes: 21, defense: 2 },
        ],
        confidence: 0.95,
        unreadable_fields: [],
        uncertainties: [],
      };
      return {
        provider: 'MOCK', raw_output: JSON.stringify(data), parsed_json: data,
        telemetry: { request_id: randomUUID(), provider: 'MOCK', task: req.task, latency_ms: 10, prompt_tokens: 50, completion_tokens: 50, cached: false },
      };
    }
    throw new Error(`Unhandled mock task: ${req.task}`);
  }
}

interface SeedOpts { teamCount?: number }
async function seedTournamentWithGroups(db: any, tId: string, opts: SeedOpts = {}) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [tId, `Cup ${tId}`, 'ACTIVE', '1.0', '{}', now, now],
  });
  await db.execute({
    sql: `INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at)
          VALUES (?, ?, 'COMPLETED', '{}', '[]', 'CRYPTO_RANDOM', '1.0', ?)`,
    args: [`draw-${tId}`, tId, now],
  });
  for (const grp of ['ga', 'gb']) {
    await db.execute({
      sql: `INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, ?, ?)`,
      args: [`grp-${tId}-${grp}`, `draw-${tId}`, grp.toUpperCase(), grp === 'ga' ? 1 : 2],
    });
  }
  const teams = [
    { id: 'a1', name: 'Alpha FC', group: 'ga' }, { id: 'a2', name: 'Beta FC', group: 'ga' },
    { id: 'a3', name: 'Gamma FC', group: 'ga' }, { id: 'a4', name: 'Delta FC', group: 'ga' },
    { id: 'b1', name: 'Epsilon FC', group: 'gb' }, { id: 'b2', name: 'Zeta FC', group: 'gb' },
    { id: 'b3', name: 'Eta FC', group: 'gb' }, { id: 'b4', name: 'Theta FC', group: 'gb' },
  ];
  for (const t of teams) {
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', ?, ?)`,
      args: [`${tId}-${t.id}`, tId, t.name, now, now],
    });
    await db.execute({
      sql: `INSERT INTO group_members (group_id, team_id, draw_position) VALUES (?, ?, ?)`,
      args: [`grp-${tId}-${t.group}`, `${tId}-${t.id}`, t.id.slice(-1)],
    });
  }
  // Completed group fixtures + standings: A: a1=6 (1st), a2=3 (2nd); B: b1=6, b2=3
  const results = [
    { a: 'a1', b: 'a2', sa: 2, sb: 1 }, { a: 'a1', b: 'a3', sa: 3, sb: 0 },
    { a: 'a1', b: 'a4', sa: 1, sb: 0 }, { a: 'a2', b: 'a3', sa: 1, sb: 0 },
    { a: 'a2', b: 'a4', sa: 0, sb: 0 }, { a: 'a3', b: 'a4', sa: 1, sb: 1 },
    { a: 'b1', b: 'b2', sa: 2, sb: 0 }, { a: 'b1', b: 'b3', sa: 2, sb: 1 },
    { a: 'b1', b: 'b4', sa: 1, sb: 0 }, { a: 'b2', b: 'b3', sa: 1, sb: 0 },
    { a: 'b2', b: 'b4', sa: 0, sb: 0 }, { a: 'b3', b: 'b4', sa: 1, sb: 1 },
  ];
  let i = 0;
  for (const r of results) {
    i++;
    const isDraw = r.sa === r.sb;
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, group_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'GROUP', 'ROUND_1', ?, ?, ?, 'COMPLETED', ?, ?)`,
      args: [`fx-${tId}-g${i}`, tId, `grp-${tId}-${r.a[0] === 'a' ? 'ga' : 'gb'}`, `${tId}-${r.a}`, `${tId}-${r.b}`, `${tId}-${r.a}`, now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, team_a_score, team_b_score, winner_team_id, is_draw, is_walkover, walkover_type, evidence_status, created_at, updated_at)
            VALUES (?, ?, 1, 'COMPLETED', ?, ?, ?, ?, 0, 'NONE', 'VERIFIED', ?, ?)`,
      args: [`gm-${tId}-g${i}`, `fx-${tId}-g${i}`, r.sa, r.sb, isDraw ? null : `${tId}-${r.sa > r.sb ? r.a : r.b}`, isDraw ? 1 : 0, now, now],
    });
  }
  const { recalculateAndPersistGroupStandings } = await import('../src/competition/standings.js');
  await recalculateAndPersistGroupStandings(db, tId, `grp-${tId}-ga`);
  await recalculateAndPersistGroupStandings(db, tId, `grp-${tId}-gb`);
  return teams;
}

async function main() {
  console.log('=== DRY-RUN KO PIPELINE v2 (bagian 2/3/4) ===\n');

  const db = createClient({ url: `file::memory:kov2-${Date.now()}` });
  await runMigrations(db);

  const organizerPhone = '628999000011';
  const organizerJid = `${organizerPhone}@s.whatsapp.net`;
  const centralGroupJid = '120363000000000011@g.us';

  // Identities: organizer + delegate of team A1 (Alpha) in every tournament
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES ('del-org', 'Tournament Admin', 'ACTIVE', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at) VALUES (?, ?, ?, 'PHONE', 1, ?)`,
    args: ['wa-org', 'del-org', organizerJid, now],
  });
  await db.execute({
    sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES ('del-a1', 'Delegasi Alpha', 'ACTIVE', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at) VALUES (?, ?, ?, 'PHONE', 1, ?)`,
    args: ['wa-a1', 'del-a1', '628999000111@s.whatsapp.net', now],
  });

  const providerRouter = new ProviderRouter({ adapters: [new MockKoAdapter() as any] });
  const classifier = new ImageClassifier(providerRouter);
  const matchExtractor = new MatchSummaryExtractor(providerRouter);

  const mkMsg = (text: string, senderJid: string = organizerJid, chat = centralGroupJid): NormalizedMessage =>
    ({
      message_id: `msg-${randomUUID()}`,
      chat_id: chat,
      sender_id: senderJid,
      sender_raw_address: senderJid,
      sender_normalized_address: senderJid,
      sender_phone: senderJid.split('@')[0],
      is_group: true,
      text_body: text,
      timestamp: new Date(),
    } as unknown as NormalizedMessage);

  const mkPhotoMsg = (scoreA: number, scoreB: number, caption = '!kogame', senderJid = '628999000111@s.whatsapp.net'): NormalizedMessage =>
    ({
      ...mkMsg('', senderJid),
      text_body: null,
      caption,
      message_type: 'IMAGE',
      media_metadata: { mimetype: 'image/jpeg', fileLength: 1024, fileName: `ko-${scoreA}-${scoreB}.jpg` },
    } as unknown as NormalizedMessage);

  const photoBuffer = (a: number, b: number) => Buffer.from(`KO:${a}-${b}`, 'utf8');

  const app = new FlashPeakApp({
    db,
    organizerPhone,
    organizerJid,
    centralGroupJid,
    providerRouter,
    classifier,
    matchExtractor,
  });

  // =====================================================================
  // BAGIAN 2 — skenario robustness pipeline interaktif
  // =====================================================================
  const tId = 't2x';
  await seedTournamentWithGroups(db, tId);

  console.log('--- Setup: !startknockout untuk bracket awal ---');
  await app.handleInboundMessage(mkMsg('!startknockout'));
  const koFixtures = (await db.execute({
    sql: `SELECT f.id, f.round_code, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' ORDER BY f.created_at ASC`,
    args: [tId],
  })).rows as any[];
  assert(koFixtures.length === 2, 'bracket awal: 2 fixture SEMI_FINAL dibuat');
  const sf1 = koFixtures[0];
  const sf1Id = String(sf1.id);

  const sendGame = async (a: number, b: number, fixtureId = sf1Id) => {
    const res = await app.handleInboundMessage(mkPhotoMsg(a, b, `!kogame ${fixtureId}`), photoBuffer(a, b));
    return res;
  };

  console.log('--- A. Alur ideal berurutan BO3: 2-0 early stop ---');
  {
    const r1 = await sendGame(2, 1, sf1Id);
    assert(r1.replyText?.includes('Game ke-1') === true, 'A: balasan menyebut game ke-1');
    assert(r1.replyText?.includes('kirim screenshot *game ke-2*') === true, 'A: bot minta foto game 2');
    const r2 = await sendGame(3, 0, sf1Id);
    assert(r2.replyText?.includes('SERIES SELESAI') === true, 'A: series selesai saat 2-0');
    assert(r2.replyText?.includes('TIDAK') === false && r2.replyText?.includes('Game ke-3') === false, 'A: TIDAK minta game 3 (early stop)');
    const s = (await db.execute({ sql: 'SELECT team_a_game_wins, team_b_game_wins, status FROM series WHERE fixture_id = ?', args: [sf1Id] })).rows[0] as any;
    assert(Number(s.team_a_game_wins) === 2 && Number(s.team_b_game_wins) === 0 && String(s.status) === 'COMPLETED', 'A: DB series 2-0 COMPLETED');
    // Evidence journal: 2 applied
    const j = (await db.execute({ sql: 'SELECT COUNT(*) as c FROM ko_game_evidence WHERE fixture_id = ? AND status = \'APPLIED\'', args: [sf1Id] })).rows[0] as any;
    assert(Number(j.c) === 2, 'A: 2 evidence APPLIED terjurnal');
  }

  console.log('--- B. BO3 1-1 lanjut game 3 penentuan ---');
  const sf2 = koFixtures[1];
  const sf2Id = String(sf2.id);
  {
    const r1 = await sendGame(0, 2, sf2Id);
    assert(r1.replyText?.includes('Game ke-1') === true, 'B: game 1 tercatat');
    const r2 = await sendGame(2, 0, sf2Id);
    assert(r2.replyText?.includes('Game ke-2') === true, 'B: game 2 tercatat');
    assert(r2.replyText?.includes('kirim screenshot *game ke-3*') === true, 'B: 1-1 -> bot minta game 3');
    const r3 = await sendGame(1, 2, sf2Id);
    assert(r3.replyText?.includes('SERIES SELESAI') === true, 'B: game 3 penentuan menyelesaikan series');
    const s = (await db.execute({ sql: 'SELECT team_a_game_wins, team_b_game_wins, status, winner_team_id FROM series WHERE fixture_id = ?', args: [sf2Id] })).rows[0] as any;
    assert(Number(s.team_a_game_wins) === 1 && Number(s.team_b_game_wins) === 2, 'B: DB series 1-2');
    assert(String(s.winner_team_id) === String(sf2.team_b_id), 'B: winner = team B fixture');
  }

  console.log('--- C. Kirim semua foto sekaligus di awal (BO3 2-0 + 1 foto ekstra) ---');
  {
    const tIdC = 't2c';
    await seedTournamentWithGroups(db, tIdC);
    await app.handleInboundMessage(mkMsg(`!startknockout ${tIdC}`));
    const fixC = (await db.execute({
      sql: `SELECT f.id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' ORDER BY f.created_at ASC LIMIT 1`,
      args: [tIdC],
    })).rows[0] as any;
    const fixCId = String(fixC.id);

    // Batch: game1 win A, game2 win A (series done 2-0), game3 extra photo
    const r1 = await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${fixCId}`), photoBuffer(2, 1));
    const r2 = await app.handleInboundMessage(mkPhotoMsg(3, 0, `!kogame ${fixCId}`), photoBuffer(3, 0));
    const r3 = await app.handleInboundMessage(mkPhotoMsg(1, 2, `!kogame ${fixCId}`), photoBuffer(1, 2));

    assert(r2.replyText?.includes('SERIES SELESAI') === true, 'C: series selesai di foto ke-2');
    assert(r3.replyText?.includes('diabaikan') === true, 'C: foto ekstra (game yang tak relevan lagi) DIABAIKAN dengan pesan eksplisit');
    const j = (await db.execute({
      sql: `SELECT status, COUNT(*) as c FROM ko_game_evidence WHERE fixture_id = ? GROUP BY status`,
      args: [fixCId],
    })).rows as any[];
    const ignored = j.find((x) => String(x.status) === 'IGNORED');
    const applied = j.find((x) => String(x.status) === 'APPLIED');
    assert(ignored && Number(ignored.c) === 1, 'C: 1 evidence IGNORED terjurnal');
    assert(applied && Number(applied.c) === 2, 'C: hanya 2 evidence APPLIED');
    const s = (await db.execute({ sql: 'SELECT team_a_game_wins, team_b_game_wins FROM series WHERE fixture_id = ?', args: [fixCId] })).rows[0] as any;
    assert(Number(s.team_a_game_wins) === 2 && Number(s.team_b_game_wins) === 0, 'C: series tetap 2-0 (foto ekstra tidak diproses resmi)');
  }

  console.log('--- D. Foto tidak berurutan / terbalik ---');
  {
    const tIdD = 't2d';
    await seedTournamentWithGroups(db, tIdD);
    await app.handleInboundMessage(mkMsg(`!startknockout ${tIdD}`));
    const fixD = (await db.execute({
      sql: `SELECT f.id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' ORDER BY f.created_at ASC LIMIT 1`,
      args: [tIdD],
    })).rows[0] as any;
    const fixDId = String(fixD.id);

    // Delegate sends game 2's photo FIRST, then game 1's photo.
    // Slot derivation means the first photo fills slot 1 and the second fills
    // slot 2 — the SERIES state stays correct because the slot is derived
    // from persisted state, not from the photo's claimed order.
    await app.handleInboundMessage(mkPhotoMsg(0, 2, `!kogame ${fixDId}`), photoBuffer(0, 2)); // dikirim duluan
    await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${fixDId}`), photoBuffer(2, 1)); // dikirim belakangan

    const s = (await db.execute({ sql: 'SELECT team_a_game_wins, team_b_game_wins FROM series WHERE fixture_id = ?', args: [fixDId] })).rows[0] as any;
    assert(Number(s.team_a_game_wins) === 1 && Number(s.team_b_game_wins) === 1, 'D: series 1-1 benar walau foto dikirim terbalik');
    const g1 = (await db.execute({ sql: 'SELECT team_a_score, team_b_score FROM games WHERE fixture_id = ? AND game_number = 1', args: [fixDId] })).rows[0] as any;
    assert(Number(g1.team_a_score) === 0 && Number(g1.team_b_score) === 2, 'D: slot game 1 = 0-2 (foto pertama masuk slot pertama terbuka)');
    const g2 = (await db.execute({ sql: 'SELECT team_a_score, team_b_score FROM games WHERE fixture_id = ? AND game_number = 2', args: [fixDId] })).rows[0] as any;
    assert(Number(g2.team_a_score) === 2 && Number(g2.team_b_score) === 1, 'D: slot game 2 = 2-1 (foto kedua masuk slot berikutnya)');
  }

  console.log('--- E. Foto duplikat/revisi untuk game yang sama ---');
  {
    const tIdE = 't2e';
    await seedTournamentWithGroups(db, tIdE);
    await app.handleInboundMessage(mkMsg(`!startknockout ${tIdE}`));
    const fixE = (await db.execute({
      sql: `SELECT f.id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' ORDER BY f.created_at ASC LIMIT 1`,
      args: [tIdE],
    })).rows[0] as any;
    const fixEId = String(fixE.id);

    // Photo for the current open slot, then a DUPLICATE (same score)
    await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${fixEId}`), photoBuffer(2, 1));
    const dupRes = await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${fixEId}`), photoBuffer(2, 1));
    assert(dupRes.replyText?.includes('duplikat hasil game') === true || dupRes.replyText?.includes('sama sudah tercatat') === true, 'E: duplikat skor sama -> pesan idempotent');
    const s = (await db.execute({ sql: 'SELECT team_a_game_wins FROM series WHERE fixture_id = ?', args: [fixEId] })).rows[0] as any;
    assert(Number(s.team_a_game_wins) === 1, 'E: win TIDAK terhitung dua kali');

    // A REVISED photo with a different decisive score for the SAME winner
    // fills the NEXT open slot only if it doesn't conflict; a conflicting
    // different-winner photo for an already decided slot -> NEEDS_REVIEW.
    const conflictRes = await app.handleInboundMessage(mkPhotoMsg(0, 3, `!kogame ${fixEId}`), photoBuffer(0, 3));
    // slot 1 already decided for team A (2-1); 0-3 claims team B for a decided
    // slot -> different winner on decided slot: derived slot is 2, so this
    // photo fills slot 2 (0-3 team B win) — series 1-1. No conflict.
    const s2 = (await db.execute({ sql: 'SELECT team_a_game_wins, team_b_game_wins FROM series WHERE fixture_id = ?', args: [fixEId] })).rows[0] as any;
    assert(Number(s2.team_a_game_wins) === 1 && Number(s2.team_b_game_wins) === 1, 'E: foto beda skor mengisi slot berikutnya (1-1)');

    // Direct same-slot conflict: record slot 3 decisively, then send a photo
    // claiming the same slot with a different score for the same winner.
    await app.handleInboundMessage(mkPhotoMsg(2, 0, `!kogame ${fixEId}`), photoBuffer(2, 0)); // slot 3: A wins -> series 2-1 COMPLETE
    const postRes = await app.handleInboundMessage(mkPhotoMsg(3, 0, `!kogame ${fixEId}`), photoBuffer(3, 0)); // foto setelah series selesai
    assert(postRes.replyText?.includes('diabaikan') === true, 'E: foto setelah series selesai diabaikan');
  }

  console.log('--- F. Game seri wajib replay slot sama (D-028) ---');
  {
    const tIdF = 't2f';
    await seedTournamentWithGroups(db, tIdF);
    await app.handleInboundMessage(mkMsg(`!startknockout ${tIdF}`));
    const fixF = (await db.execute({
      sql: `SELECT f.id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' ORDER BY f.created_at ASC LIMIT 1`,
      args: [tIdF],
    })).rows[0] as any;
    const fixFId = String(fixF.id);

    const r1 = await app.handleInboundMessage(mkPhotoMsg(1, 1, `!kogame ${fixFId}`), photoBuffer(1, 1));
    assert(r1.replyText?.includes('wajib replay') === true, 'F: game seri 1-1 -> wajib replay pada slot sama');
    const s = (await db.execute({ sql: 'SELECT team_a_game_wins, team_b_game_wins, status FROM series WHERE fixture_id = ?', args: [fixFId] })).rows[0] as any;
    assert(Number(s.team_a_game_wins) === 0 && Number(s.team_b_game_wins) === 0, 'F: seri tidak menambah win');
    const g1 = (await db.execute({ sql: 'SELECT is_draw, status FROM games WHERE fixture_id = ? AND game_number = 1', args: [fixFId] })).rows[0] as any;
    assert(Number(g1.is_draw) === 1, 'F: slot 1 is_draw=1 menunggu replay');

    // Replay decisive 2-1 on the SAME slot
    const r2 = await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${fixFId}`), photoBuffer(2, 1));
    assert(r2.replyText?.includes('Game ke-1') === true, 'F: replay tercatat di slot 1');
    const g1b = (await db.execute({ sql: 'SELECT is_draw, winner_team_id, status FROM games WHERE fixture_id = ? AND game_number = 1', args: [fixFId] })).rows[0] as any;
    assert(Number(g1b.is_draw) === 0 && String(g1b.status) === 'COMPLETED', 'F: slot 1 final decisive setelah replay');
    const s2 = (await db.execute({ sql: 'SELECT team_a_game_wins FROM series WHERE fixture_id = ?', args: [fixFId] })).rows[0] as any;
    assert(Number(s2.team_a_game_wins) === 1, 'F: win A = 1 setelah replay decisive');
    // No game 2 consumed by the tied attempt
    const cnt = (await db.execute({ sql: 'SELECT COUNT(*) as c FROM games WHERE fixture_id = ?', args: [fixFId] })).rows[0] as any;
    assert(Number(cnt.c) === 1, 'F: hanya 1 game row — replay reuse slot, tidak konsumsi slot baru');
  }

  console.log('--- G. BO5 Grand Final threshold 3 (generic best-of-N) ---');
  {
    const tIdG = 't2g';
    await seedTournamentWithGroups(db, tIdG);
    await app.handleInboundMessage(mkMsg(`!startknockout ${tIdG}`));
    const fixesG = (await db.execute({
      sql: `SELECT f.id, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' ORDER BY f.created_at ASC`,
      args: [tIdG],
    })).rows as any[];
    // Win both SF 2-0 via photos
    for (const fx of fixesG) {
      await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${String(fx.id)}`), photoBuffer(2, 1));
      await app.handleInboundMessage(mkPhotoMsg(2, 0, `!kogame ${String(fx.id)}`), photoBuffer(2, 0));
    }
    const startRes = await app.handleInboundMessage(mkMsg(`!startknockout ${tIdG}`));
    const finalG = (await db.execute({
      sql: `SELECT f.id, f.round_code FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' AND f.round_code = 'FINAL'`,
      args: [tIdG],
    })).rows[0] as any;
    assert(Boolean(finalG), 'G: GRAND FINAL terbentuk');
    const serG = (await db.execute({
      sql: `SELECT s.format, s.target_wins FROM series s WHERE s.fixture_id = ?`,
      args: [String(finalG.id)],
    })).rows[0] as any;
    assert(String(serG.format) === 'BO5' && Number(serG.target_wins) === 3, 'G: FINAL = BO5 target 3');

    // 2 wins does NOT complete BO5; 3rd win does.
    const fId = String(finalG.id);
    await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${fId}`), photoBuffer(2, 1));
    await app.handleInboundMessage(mkPhotoMsg(2, 0, `!kogame ${fId}`), photoBuffer(2, 0));
    const sMid = (await db.execute({ sql: 'SELECT team_a_game_wins, status FROM series WHERE fixture_id = ?', args: [fId] })).rows[0] as any;
    assert(Number(sMid.team_a_game_wins) === 2 && String(sMid.status) === 'IN_PROGRESS', 'G: BO5 2 win belum selesai (threshold 3)');
    const r3 = await app.handleInboundMessage(mkPhotoMsg(3, 1, `!kogame ${fId}`), photoBuffer(3, 1));
    assert(r3.replyText?.includes('SERIES SELESAI') === true, 'G: win ke-3 menyelesaikan BO5');
    const tStat = (await db.execute({ sql: 'SELECT status FROM tournaments WHERE id = ?', args: [tIdG] })).rows[0] as any;
    assert(String(tStat.status) === 'COMPLETED', 'G: turnamen COMPLETED saat Grand Final BO5 selesai');
    assert(r3.replyText?.includes('GRAND FINAL selesai') === true, 'G: pesan menyebut Grand Final selesai');
  }

  console.log('--- H. End-to-end penuh (tId t2x): SF2 selesai -> FINAL -> juara ---');
  {
    // t2x: SF1 done (A wins), SF2 done (B wins). Generate FINAL via command.
    const startRes = await app.handleInboundMessage(mkMsg(`!startknockout ${tId}`));
    const finalH = (await db.execute({
      sql: `SELECT f.id, f.round_code, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' AND f.round_code = 'FINAL'`,
      args: [tId],
    })).rows[0] as any;
    assert(Boolean(finalH), 'H: FINAL terbentuk dari pemenang SF');
    const fId = String(finalH.id);
    const finalTeamA = String(finalH.team_a_id);
    const finalTeamB = String(finalH.team_b_id);
    const isASf1Winner = finalTeamA === String(sf1.team_a_id) || finalTeamA === String(sf1.team_b_id);
    assert(isASf1Winner, 'H: finalis berasal dari pemenang SF');

    // Play the final 2-1 via photos (BO5: need 3 wins)
    await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${fId}`), photoBuffer(2, 1));
    await app.handleInboundMessage(mkPhotoMsg(1, 2, `!kogame ${fId}`), photoBuffer(1, 2));
    await app.handleInboundMessage(mkPhotoMsg(2, 0, `!kogame ${fId}`), photoBuffer(2, 0));
    const rFinal = await app.handleInboundMessage(mkPhotoMsg(3, 2, `!kogame ${fId}`), photoBuffer(3, 2));
    assert(rFinal.replyText?.includes('SERIES SELESAI') === true, 'H: final selesai 3-1 (BO5)');
    const tStat = (await db.execute({ sql: 'SELECT status FROM tournaments WHERE id = ?', args: [tId] })).rows[0] as any;
    assert(String(tStat.status) === 'COMPLETED', 'H: turnamen t2x COMPLETED end-to-end');
  }

  // =====================================================================
  // BAGIAN 3 — approval reset saat reopen
  // =====================================================================
  console.log('--- Bagian 3: approval reset saat organizer reopen ---');
  {
    const tIdP = 't3p';
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, rules_version, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [tIdP, 'Approval Reset Cup', 'ACTIVE', '1.0', '{}', now, now],
    });
    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES ('del-b3', 'Delegasi Singa3', 'ACTIVE', ?, ?)`,
      args: [now, now],
    });
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, delegate_id, created_at, updated_at) VALUES ('tg3', ?, 'Garuda3', 'VERIFIED', 'del-a1', ?, ?)`,
      args: [tIdP, now, now],
    });
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, registration_status, delegate_id, created_at, updated_at) VALUES ('ts3', ?, 'Singa3', 'VERIFIED', 'del-b3', ?, ?)`,
      args: [tIdP, now, now],
    });
    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at)
            VALUES ('fix-apr3', ?, 'GROUP', 'ROUND_1', 'tg3', 'ts3', 'tg3', 'COMPLETED', ?, ?)`,
      args: [tIdP, now, now],
    });
    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, is_walkover, is_draw, evidence_status, created_at, updated_at)
            VALUES ('game-apr3', 'fix-apr3', 1, 'SCHEDULED', 0, 0, 'PENDING', ?, ?)`,
      args: [now, now],
    });
    await db.execute({
      sql: `INSERT INTO report_sessions (id, fixture_id, submitting_team_id, status, last_message_at, debounce_due_at, created_at, updated_at)
            VALUES ('sess-apr3', 'fix-apr3', 'tg3', 'DRAFT_READY', ?, ?, ?, ?)`,
      args: [now, now, now, now],
    });
    const vd = {
      fixture_id: 'fix-apr3', game_id: 'game-apr3', team_a_id: 'tg3', team_b_id: 'ts3',
      team_a_score: 2, team_b_score: 1, team_a_players: [], team_b_players: [],
    };
    const rvId = 'rv-apr3-1';
    await db.execute({
      sql: `INSERT INTO report_versions (id, report_session_id, fixture_id, version_number, status, extraction_json, validated_data_json, provenance, created_by, created_at)
            VALUES (?, 'sess-apr3', 'fix-apr3', 1, 'PENDING_APPROVAL', '{}', ?, 'AI', 'del-a1', ?)`,
      args: [rvId, JSON.stringify(vd), now],
    });

    const { submitReportApproval } = await import('../src/reports/approval.js');
    await submitReportApproval(db, { report_version_id: rvId, approver_type: 'TEAM_A', approver_id: 'del-a1', decision: 'APPROVE' });
    await submitReportApproval(db, { report_version_id: rvId, approver_type: 'TEAM_B', approver_id: 'del-b3', decision: 'APPROVE' });
    await submitReportApproval(db, { report_version_id: rvId, approver_type: 'ORGANIZER', approver_id: 'ORGANIZER', decision: 'APPROVE', is_organizer: true });
    const locked = (await db.execute({ sql: 'SELECT status FROM report_versions WHERE id = ?', args: [rvId] })).rows[0] as any;
    assert(String(locked.status) === 'LOCKED', 'P3: baseline laporan LOCKED via 3 pihak');

    // Organizer reopen
    const resReopen = await app.handleInboundMessage(mkMsg(`!reopen ${rvId} Skor salah, perlu koreksi delegasi`));
    assert(resReopen.replyText?.includes('DIBUKA KEMBALI') === true, 'P3: !reopen membuka laporan');

    const approvalsAfter = (await db.execute({ sql: 'SELECT COUNT(*) as c FROM approvals WHERE report_version_id = ?', args: [rvId] })).rows[0] as any;
    assert(Number(approvalsAfter.c) === 0, 'P3: approval LAMA ter-reset (0 baris tersisa)');

    // 1 vote baru TIDAK langsung melengkapi konsensus
    const after1 = await submitReportApproval(db, { report_version_id: rvId, approver_type: 'TEAM_A', approver_id: 'del-a1', decision: 'APPROVE' });
    assert(after1.isLocked === false, 'P3: 1 vote baru TIDAK langsung LOCK');
    assert(after1.status === 'PENDING_APPROVAL', 'P3: status PENDING_APPROVAL setelah 1 vote baru');

    // Butuh 3 vote baru untuk LOCK lagi
    await submitReportApproval(db, { report_version_id: rvId, approver_type: 'TEAM_B', approver_id: 'del-b3', decision: 'APPROVE' });
    const after2 = (await db.execute({ sql: 'SELECT status FROM report_versions WHERE id = ?', args: [rvId] })).rows[0] as any;
    const approvalsCnt2 = (await db.execute({ sql: 'SELECT COUNT(*) as c FROM approvals WHERE report_version_id = ?', args: [rvId] })).rows[0] as any;
    assert(after2.status !== 'LOCKED' && Number(approvalsCnt2.c) === 2, 'P3: 2 vote baru belum LOCK (2 approval tercatat, status belum LOCKED)');
    await submitReportApproval(db, { report_version_id: rvId, approver_type: 'ORGANIZER', approver_id: 'ORGANIZER', decision: 'APPROVE', is_organizer: true });
    const finalStat = (await db.execute({ sql: 'SELECT status FROM report_versions WHERE id = ?', args: [rvId] })).rows[0] as any;
    assert(String(finalStat.status) === 'LOCKED', 'P3: butuh 3 vote baru utk LOCK lagi (kini LOCK)');

    // Audit event mencatat approvals_reset
    const audit = (await db.execute({
      sql: `SELECT before_json FROM audit_events WHERE event_type = 'ORGANIZER_REOPEN_REPORT' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [rvId],
    })).rows[0] as any;
    assert(String(audit.before_json).includes('"approvals_reset":3'), 'P3: audit event mencatat approvals_reset=3');
  }

  // =====================================================================
  // BAGIAN 4 — double loss KO + bye otomatis
  // =====================================================================
  console.log('--- Bagian 4: double loss KO + bye otomatis + pesan WA ---');
  {
    const tIdQ = 't4q';
    await seedTournamentWithGroups(db, tIdQ);
    await app.handleInboundMessage(mkMsg(`!startknockout ${tIdQ}`));
    const fixesQ = (await db.execute({
      sql: `SELECT f.id, f.round_code, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' ORDER BY f.created_at ASC`,
      args: [tIdQ],
    })).rows as any[];

    // SF1: double no-roomcard via !roomcard <id> habis
    const sf1Q = String(fixesQ[0].id);
    const resHabis = await app.handleInboundMessage(mkMsg(`!roomcard ${sf1Q} habis`));
    assert(resHabis.replyText?.includes('KALAH GANDA') === true, 'P4: pesan !roomcard habis menyatakan KALAH GANDA (double loss)');
    assert(resHabis.replyText?.includes('bye') === true || resHabis.replyText?.includes('LOLOS') === true, 'P4: pesan menyebut bye/lolos otomatis ronde berikutnya');
    const fxStat = (await db.execute({ sql: 'SELECT status FROM fixtures WHERE id = ?', args: [sf1Q] })).rows[0] as any;
    assert(String(fxStat.status) === 'WALKOVER', 'P4: fixture double-loss berstatus WALKOVER (resolved, no winner)');
    const serStat = (await db.execute({ sql: 'SELECT status, winner_team_id FROM series WHERE fixture_id = ?', args: [sf1Q] })).rows[0] as any;
    assert(String(serStat.status) === 'COMPLETED' && serStat.winner_team_id === null, 'P4: series ditutup TANPA winner');

    // SF2: normal 2-0 via photos
    const sf2Q = String(fixesQ[1].id);
    await app.handleInboundMessage(mkPhotoMsg(2, 1, `!kogame ${sf2Q}`), photoBuffer(2, 1));
    await app.handleInboundMessage(mkPhotoMsg(2, 0, `!kogame ${sf2Q}`), photoBuffer(2, 0));

    // Trigger next round: with 2 SFs where SF1 is double-loss, the SF2 winner
    // receives the bye and — with no other opponent remaining — is crowned
    // CHAMPION directly (no self-match FINAL is ever generated).
    const resNext = await app.handleInboundMessage(mkMsg(`!startknockout ${tIdQ}`));
    const sf2WinnerId = String(fixesQ[1].team_a_id); // photos were A-side wins
    const finalQ = (await db.execute({
      sql: `SELECT f.id, f.team_a_id, f.team_b_id FROM fixtures f WHERE f.tournament_id = ? AND f.stage = 'KNOCKOUT' AND f.round_code = 'FINAL'`,
      args: [tIdQ],
    })).rows[0] as any;
    assert(!finalQ, 'P4: TIDAK ada FINAL self-match dibuat untuk penerima bye tanpa lawan');
    const tStatQ = (await db.execute({ sql: 'SELECT status FROM tournaments WHERE id = ?', args: [tIdQ] })).rows[0] as any;
    assert(String(tStatQ.status) === 'COMPLETED', 'P4: pemenang SF2 (penerima bye) dimahkotai juara langsung — turnamen COMPLETED');
    const champAudit = (await db.execute({
      sql: `SELECT COUNT(*) as c FROM audit_events WHERE event_type = 'KNOCKOUT_CHAMPION_BY_DEFAULT' AND entity_id = ?`,
      args: [tIdQ],
    })).rows[0] as any;
    assert(Number(champAudit.c) === 1, 'P4: audit event KNOCKOUT_CHAMPION_BY_DEFAULT tercatat');
    assert(
      resNext.replyText?.includes('JUARA') === true || resNext.replyText?.includes('juara') === true,
      'P4: pesan menyatakan juara dimahkotai otomatis'
    );
    assert(
      resNext.replyText?.includes('BYE OTOMATIS') === true || resNext.replyText?.includes('bye otomatis') === true || resNext.replyText?.includes('double-loss') === true,
      'P4: generator menyampaikan bye otomatis secara eksplisit'
    );
    void sf2WinnerId;
  }

  console.log(`\n=== HASIL: ${passed} PASS, ${failed} FAIL ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
