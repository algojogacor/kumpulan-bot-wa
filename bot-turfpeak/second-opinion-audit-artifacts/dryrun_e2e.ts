/**
 * SECOND-OPINION AUDIT (READ-ONLY) — DRY-RUN E2E
 * Membuktikan sendiri call chain utama dari pesan masuk sampai efek akhir (DB + pesan keluar),
 * dengan mock WhatsApp sender & mock AI provider — TIDAK mengubah file produksi mana pun.
 */
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../src/db/migrate.js';
import { createApp, type FlashPeakApp } from '../src/index.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';
import type { SendOptions } from '../src/whatsapp/types.js';

const log = (...a: unknown[]) => console.log(...a);
let PASS = 0, FAIL = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { PASS++; log(`  ✅ ${name}`); }
  else {
    FAIL++;
    let d = '';
    if (detail !== undefined) {
      try { d = ' :: ' + String(JSON.stringify(detail)).slice(0, 120); } catch { d = ' :: [unserializable]'; }
    }
    log(`  ❌ ${name}${d}`);
  }
}

// ---- Mock WhatsApp sender: merekam SEMUA pesan keluar ----
class MockSender {
  public sent: Array<{ chatId: string; text: string; mentions?: string[] }> = [];
  public sentKeys: string[] = [];
  async sendText(chatId: string, text: string, options?: SendOptions): Promise<string> {
    const key = 'mock-msg-' + randomUUID().slice(0, 8);
    let mentions: string[] | undefined;
    if (options && options.mentions && options.mentions.length > 0) {
      mentions = [...options.mentions];
    }
    this.sent.push({ chatId, text, mentions });
    this.sentKeys.push(key);
    return key;
  }
  async sendQuote(chatId: string, text: string, quoted: any, options?: SendOptions): Promise<string> {
    return this.sendText(chatId, text, options);
  }
}

// ---- Mock AI provider router: mengikuti kontrak AIResponse { raw_text, parsed_json, telemetry } ----
class MockProviderRouter {
  public calls: Array<{ task: string; promptHead: string }> = [];
  private db: Client | null = null;
  private rosters: { teamA: string[]; teamB: string[] } | null = null;
  bindRosters(teamA: string[], teamB: string[]) {
    this.rosters = { teamA, teamB };
  }
  async execute<T>(req: { task: string; system_prompt?: string; prompt?: string; images?: unknown[] }): Promise<T> {
    this.calls.push({ task: req.task, promptHead: String(req.prompt || '').slice(0, 80) });
    const p = req.prompt || '';
    const ok = (out: unknown) =>
      ({ raw_text: JSON.stringify(out), parsed_json: out, telemetry: { provider: 'GROQ', model: 'mock', latency_ms: 1 } } as unknown as T);
    if (req.task === 'CLASSIFY') {
      const isGk = /kiper|gk\b|keeper/i.test(p);
      return ok({
        screen_type: isGk ? 'INDIVIDUAL_PLAYER_DETAIL' : 'MAIN_MATCH_SUMMARY',
        confidence: 0.99,
        reason: 'mock',
        visual_features: [],
        uncertainties: [],
      });
    }
    if (req.task === 'EXTRACT_MATCH') {
      const namesA = this.rosters?.teamA ?? ['GkA', 'P1', 'P2', 'P3', 'P4'];
      const namesB = this.rosters?.teamB ?? ['GkB', 'Q1', 'Q2', 'Q3', 'Q4'];
      const mk = (names: string[], winner: boolean, concede: number) => names.map((n, i) => ({
        nickname_raw: n,
        rating: Number((8.0 + (i === 1 ? 1.1 : i * 0.1)).toFixed(1)),
        goals: i === 1 ? (winner ? 2 : 1) : 0,
        assists: i === 2 && winner ? 1 : 0,
        passes: 22 + i * 4,
        defense: 1 + i,
        goalkeeper_saves: null,
      }));
      const out = {
        screen_type: 'MAIN_MATCH_SUMMARY',
        team_a_score: 2,
        team_b_score: 1,
        result_indicator: 'WIN',
        team_a_players: mk(namesA, true, 1),
        team_b_players: mk(namesB, false, 2),
        confidence: 0.95,
        unreadable_fields: [],
        uncertainties: [],
      };
      return ok(out);
    }
    if (req.task === 'EXTRACT_GOALKEEPER') {
      return ok({
        screen_type: 'INDIVIDUAL_PLAYER_DETAIL',
        summary: { nickname: null, defense_raw: 6, goalkeeper_saves: 6, clean_sheets: 0, uncertainties: [] },
        confidence: 0.9,
        uncertainties: [],
      });
    }
    if (req.task === 'PARSE_ROSTER') {
      return ok({ team_name: null, gk_name: null, starter_list: [], sub_list: [], confidence: 0.5, uncertainties: ['mock: no parse'] });
    }
    if (req.task === 'PARSE_CORRECTION') {
      return ok({ patch: {} });
    }
    throw new Error('MockProviderRouter: unknown task ' + req.task);
  }
}

