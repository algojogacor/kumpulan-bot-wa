// Fix proof for resolveIdentity-1arg: the coordinator now calls
// resolveIdentity(sender_raw_address, chat_id) — same shape as the router.
// Uses a spy resolver wrapper; also runs a real end-to-end correction from a
// REGISTERED delegate through handleReportCorrection to confirm behavior is
// unchanged (correction still applied, correct delegate sender_id).
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { IdentityResolver } from '../src/identity/resolver.js';
import { handleReportCorrection } from '../src/application/report-correction-coordinator.js';
import { createReportDraft } from '../src/reports/versioning.js';
import type { IdentityResolver as IIdentityResolver } from '../src/identity/resolver.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

class SpyResolver implements Pick<IIdentityResolver, 'resolveIdentity'> {
  public calls: Array<{ raw: string; chatId?: string }> = [];
  constructor(private inner: IdentityResolver) {}
  async resolveIdentity(raw: string, chatId?: string) {
    this.calls.push({ raw, chatId });
    return this.inner.resolveIdentity(raw, chatId);
  }
}

// Minimal deterministic CorrectionParser stub (PROPOSED with a simple patch).
const VERSION_ID = { current: '' as string };
const mkParser = () => ({
  parse: async (input: any) => ({
    status: 'PROPOSED',
    patch: {
      target_report_version_id: input?.report_context?.report_version_id || input?.report_version_id || VERSION_ID.current,
      team_side: 'TEAM_A' as const,
      metric: 'score' as const,
      stated_old_value: 2,
      new_value: 4,
      ambiguity_flags: [],
    },
  }),
  configure: async () => {},
}) as any;

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);

  const delId = randomUUID();
  await db.execute(`INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, 'Delegasi Garuda', 'ACTIVE', datetime('now'), datetime('now'))`, [delId]);
  const teamA = randomUUID(), teamB = randomUUID();
  const delB = randomUUID();
  await db.execute(`INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, 'Delegasi Elang', 'ACTIVE', datetime('now'), datetime('now'))`, [delB]);
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES (?, ?, 'Garuda FC', ?, 'VERIFIED', datetime('now'), datetime('now'))`, [teamA, TID, delId]);
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES (?, ?, 'Elang FC', ?, 'VERIFIED', datetime('now'), datetime('now'))`, [teamB, TID, delB]);
  await db.execute(`INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, source_chat_id, created_at) VALUES (?, ?, '6281111111111@s.whatsapp.net', 'PHONE', 1, 'central@g.us', datetime('now'))`, [randomUUID(), delId]);

  const fxId = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'GROUP', 'MD1', ?, ?, ?, 'COMPLETED', datetime('now'), datetime('now'))`, [fxId, TID, teamA, teamB, teamA]);

  // Report session + version with validated data
  const sessionId = randomUUID();
  await db.execute(`INSERT INTO report_sessions (id, fixture_id, submitting_team_id, status, last_message_at, debounce_due_at, created_at, updated_at) VALUES (?, ?, ?, 'DRAFT_READY', datetime('now'), datetime('now'), datetime('now'), datetime('now'))`, [sessionId, fxId, teamA]);
  const gameId = randomUUID();
  await db.execute(`INSERT INTO games (id, fixture_id, series_id, game_number, status, team_a_score, team_b_score, winner_team_id, is_draw, is_walkover, walkover_type, evidence_status, created_at, updated_at) VALUES (?, ?, NULL, 1, 'COMPLETED', 2, 1, ?, 0, 0, 'NONE', 'VERIFIED', datetime('now'), datetime('now'))`, [gameId, fxId, teamA]);
  const mkPlayers = async (teamId: string, prefix: string) => {
    const players = [];
    for (let i = 1; i <= 5; i++) {
      const pid = randomUUID();
      await db.execute(`INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', datetime('now'), datetime('now'))`,
        [pid, TID, teamId, `${prefix}-p${i}`, `${prefix}-p${i}`, `${prefix}-p${i}`, i === 1 ? 'GOALKEEPER' : 'OUTFIELD', i, i <= 5 ? 'STARTER' : 'STARTER']);
      players.push({
        player_id: pid,
        nickname_raw: `${prefix}-p${i}`,
        rating: null,
        goals: i === 1 ? (prefix === 'a' ? 4 : 1) : 0,
        assists: 0,
        passes: 0,
        defense_raw: 0,
        goalkeeper_saves: i === 1 ? 3 : null,
      });
    }
    return players;
  };
  const validated = {
    fixture_id: fxId, game_id: gameId, team_a_id: teamA, team_b_id: teamB,
    team_a_score: 2, team_b_score: 1,
    team_a_players: await mkPlayers(teamA, 'a'), team_b_players: await mkPlayers(teamB, 'b'),
  };
  const version = await createReportDraft(db, {
    report_session_id: sessionId,
    fixture_id: fxId,
    status: 'PENDING_APPROVAL',
    validated_data_json: JSON.stringify(validated),
  });

  const spy = new SpyResolver(new IdentityResolver(db));
  const msg: NormalizedMessage = {
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: 'central@g.us',
    sender_raw_address: '6281111111111@s.whatsapp.net',
    sender_normalized_address: '6281111111111@s.whatsapp.net',
    message_type: 'TEXT', text_body: 'skor kita jadi 4 ya', caption: null,
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage;

  VERSION_ID.current = version.id;
  const { result, replyText } = await handleReportCorrection(
    { db, correctionParser: mkParser(), identityResolver: spy as unknown as IIdentityResolver },
    version.id, msg, false
  );

  console.log('resolveIdentity calls from coordinator:', JSON.stringify(spy.calls));
  const callOk = spy.calls.length === 1 && spy.calls[0]!.raw === '6281111111111@s.whatsapp.net' && spy.calls[0]!.chatId === 'central@g.us';
  console.log('coordinator passes chat context (2-arg, same as router):', callOk);
  console.log('correction result:', result.success, '| error:', JSON.stringify((result as any).error || '').slice(0, 120), '| newVersion:', !!(result as any).newVersion);

  // sender_id recorded = delegate UUID (not the phone fallback)
  const corrRow = await db.execute(`SELECT submitted_by_delegate_id, status FROM corrections ORDER BY created_at DESC LIMIT 1`, []);
  const submittedBy = corrRow.rows.length ? String((corrRow.rows[0] as any).submitted_by_delegate_id ?? (corrRow.rows[0] as any)[0]) : null;
  console.log('recorded sender_id == delegate UUID:', submittedBy === delId, `(${submittedBy?.slice(0, 8) ?? 'none'} vs del ${delId.slice(0, 8)})`);

  // New version exists with patched score
  const versions = await db.execute(`SELECT version_number, validated_data_json FROM report_versions WHERE fixture_id = ? ORDER BY version_number`, [fxId]);
  const last = versions.rows[versions.rows.length - 1] as any;
  const patched = last ? JSON.parse(String(last.validated_data_json ?? last[1])).team_a_score : null;
  console.log('new version created:', versions.rows.length > 1, '| patched team_a_score:', patched);

  const ok = callOk && result.success && submittedBy === delId && patched === 4;
  console.log(ok ? 'RESOLVEIDENTITY-FIX VERIFIED' : 'RESOLVEIDENTITY-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
