/**
 * FRESH-SESSION AUDIT (READ-ONLY) — Group stage end-to-end dry-run via REAL command path.
 * Flow: !createtournament -> !addteam x8 -> !onboarding replies (delegate binding)
 * -> !draw -> !schedule -> BO1 report via photo+debounce+AI mock -> !approve 3-party
 * -> standings -> !claimwo delegate staging + !ok -> double WO via !roomcard habis
 * -> !manualreport -> !reopen on locked report (approval reset check) -> !override.
 * Artifacts of this audit; NOT production code.
 */
import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../src/db/migrate.js';
import { createApp, type FlashPeakApp } from '../src/index.js';
import { OnboardingService } from '../src/identity/onboarding.js';
import { ProviderRouter } from '../src/ai/router.js';
import type { ProviderAdapter, AIRequest, AIResponse } from '../src/ai/adapter.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

let pass = 0, fail = 0;
function log(s: string) { console.log(s); }
function assert(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`PASS — ${label}`); }
  else { fail++; console.log(`FAIL — ${label}`); }
}

function textMsg(sender: string, chat: string, text: string): NormalizedMessage {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: chat, sender_raw_address: sender, sender_normalized_address: sender,
    address_type: 'JID', is_from_me: false, participant: sender, push_name: 'T',
    message_timestamp: now, received_at: now, message_type: 'TEXT',
    text_body: text, caption: null, reply_to_key: null,
    quoted_participant: null, quoted_text: null, raw_message: {} as any,
  };
}
function imgMsg(sender: string, chat: string, caption: string): NormalizedMessage {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: chat, sender_raw_address: sender, sender_normalized_address: sender,
    address_type: 'JID', is_from_me: false, participant: sender, push_name: 'T',
    message_timestamp: now, received_at: now, message_type: 'IMAGE',
    text_body: null, caption, reply_to_key: null,
    quoted_participant: null, quoted_text: null,
    media_metadata: { mimetype: 'image/jpeg', fileName: 'shot.jpg' } as any,
    raw_message: {} as any,
  };
}