// ---- Mock media client (mengikuti antarmuka & perilaku DB FlashPeakMediaClient.uploadMedia) ----
class MockMediaClient {
  public uploads: any[] = [];
  private db: Client;
  constructor(db: Client) { this.db = db; }
  async uploadMedia(o: any) {
    const asset = {
      id: 'asset-' + randomUUID().slice(0, 8),
      storage_provider: 'FLASHPEAK_VM_MEDIA',
      storage_key: 'private/match_evidence/' + o.filename,
      media_role: o.mediaRole || 'MAIN_MATCH',
      mime_type: o.mimeType || 'image/jpeg',
      byte_size: (o.buffer as Buffer).length,
      sha256: 'fake-hash-' + randomUUID().slice(0, 8),
      visibility: o.visibility || 'PRIVATE',
      status: 'STORED',
      uploaded_by_delegate_id: o.uploadedByDelegateId || null,
      source_message_id: o.sourceMessageId || randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.uploads.push(asset);
    // replikasi persist metadata ke Turso seperti FlashPeakMediaClient lakukan
    await this.db.execute({
      sql: `INSERT INTO media_assets (
        id, storage_provider, storage_key, media_role,
        mime_type, byte_size, sha256, visibility,
        status, uploaded_by_delegate_id, source_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        asset.id, asset.storage_provider, asset.storage_key, asset.media_role,
        asset.mime_type, asset.byte_size, asset.sha256, asset.visibility,
        asset.status, asset.uploaded_by_delegate_id, asset.source_message_id, asset.created_at,
      ],
    });
    return asset;
  }
  async downloadMedia() { return { buffer: Buffer.from('fake-jpeg-bytes'), mimeType: 'image/jpeg', sha256: 'fake' }; }
}

function textMsg(senderJid: string, chatId: string, text: string, replyToKey: string | null = null): NormalizedMessage {
  return {
    id: randomUUID(),
    provider_message_key: randomUUID(),
    chat_id: chatId,
    sender_raw_address: senderJid,
    sender_normalized_address: senderJid,
    address_type: 'JID',
    is_from_me: false,
    participant: senderJid,
    push_name: 'Sender',
    message_timestamp: new Date().toISOString(),
    received_at: new Date().toISOString(),
    message_type: 'TEXT',
    text_body: text,
    caption: null,
    reply_to_key: replyToKey,
    quoted_participant: null,
    quoted_text: null,
    raw_message: {} as any,
  } as NormalizedMessage;
}
function imgMsg(senderJid: string, chatId: string, caption: string | null): NormalizedMessage {
  return {
    id: randomUUID(),
    provider_message_key: randomUUID(),
    chat_id: chatId,
    sender_raw_address: senderJid,
    sender_normalized_address: senderJid,
    address_type: 'JID',
    is_from_me: false,
    participant: senderJid,
    push_name: 'Sender',
    message_timestamp: new Date().toISOString(),
    received_at: new Date().toISOString(),
    message_type: 'IMAGE',
    text_body: null,
    caption,
    reply_to_key: null,
    quoted_participant: null,
    quoted_text: null,
    media_metadata: { fileName: 'shot.jpg', mimetype: 'image/jpeg' },
    raw_message: {} as any,
  } as any;
}

async function main() {
  log('=== [1] Boot: DB + migrations ===');
  const db: Client = createClient({ url: 'file::memory:?cache=shared' });
  const mig = await runMigrations(db);
  check('migrations applied (>=1)', mig.applied.length >= 1, mig.applied.length);

  const orgJid = '6289999999999@s.whatsapp.net';
  const groupJid = '120363012345678901@g.us';
  const mockSender = new MockSender();
  const mockRouter = new MockProviderRouter();
  const mockMedia = new MockMediaClient(db);

  // Fixture dipilih DULU sebelum app dibuat supaya mock extractor bisa menarik nickname roster asli dari DB.
  // (App dibuat sesudahnya; urutan ini hanya kebutuhan dry-run.)

  const app: FlashPeakApp = createApp({
    db,
    mediaClient: mockMedia as any,
    providerRouter: mockRouter as any,
    sender: mockSender as any,
    centralGroupJid: groupJid,
    organizerJid: orgJid,
    organizerPhone: '6289999999999',
    quietWindowMs: 5, // dipercepat untuk dry-run
  });
  app.setSender(mockSender as any);

  log('\n=== [2] !createtournament / !addteam x8 / !roster ===');
  let r = await app.handleInboundMessage(textMsg(orgJid, groupJid, '!createtournament Flash Peak Test Cup'));
  check('createtournament reply', Boolean(r?.replyText && /BERHASIL/.test(r.replyText!)), r?.replyText?.slice(0, 80));

  const teams = ['Alpha FC', 'Beta FC', 'Gamma FC', 'Delta FC', 'Epsilon FC', 'Zeta FC', 'Eta FC', 'Theta FC'];
  for (const t of teams) {
    await app.handleInboundMessage(textMsg(orgJid, groupJid, `!addteam ${t}`));
  }
  const teamsRes = await db.execute('SELECT COUNT(*) c FROM teams');
  check('8 teams in DB', Number(teamsRes.rows[0][0]) === 8, teamsRes.rows[0][0]);

  // roster deterministik (tanpa AI): parseRosterInput path
  const rosterA = await app.handleInboundMessage(textMsg(orgJid, groupJid, '!roster Alpha FC GK: GkA | Inti: P1, P2, P3, P4 | Cadangan: S1'));
  check('roster register reply', Boolean(rosterA?.replyText && /BERHASIL DIDAFTARKAN/.test(rosterA.replyText!)), rosterA?.replyText?.slice(0, 100));
  for (const t of teams.slice(1)) {
    // nickname unik per tim (hindari bentrok cross-team; Eta 'egk' akan bentrok dengan Epsilon 'egk')
    const gk = t.slice(0, 2).toLowerCase().replace(/\s+/g, '') + 'gk';
    await app.handleInboundMessage(textMsg(orgJid, groupJid, `!roster ${t} GK: ${gk} | Inti: ${t.slice(0, 2).replace(/\s+/g, '')}1, ${t.slice(0, 2).replace(/\s+/g, '')}2, ${t.slice(0, 2).replace(/\s+/g, '')}3, ${t.slice(0, 2).replace(/\s+/g, '')}4`));
  }
  const playersRes = await db.execute('SELECT COUNT(*) c FROM players');
  // 8 tim: Alpha=6 pemain (1GK+4INTI+1CAD), 7 tim=5 pemain => 6+35=41
  check('players inserted = 41 (semua roster valid)', Number(playersRes.rows[0][0]) === 41, playersRes.rows[0][0]);

  log('\n=== [3] !draw ===');
  const drawSentBefore = mockSender.sent.length;
  const drawRes = await app.handleInboundMessage(textMsg(orgJid, groupJid, '!draw'));
  const draws = await db.execute('SELECT COUNT(*) c FROM group_draws');
  const groups = await db.execute('SELECT COUNT(*) c FROM groups');
  const fixtures = await db.execute('SELECT COUNT(*) c FROM fixtures');
  const tournaments = await db.execute("SELECT status FROM tournaments");
  check('group_draws created', Number(draws.rows[0][0]) === 1);
  check('groups created (8 tim => 2 grup)', Number(groups.rows[0][0]) === 2, groups.rows[0][0]);
  check('fixtures created (8 tim => 2 grup x 4 tim; round-robin 4 tim = 3 ronde x 4 match = 12)', Number(fixtures.rows[0][0]) === 12, fixtures.rows[0][0]);
  check('tournament status ACTIVE', String((tournaments.rows[0] as any)[0]) === 'ACTIVE', (tournaments.rows[0] as any)[0]);
  check('draw sent progressive reveal messages (>= 9 outbound)', mockSender.sent.length - drawSentBefore >= 9, mockSender.sent.length - drawSentBefore);

  log('\n=== [4] Evidence ingestion → debounce → batch → draft ===');
  // ambil satu fixture grup
  const fix = await db.execute("SELECT f.id, f.team_a_id, f.team_b_id, ta.team_name, tb.team_name FROM fixtures f JOIN teams ta ON f.team_a_id=ta.id JOIN teams tb ON f.team_b_id=tb.id WHERE f.stage='GROUP' LIMIT 1");
  const fixId = String((fix.rows[0] as any)[0]);
  const teamAId = String((fix.rows[0] as any)[1]);
  const teamBId = String((fix.rows[0] as any)[2]);
  const nameA = String((fix.rows[0] as any)[3]);
  const nameB = String((fix.rows[0] as any)[4]);
  log(`  fixture: ${nameA} vs ${nameB} (${fixId})`);

  // bind nickname roster ASLI kedua tim ke mock extractor supaya lolos validasi roster membership
  const rostersFix = await db.execute({
    sql: `SELECT team_id, nickname_raw FROM players WHERE team_id IN (?, ?) AND status = 'ACTIVE' ORDER BY roster_slot ASC`,
    args: [teamAId, teamBId],
  });
  const namesA: string[] = [];
  const namesB: string[] = [];
  for (const row of rostersFix.rows as any[]) {
    if (String(row[0]) === teamAId) namesA.push(String(row[1]));
    else namesB.push(String(row[1]));
  }
  mockRouter.bindRosters(namesA.slice(0, 5), namesB.slice(0, 5)); // lineup = 5 starter (GK + 4 inti), cadangan di luar lineup

  // bind delegates agar submitting team bisa resolved — pakai organizer untuk identitas? Kita pakai resolver internal via app
  // delegasi: buat via roster auto-bind organizer. Untuk simuliasi pengirim tim, kita buat identitas delegate baru:
  const delA = await app.identityResolver.createDelegateWithIdentity('Delegasi ' + nameA, '6287777000001@s.whatsapp.net', 'PHONE', { sourceChatId: groupJid });
  await app.identityResolver.bindDelegateToTeam(teamAId, delA.delegate.id);
  const delB = await app.identityResolver.createDelegateWithIdentity('Delegasi ' + nameB, '6287777000002@s.whatsapp.net', 'PHONE', { sourceChatId: groupJid });
  await app.identityResolver.bindDelegateToTeam(teamBId, delB.delegate.id);

  // tim pemenang (misal nameA) kirim screenshot utama + caption menyebut nama tim
  const mainImg = imgMsg('6287777000001@s.whatsapp.net', groupJid, `hasil akhir menang ${nameA}`);
  const evRes = await app.handleInboundMessage(mainImg, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8]));
  check('evidence handled as EVIDENCE', evRes?.type === 'EVIDENCE' && evRes?.handled === true, evRes);
  check('report session created', Boolean(evRes?.session?.id), evRes?.session?.id);

  const sessRes = await db.execute('SELECT id, status, submitting_team_id FROM report_sessions LIMIT 1');
  const sessRow = sessRes.rows[0] as any;
  check('session COLLECTING (debounce pending)', String(sessRow[1]) === 'COLLECTING', sessRow[1]);
  check('media asset uploaded via media client', mockMedia.uploads.length === 1, mockMedia.uploads.length);

  // Tunggu debounce due (quietWindow=5ms) lalu poll worker
  await new Promise(r => setTimeout(r, 50));
  const batches = await app.processDueDebounceBatches();
  check('batch processed', batches.length === 1, batches.length);
  const b = batches[0];
  check('batch status DRAFT_CREATED (AI valid)', b?.status === 'DRAFT_CREATED', b?.status);
  if (b?.status !== 'DRAFT_CREATED') {
    // cetak error untuk diagnosis
    const sessFail = await db.execute('SELECT id FROM report_sessions LIMIT 1');
    const verFail = await db.execute('SELECT extraction_json FROM report_versions LIMIT 1');
    if (verFail.rows.length > 0) {
      try {
        const ex = JSON.parse(String((verFail.rows[0] as any)[0]));
        console.log('  [debug] extraction summary_data:', JSON.stringify(ex.summary_data || ex).slice(0, 300));
      } catch { /* noop */ }
    }
    console.log('  [debug] batch error:', b?.error);
  }
  check('whatsappSummary formatted', Boolean(b?.whatsappSummary && b.whatsappSummary.length > 50), b?.whatsappSummary?.slice(0, 60));
  check('classifier + extractor invoked (AI wired)', mockRouter.calls.some(c => c.task === 'CLASSIFY') && mockRouter.calls.some(c => c.task === 'EXTRACT_MATCH'), mockRouter.calls.map(c => c.task).slice(-6));

  const versions = await db.execute('SELECT id, status, version_number FROM report_versions');
  check('report_version v1 created', versions.rows.length === 1 && String((versions.rows[0] as any)[2]) === '1');
  const versionId = String((versions.rows[0] as any)[0]);
  const vStatus0 = String((versions.rows[0] as any)[1]);
  check('version status PENDING_APPROVAL', vStatus0 === 'PENDING_APPROVAL', vStatus0);

  log('\n=== [5] Approval 3-party → LOCK → stats writeback ===');
  // TEAM_A approve
  const appr1 = await app.submitApproval(versionId, 'TEAM_A', delA.delegate.id, 'APPROVE');
  check('TEAM_A vote recorded (not locked yet)', appr1.isLocked === false && appr1.status === 'PENDING_APPROVAL', appr1.message);
  // TEAM_B approve
  const appr2 = await app.submitApproval(versionId, 'TEAM_B', delB.delegate.id, 'APPROVE');
  check('TEAM_B vote recorded (not locked yet)', appr2.isLocked === false, appr2.message);
  // ORGANIZER approve => LOCK
  const appr3 = await app.submitApproval(versionId, 'ORGANIZER', orgJid, 'APPROVE', true);
  check('3-party consensus => LOCKED', appr3.isLocked === true && appr3.status === 'LOCKED', appr3.message);

  const verAfter = await db.execute('SELECT status FROM report_versions WHERE id = ?', [versionId]);
  check('version row LOCKED in DB', String((verAfter.rows[0] as any)[0]) === 'LOCKED');

  // Ambil game yang terkait report version via join validated_data_json (game_id tertanam di JSON)
  const gameByValidated = await db.execute({
    sql: `SELECT g.id, g.status, g.team_a_score, g.team_b_score FROM games g
          JOIN report_versions rv ON rv.validated_data_json LIKE '%"' || g.id || '"%'
          WHERE rv.id = ? LIMIT 1`,
    args: [versionId],
  });
  if (gameByValidated.rows.length === 0) {
    console.error('  [debug] gameByValidated kosong — dump report_versions:');
    const dump = await db.execute('SELECT id, validated_data_json FROM report_versions');
    for (const r of dump.rows as any[]) console.log('   ver', String(r[0]).slice(0, 8), String(r[1]).slice(0, 200));
  }
  const g = (gameByValidated.rows.length > 0 ? gameByValidated.rows[0] : null) as any;
  check('game COMPLETED with score 2-1', g && String(g[1]) === 'COMPLETED' && Number(g[2]) === 2 && Number(g[3]) === 1, g ? [g[1], g[2], g[3]] : 'no game row matched');
  const statsRes = await db.execute('SELECT COUNT(*) c FROM player_game_stats');
  check('player_game_stats written (10 pemain)', Number(statsRes.rows[0][0]) === 10, statsRes.rows[0][0]);
  const fixStat = await db.execute('SELECT status FROM fixtures WHERE id = ?', [fixId]);
  check('fixture COMPLETED', String((fixStat.rows[0] as any)[0]) === 'COMPLETED', (fixStat.rows[0] as any)[0]);
  const standRes = await db.execute('SELECT COUNT(*) c FROM standings');
  check('standings rows persisted', Number(standRes.rows[0][0]) > 0, standRes.rows[0][0]);

  log('\n=== [6] !standings (efek akhir ke user) ===');
  const st = await app.handleInboundMessage(textMsg(orgJid, groupJid, '!standings A'));
  check('standings reply contains table', Boolean(st?.replyText && /Klasemen|KLASEMEN|Posisi|Poin/i.test(st.replyText!)), st?.replyText?.slice(0, 80));

  log('\n=== [7] Natural-language paths ===');
  const nl1 = await app.handleInboundMessage(textMsg('6287777000001@s.whatsapp.net', groupJid, '!apa jadwal hari ini'));
  check('NL jadwal hari ini → matchday status', Boolean(nl1?.replyText && nl1.replyText.length > 20), nl1?.replyText?.slice(0, 60));
  const nl2 = await app.handleInboundMessage(textMsg('6287777000001@s.whatsapp.net', groupJid, '!gimana klasemen grup A'));
  check('NL klasemen → standings', Boolean(nl2?.replyText && /Klasemen|KLASEMEN/i.test(nl2.replyText!)), nl2?.replyText?.slice(0, 60));
  const nl3 = await app.handleInboundMessage(textMsg('6287777000001@s.whatsapp.net', groupJid, '!klaim WO untuk lawan ga hadir sesuai jadwal'));
  check('NL WO claim guidance (alasan/flow)', Boolean(nl3?.replyText), nl3?.replyText?.slice(0, 60));

  log('\n=== [8] Unknown command & non-registered group rejection ===');
  const unk = await app.handleInboundMessage(textMsg('6287777000001@s.whatsapp.net', groupJid, '!perintahanehtidakada'));
  check('unknown command → UNKNOWN_COMMAND reply', Boolean(unk?.replyText && /tidak dikenali/i.test(unk.replyText!)), unk?.replyText?.slice(0, 60));
  const otherGroup = '120363099999999999@g.us';
  const rej = await app.handleInboundMessage(textMsg('6287777000001@s.whatsapp.net', otherGroup, '!standings A'));
  check('command in non-central group rejected (UNAUTHORIZED_GROUP)', Boolean(rej?.commandResult?.error === 'UNAUTHORIZED_GROUP' || /grup turnamen resmi/i.test(rej?.replyText || '')), rej?.replyText?.slice(0, 60));

  log('\n================ HASIL DRY-RUN ================');
  log(`PASS: ${PASS}  FAIL: ${FAIL}`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
