// T6 fix check: organizer NL correction authorized; non-delegate stranger still rejected.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { applyReportCorrection } from '../src/reports/corrections.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
  const tA = randomUUID(), tB = randomUUID();
  for (const [id, nm] of [[tA, 'KA'], [tB, 'KB']] as const) {
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, nm]);
  }
  const fx = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'GROUP', ?, ?, ?, 'IN_PROGRESS', datetime('now'), datetime('now'))`, [fx, TID, tA, tB, tA]);
  const gm = randomUUID();
  await db.execute(`INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at) VALUES (?, ?, 1, 'REPORT_PENDING', 'RECEIVED', datetime('now'), datetime('now'))`, [gm, fx]);
  const sess = randomUUID();
  await db.execute(`INSERT INTO report_sessions (id, fixture_id, submitting_team_id, status, last_message_at, debounce_due_at, extension_count, version, created_at, updated_at) VALUES (?, ?, ?, 'DRAFT_READY', datetime('now'), datetime('now'), 0, 1, datetime('now'), datetime('now'))`, [sess, fx, tA]);
  const inb = randomUUID();
  await db.execute(`INSERT INTO inbound_messages (id, provider_message_key, chat_id, sender_raw_address, message_timestamp, received_at, message_type, text_body, raw_metadata_json, created_at) VALUES (?, 'k1', 'c@g.us', 'x@s.whatsapp.net', datetime('now'), datetime('now'), 'TEXT', 'koreksi', '{}', datetime('now'))`, [inb]);
  const ver = randomUUID();
  await db.execute(`INSERT INTO report_versions (id, report_session_id, fixture_id, version_number, status, extraction_json, validated_data_json, provenance, created_by, created_at) VALUES (?, ?, ?, 1, 'PENDING_APPROVAL', '{}', ?, 'AI', 'sys', datetime('now'))`,
    [ver, sess, fx, JSON.stringify({ fixture_id: fx, game_id: gm, team_a_id: tA, team_b_id: tB, team_a_score: 2, team_b_score: 1, team_a_players: [], team_b_players: [] })]);

  const patch = { metric: 'score', team_side: 'TEAM_A', new_value: 3 };
  // Organizer (flag forwarded now) -> authorized, correction applied
  const rOrg = await applyReportCorrection(db, { target_report_version_id: ver, sender_id: '6289977777777@s.whatsapp.net', inbound_message_id: inb, patch, is_organizer: true });
  // Stranger (no flag, not a delegate) -> still rejected
  const rStr = await applyReportCorrection(db, { target_report_version_id: ver, sender_id: '6280000000000@s.whatsapp.net', inbound_message_id: inb, patch });

  const orgPassedAuthority = !(rOrg.error || '').includes('Unauthorized');
  console.log('organizer passed authority gate:', orgPassedAuthority, '(downstream validation error about empty lineup is expected in this minimal fixture)');
  console.log('stranger :', rStr.status, rStr.error);
  const ok = orgPassedAuthority && rStr.status === 'REJECTED' && (rStr.error || '').includes('Unauthorized');
  console.log(ok ? 'T6-FIX VERIFIED' : 'T6-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