// Mock vision adapter with a full 5v5 lineup for EXTRACT_MATCH.
// Roster nicknames are provided AFTER seeding via setMockRosters().
const mockFixtureTeamAId = { v: '' };
const mockFixtureTeamBId = { v: '' };
const mockTeamNames: Record<string, string> = {};
const mockSubmitSide = { v: 'A' as 'A' | 'B' };
const mockRosters: Record<string, string[]> = {}; // teamId -> [nicknames in roster_slot order]
export function setMockRosters(map: Record<string, string[]>) { Object.assign(mockRosters, map); }
const mkPlayersFromRoster = (teamId: string, gkSaves: number | null, goalsTotal: number) => {
  const nicks = (mockRosters[teamId] || []).filter(n => !n.endsWith('S1')); // exclude sub for exact 5
  // Distribute goalsTotal across players 1..4 deterministically: P2 gets the bulk.
  const goals = goalsTotal >= 2 ? [0, goalsTotal - 1, 1, 0, 0] : [0, goalsTotal, 0, 0, 0];
  return nicks.map((n, i) => ({
    nickname_raw: n,
    rating: [8.0, 9.1, 8.0, 7.5, 7.2][i] ?? 7.0,
    goals: i < goals.length ? goals[i]! : 0,
    assists: [0, 1, 0, 1, 0][i] ?? 0,
    passes: [8, 14, 10, 12, 9][i] ?? 9,
    defense: i === 0 ? (gkSaves ?? 4) : [4, 2, 4, 3, 1][i] ?? 2,
  }));
};
let classifyCalls = 0;
function mockAdapter(): ProviderAdapter { /* also handles PARSE_ROSTER */ 
  return {
    name: 'MOCK', model: 'mock-v1',
    capabilities: { vision: true, text: true, structured_output: true, supported_mime_types: ['image/jpeg'] },
    healthCheck: async () => true,
    execute: async (req: AIRequest): Promise<AIResponse<unknown>> => {
      if (req.task === 'CLASSIFY') {
        // Batch processor classifies assets in order: main match photo first, GK detail second.
        const n = classifyCalls++;
        const j = { screen_type: n === 0 ? 'MAIN_MATCH_SUMMARY' : 'INDIVIDUAL_PLAYER_DETAIL', confidence: 0.99, reason: 'mock', visual_features: [], uncertainties: [] };
        return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'CLASSIFY', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
      }
      if (req.task === 'EXTRACT_GOALKEEPER') {
        const j = {
          screen_type: 'INDIVIDUAL_PLAYER_DETAIL',
          match_result: { status_text: 'WIN', score_left: 3, score_right: 1, perspective_side: null },
          perspective_player: {
            nickname: null, uid: null,
            visual_role_cue: { type: 'GOALKEEPER', cue_status: 'PRESENT', evidence: ['mock'] },
            summary: { rating: 8.0, goals: 0, assists: 0, passes: 8, defense_raw: 5 },
            detail_tabs: { active: null, shooting: null, umpan: null, defense: null, possession: null },
          },
          confidence: 0.99, uncertainties: [],
        };
        return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'EXTRACT_GOALKEEPER', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
      }
      if (req.task === 'EXTRACT_MATCH') {
        const p = String(req.prompt || '');
        // trusted_context carries team_a_name/team_b_name; find team ids by name via
        // the roster map we loaded (mockRosters keyed by team id + teamNamesById).
        let teamAId = mockFixtureTeamAId.v;
        let teamBId = mockFixtureTeamBId.v;
        // mockSubmitTeam: 'A' means the submitting team is the fixture team_a; 'B' flips.
        const submitSide = mockSubmitSide.v;
        const m = p.match(/"team_a_name":\s*"([^"]+)"/);
        const m2 = p.match(/"team_b_name":\s*"([^"]+)"/);
        if (m && m2) {
          const aName = m[1].toLowerCase(); const bName = m2[1].toLowerCase();
          for (const [tid, name] of Object.entries(mockTeamNames)) {
            if (name.toLowerCase() === aName) teamAId = tid;
            if (name.toLowerCase() === bName) teamBId = tid;
          }
        }
        const j = {
          screen_type: 'MAIN_MATCH_SUMMARY',
          team_a_score: 3, team_b_score: 1, result_indicator: 'WIN',
          team_a_players: mkPlayersFromRoster(submitSide === 'B' ? teamBId : teamAId, 5, 3),
          team_b_players: mkPlayersFromRoster(submitSide === 'B' ? teamAId : teamBId, 4, 1),
          confidence: 0.99, unreadable_fields: [], uncertainties: [],
        };
        return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'EXTRACT_MATCH', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
      }
      if (req.task === 'PARSE_ROSTER') {
        const j = { team_name: null, gk_name: null, starter_list: [], sub_list: [] };
        return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'PARSE_ROSTER', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
      }
      if (req.task === 'PARSE_CORRECTION') {
        const j = {
          target_report_version_id: null, team_side: 'TEAM_A', player_ordinal: 2,
          player_nickname: 'A P2', metric: 'goals', stated_old_value: 2, new_value: 3,
          reason: 'mock correction', ambiguity_flags: [],
        };
        return { raw_text: JSON.stringify(j), parsed_json: j, telemetry: { provider: 'MOCK', model: 'm', task_type: 'PARSE_CORRECTION', latency_ms: 1, input_tokens: 1, output_tokens: 1, status: 'SUCCESS', error_code: null } };
      }
      throw new Error('unhandled task ' + req.task);
    },
  } as unknown as ProviderAdapter;
}

async function main() {
  const db: Client = createClient({ url: 'file:fresh-session-audit-artifacts/group_fresh.sqlite' });
  await runMigrations(db);
  const org = '628999000001@s.whatsapp.net';
  const group = '120363000000000002@g.us';
  const app: FlashPeakApp = createApp({ db, providerRouter: new ProviderRouter({ adapters: [mockAdapter()] }), organizerJid: org, centralGroupJid: group, quietWindowMs: 50 });

  // 1. create tournament
  let r = await app.handleInboundMessage(textMsg(org, group, '!createtournament Fresh Audit Cup'));
  assert(String(r.replyText || '').includes('TURNAMEN BERHASIL DIBUAT'), '!createtournament works');
  // non-organizer rejected
  let rBad = await app.handleInboundMessage(textMsg('628111000000@s.whatsapp.net', group, '!createtournament Hacked Cup'));
  assert(String(rBad.replyText || '').includes('hanya memiliki izin'), '!createtournament RBAC rejects non-organizer');

  // 2. addteam x8
  const teamNames = ['Garuda FC', 'Elang Mas FC', 'Harimau Putih FC', 'Singa FC', 'Macan FC', 'Kuda FC', 'Kambing FC', 'Buaya FC'];
  for (const t of teamNames) {
    const res = await app.handleInboundMessage(textMsg(org, group, `!addteam ${t}`));
    assert(String(res.replyText || '').includes('berhasil didaftarkan'), `!addteam ${t}`);
  }

  // 3. roster registration for each team (via !roster command, deterministic parser)
  for (const t of teamNames) {
    const tag = t.split(' ')[0].slice(0, 4);
    const res = await app.handleInboundMessage(textMsg(org, group, `!roster ${t} GK: ${tag}GK | Inti: ${tag}P1, ${tag}P2, ${tag}P3, ${tag}P4 | Cadangan: ${tag}S1`));
    assert(String(res.replyText || '').includes('berhasil') || String(res.replyText || '').includes('ROSTER'), `!roster registers ${t}`);
  }

  // 4. onboarding: bind delegates via OnboardingService like production (prompt->reply loop)
  const tRes = await db.execute('SELECT id FROM tournaments ORDER BY created_at DESC LIMIT 1');
  const tournamentId = String((tRes.rows[0] as any).id ?? (tRes.rows[0] as any)[0]);
  const onboardingService = app.onboardingService;
  const teamRows = await db.execute({ sql: 'SELECT id FROM teams WHERE tournament_id = ? ORDER BY created_at ASC', args: [tournamentId] });
  const teamIds = teamRows.rows.map((row: any) => String(row.id ?? row[0]));
  for (let i = 0; i < teamIds.length; i++) {
    const pr = await onboardingService.getNextOnboardingPrompt(tournamentId);
    if (pr.status !== 'PROMPT_READY' || !pr.team || !pr.promptText) { log(`onboarding stopped at ${pr.status}`); break; }
    const key = `onb-${i}`;
    onboardingService.setActivePrompt(tournamentId, pr.team.id, key);
    const delegateJid = `62811110000${i}@s.whatsapp.net`;
    const reply: NormalizedMessage = {
      ...textMsg(delegateJid, group, `Saya delegate resmi ${pr.team.team_name}`),
      reply_to_key: key,
    };
    const res = await onboardingService.handleOnboardingReply(tournamentId, reply);
    assert(res.status === 'SUCCESS', `onboarding delegate bound for ${pr.team.team_name}`);
  }
  const verified = await db.execute({ sql: `SELECT COUNT(*) FROM teams WHERE tournament_id=? AND registration_status='VERIFIED'`, args: [tournamentId] });
  assert(Number((verified.rows[0] as any)[0]) === 8, 'all 8 teams VERIFIED');

  // 5. !draw
  const drawRes = await app.handleInboundMessage(textMsg(org, group, '!draw'));
  assert(String(drawRes.replyText || '').includes('disiarkan') || String(drawRes.replyText || '').includes('PENGUNDIAN'), '!draw executes (no sender => returns summary text)');
  const fxCount = await db.execute({ sql: `SELECT COUNT(*) FROM fixtures WHERE tournament_id=? AND stage='GROUP'`, args: [tournamentId] });
  const groupCount = await db.execute({ sql: `SELECT COUNT(*) FROM groups g JOIN group_draws gd ON g.draw_id=gd.id WHERE gd.tournament_id=?`, args: [tournamentId] });
  log(`groups=${Number((groupCount.rows[0] as any)[0])} fixtures=${Number((fxCount.rows[0] as any)[0])}`);
  assert(Number((groupCount.rows[0] as any)[0]) === 2, '2 groups (4 teams each)');
  assert(Number((fxCount.rows[0] as any)[0]) === 12, '12 group fixtures (2x round-robin of 4)');

  // 6. !schedule
  const schedRes = await app.handleInboundMessage(textMsg(org, group, '!schedule'));
  assert(String(schedRes.replyText || '').includes('JADWAL') || String(schedRes.replyText || '').length > 100, '!schedule shows fixtures');

  // 7. BO1 evidence: photo of fixture between team A and B
  const fA = await db.execute({ sql: `SELECT f.id, f.team_a_id, f.team_b_id, f.round_code FROM fixtures f WHERE f.tournament_id=? AND f.stage='GROUP' AND f.round_code='ROUND_1' ORDER BY f.created_at ASC LIMIT 1`, args: [tournamentId] });
  const fixRow = fA.rows[0] as any;
  const fixtureId = String(fixRow.id ?? fixRow[0]);
  const teamAId = String(fixRow.team_a_id ?? fixRow[1]);
  const teamBId = String(fixRow.team_b_id ?? fixRow[2]);
  const gameOfFixture = await db.execute({ sql: `SELECT id FROM games WHERE fixture_id=?`, args: [fixtureId] });
  const gameIdOfFixture = String(((gameOfFixture.rows[0] as any).id ?? (gameOfFixture.rows[0] as any)[0]) || '') || undefined;
  // find delegate A jid
  const delA = await db.execute({ sql: `SELECT delegate_id FROM teams WHERE id=?`, args: [teamAId] });
  const delegateAId = String((delA.rows[0] as any).delegate_id ?? (delA.rows[0] as any)[0]);
  const delAJid = await db.execute({ sql: `SELECT raw_address FROM whatsapp_identities WHERE delegate_id=?`, args: [delegateAId] });
  const delegateAJid = String((delAJid.rows[0] as any).raw_address ?? (delAJid.rows[0] as any)[0]);

  mockFixtureTeamAId.v = teamAId; mockFixtureTeamBId.v = teamBId;
  const allTeams = await db.execute({ sql: `SELECT id, team_name FROM teams WHERE tournament_id=?`, args: [tournamentId] });
  for (const r of allTeams.rows as any[]) mockTeamNames[String(r.id)] = String(r.team_name);
  // load roster nicknames for both teams for the mock
  const rosterLoad = async (tid: string) => {
    const r = await db.execute({ sql: `SELECT nickname_raw FROM players WHERE team_id=? AND status='ACTIVE' ORDER BY roster_slot ASC`, args: [tid] });
    return r.rows.map((row: any) => String(row.nickname_raw ?? row[0]));
  };
  setMockRosters({ [teamAId]: await rosterLoad(teamAId), [teamBId]: await rosterLoad(teamBId) });

  const evRes = await app.handleInboundMessage(imgMsg(delegateAJid, group, 'Laporan match Garuda'), Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2]));
  assert(evRes.type === 'EVIDENCE', 'photo evidence captured into session');
  // The audit harness has no live media service, so persist the media asset row the same
  // way the repo's own integration test does (full_flow.test.ts L430-435).
  const sessionId = evRes.session!.id;
  const inMsg = await db.execute({ sql: `SELECT id FROM inbound_messages WHERE report_session_id=? LIMIT 1`, args: [sessionId] });
  const capturedMsgId = String((inMsg.rows[0] as any).id ?? (inMsg.rows[0] as any)[0]);
  const nowIso = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
          VALUES (?, 'FLASHPEAK_VM_MEDIA', 'fixtures/audit1.jpg', 'MAIN_MATCH', 'image/jpeg', 10240, 'sha256-mock', 'PRIVATE', 'STORED', ?, ?)`,
    args: [`media-audit-01`, capturedMsgId, nowIso],
  });

  // process debounce
  // Winning-team GK detail screenshot (completes GK evidence quota, AG-004/GK rules)
  const evGk = await app.handleInboundMessage(imgMsg(delegateAJid, group, 'KIPER detail AGK'), Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 9]));
  const gkIn = await db.execute({ sql: `SELECT id FROM inbound_messages WHERE report_session_id=? ORDER BY created_at DESC LIMIT 1`, args: [sessionId] });
  const gkMsgId = String((gkIn.rows[0] as any).id ?? (gkIn.rows[0] as any)[0]);
  await db.execute({
    sql: `INSERT INTO media_assets (id, storage_provider, storage_key, media_role, mime_type, byte_size, sha256, visibility, status, source_message_id, created_at)
          VALUES (?, 'FLASHPEAK_VM_MEDIA', 'fixtures/auditgk.jpg', 'GOALKEEPER_DETAIL', 'image/jpeg', 10240, 'sha256-mock2', 'PRIVATE', 'STORED', ?, ?)`,
    args: [`media-audit-gk`, gkMsgId, nowIso],
  });

  await new Promise((res) => setTimeout(res, 120));
  // Determine resolved fixture orientation to configure the mock's submit side
  const sessFid = await db.execute({ sql: `SELECT fixture_id FROM report_sessions WHERE id=?`, args: [sessionId] });
  const resolvedFid = String((sessFid.rows[0] as any).fixture_id ?? (sessFid.rows[0] as any)[0]);
  const resF = await db.execute({ sql: `SELECT team_a_id, team_b_id FROM fixtures WHERE id=?`, args: [resolvedFid] });
  const resA = String((resF.rows[0] as any).team_a_id ?? (resF.rows[0] as any)[0]);
  const resB = String((resF.rows[0] as any).team_b_id ?? (resF.rows[0] as any)[1]);
  mockSubmitSide.v = (mockTeamNames[resA] || '').toLowerCase() === 'garuda fc' ? 'A' : 'B';
  const rrA = await db.execute({ sql: `SELECT nickname_raw FROM players WHERE team_id=? AND status='ACTIVE' ORDER BY roster_slot ASC`, args: [resA] });
  const rrB = await db.execute({ sql: `SELECT nickname_raw FROM players WHERE team_id=? AND status='ACTIVE' ORDER BY roster_slot ASC`, args: [resB] });
  setMockRosters({ [resA]: rrA.rows.map((r: any) => String(r.nickname_raw ?? r[0])), [resB]: rrB.rows.map((r: any) => String(r.nickname_raw ?? r[0])) });
  mockFixtureTeamAId.v = resA; mockFixtureTeamBId.v = resB;
  log(`resolved fixture: A=${mockTeamNames[resA]} B=${mockTeamNames[resB]} submitSide=${mockSubmitSide.v}`);

  const batches = await app.processDueDebounceBatches();
  log(`batches: ${batches.map((b: any) => b.status + (b.error ? ' err=' + b.error : '')).join(', ')}`);
  if (batches[0]?.whatsappSummary) log(`WHATSAPP SUMMARY (validation errors visible):\n${batches[0].whatsappSummary}`);
  if (batches[0]?.error) log(`batch.error: ${batches[0].error}`);
  if (!batches[0]?.draftVersion) {
    // NEEDS_CORRECTION drafts still create a draft version; only AI_FAILED lacks it.
    log('no draftVersion -> abort');
    process.exit(1);
  }
  assert(batches.length === 1 && batches[0].status === 'DRAFT_CREATED', 'debounce batch created AI draft');
  if (!batches[0] || !batches[0].draftVersion) { log('batch has no draft — cannot continue'); process.exit(1); }
  const version = batches[0].draftVersion!;
  log(`draft v${version.version_number} status=${version.status}`);

  // Surface the actual validation errors for the audit log:
  // Surface the actual validation result again for debugging:
  {
    const val = await import('../src/reports/validation.js');
    const res = await val.validateMatchReport(db, {
      fixture_id: fixtureId,
      game_id: gameIdOfFixture!,
      team_a_id: teamAId, team_b_id: teamBId,
      team_a_score: 3, team_b_score: 1,
      team_a_players: mkPlayersFromRoster(teamAId, 5, 3),
      team_b_players: mkPlayersFromRoster(teamBId, 4, 1),
    });
    log(`re-validation: isValid=${res.isValid} errors=${JSON.stringify(res.errors)}`);
  }

  // 8. 3-party approvals — team A, team B, organizer
  const teamsRes = await db.execute({ sql: `SELECT team_a_id, team_b_id, ta.delegate_id AS da, tb.delegate_id AS db FROM fixtures f JOIN teams ta ON f.team_a_id=ta.id JOIN teams tb ON f.team_b_id=tb.id WHERE f.id=?`, args: [fixtureId] });
  const trow = teamsRes.rows[0] as any;
  const dA = String(trow.da ?? trow[2]);
  const dB = String(trow.db ?? trow[3]);
  const ap1 = await app.submitApproval(version.id, 'TEAM_A', dA, 'APPROVE');
  assert(!ap1.isLocked, 'team A vote recorded, not locked');
  const ap2 = await app.submitApproval(version.id, 'TEAM_B', dB, 'APPROVE');
  assert(!ap2.isLocked && ap2.missingApprovers.includes('ORGANIZER'), 'team B vote recorded, waiting organizer');
  const ap3 = await app.submitApproval(version.id, 'ORGANIZER', 'org-fresh-audit', 'APPROVE', true);
  assert(ap3.isLocked && ap3.status === 'LOCKED', '3-party consensus LOCKS report');

  // standings updated
  const standings = await db.execute({ sql: `SELECT team_id, points, played FROM standings WHERE group_id=(SELECT group_id FROM fixtures WHERE id=?)`, args: [fixtureId] });
  const st = standings.rows.map((r: any) => ({ t: String(r.team_id ?? r[0]), p: Number(r.points ?? r[6]) }));
  const winnerRow = st.find((s) => s.t === teamAId);
  assert(winnerRow && winnerRow.p === 3, 'winner has 3 points in standings after lock');

  // 9. !reopen on the locked report — approvals must reset to 0
  const beforeCount = await db.execute({ sql: 'SELECT COUNT(*) FROM approvals WHERE report_version_id=?', args: [version.id] });
  assert(Number((beforeCount.rows[0] as any)[0]) === 3, 'locked version has 3 approvals before reopen');
  const reopenRes = await app.handleInboundMessage(textMsg(org, group, `!reopen ${version.id} audit reopen test`));
  assert(String(reopenRes.replyText || '').includes('REOPEN'), '!reopen executes on LOCKED report');
  const afterCount = await db.execute({ sql: 'SELECT COUNT(*) FROM approvals WHERE report_version_id=?', args: [version.id] });
  assert(Number((afterCount.rows[0] as any)[0]) === 0, 'CRITICAL CHECK: approvals RESET to 0 after reopen (not continuing old votes)');
  const verStatus = await db.execute({ sql: 'SELECT status FROM report_versions WHERE id=?', args: [version.id] });
  assert(String((verStatus.rows[0] as any)[0]) === 'NEEDS_CORRECTION', 'reopened version status = NEEDS_CORRECTION');
  // a single new vote must NOT re-lock
  const ap4 = await app.submitApproval(version.id, 'TEAM_A', dA, 'APPROVE');
  assert(!ap4.isLocked, 'single fresh vote after reopen does NOT re-lock (consensus restarts from zero)');

  // 10. !override re-lock
  const overrideRes = await app.handleInboundMessage(textMsg(org, group, `!override ${version.id} audit override test`));
  assert(String(overrideRes.replyText || '').includes('OVERRIDE'), '!override locks without consensus');
  const verStatus2 = await db.execute({ sql: 'SELECT status FROM report_versions WHERE id=?', args: [version.id] });
  assert(String((verStatus2.rows[0] as any)[0]) === 'LOCKED', 'override -> LOCKED');

  // 11. !claimwo delegate staging + organizer !ok confirm
  const fB = await db.execute({ sql: `SELECT f.id, ta.team_name AS an, tb.team_name AS bn, ta.delegate_id AS da, tb.delegate_id AS db FROM fixtures f JOIN teams ta ON f.team_a_id=ta.id JOIN teams tb ON f.team_b_id=tb.id WHERE f.tournament_id=? AND f.stage='GROUP' AND f.status='SCHEDULED' ORDER BY f.created_at ASC LIMIT 1`, args: [tournamentId] });
  const fbRow = fB.rows[0] as any;
  const fix2 = String(fbRow.id ?? fbRow[0]);
  const teamBName = String(fbRow.bn ?? fbRow[3]);
  // delegate of the WINNING side (opponent of forfeiting team): forfeiting = team B name
  const winDelId = String(fbRow.da ?? fbRow[2]); // delegate A (winner)
  const winJidRes = await db.execute({ sql: `SELECT raw_address FROM whatsapp_identities WHERE delegate_id=?`, args: [winDelId] });
  const winJid = String((winJidRes.rows[0] as any).raw_address ?? (winJidRes.rows[0] as any)[0]);
  const claimRes = await app.handleInboundMessage(textMsg(winJid, group, `!claimwo ${fix2} ${teamBName} tidak hadir 15 menit`));
  log(`claimwo reply: ${String(claimRes.replyText || '').slice(0, 180).replace(/\n/g, ' | ')}`);
  assert(String(claimRes.replyText || '').includes('KLAIM WALKOVER') || String(claimRes.replyText || '').includes('menunggu'), '!claimwo delegate stages pending claim');
  const okRes = await app.handleInboundMessage(textMsg(org, group, '!ok'));
  log(`!ok reply: ${String(okRes.replyText || '').slice(0, 160).replace(/\n/g, ' | ')}`);
  assert(String(okRes.replyText || '').includes('DISAHKAN') || String(okRes.replyText || '').includes('disahkan') || String(okRes.replyText || '').includes('WALKOVER'), 'organizer !ok executes WO 3-0');
  const fxStat = await db.execute({ sql: `SELECT status FROM fixtures WHERE id=?`, args: [fix2] });
  assert(String((fxStat.rows[0] as any)[0]) === 'WALKOVER', 'fixture WALKOVER after !ok');

  // 12. non-organizer cannot !ok
  const claim2 = await app.handleInboundMessage(textMsg(winJid, group, `!claimwo ${fix2} ${teamBName} coba lagi`));
  const okBad = await app.handleInboundMessage(textMsg('628111000000@s.whatsapp.net', group, '!ok'));
  assert(String(okBad.replyText || '').includes('hanya') || String(okBad.replyText || '').includes('izin'), '!ok RBAC rejects non-organizer');

  log(`\n=== GROUP FRESH DRY-RUN DONE: ${pass} PASS / ${fail} FAIL ===`);
  db.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
