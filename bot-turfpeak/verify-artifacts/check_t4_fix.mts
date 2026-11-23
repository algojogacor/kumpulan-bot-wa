// T4 fix check: plain photo during knockout phase must NOT resolve to a KO fixture.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { resolveFixtureForMessage } from '../src/application/fixture-resolver.js';
import { IdentityResolver } from '../src/identity/resolver.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);
  const tA = randomUUID(), tB = randomUUID();
  for (const [id, nm] of [[tA, 'KA'], [tB, 'KB']] as const) {
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, nm]);
  }
  // Only a KNOCKOUT fixture exists (group stage fully done).
  const fx = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'KNOCKOUT', 'SEMI_FINAL', ?, ?, ?, 'IN_PROGRESS', datetime('now'), datetime('now'))`, [fx, TID, tA, tB, tA]);

  const resolver = new IdentityResolver(db);
  const msg = {
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: 'g@g.us', sender_raw_address: '6281@s.whatsapp.net', sender_normalized_address: '6281@s.whatsapp.net',
    message_type: 'IMAGE', text_body: null, caption: null,
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage;

  const r = await resolveFixtureForMessage(db, resolver, msg);
  const koLeak = r?.id === fx;

  // Regression: a GROUP fixture must still resolve.
  const gA = randomUUID(), gB = randomUUID();
  for (const [id, nm] of [[gA, 'GA'], [gB, 'GB']] as const) {
    await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, ?, 'VERIFIED', datetime('now'), datetime('now'))`, [id, TID, nm]);
  }
  const drawId = randomUUID();
  await db.execute(`INSERT INTO group_draws (id, tournament_id, status, group_config_json, eligible_team_snapshot_json, algorithm, algorithm_version, created_at) VALUES (?, ?, 'COMPLETED', '{}', '[]', 'fy', '1', datetime('now'))`, [drawId, TID]);
  const grp = randomUUID();
  await db.execute(`INSERT INTO groups (id, draw_id, group_code, display_order) VALUES (?, ?, 'A', 1)`, [grp, drawId]);
  const gfx = randomUUID();
  await db.execute(`INSERT INTO fixtures (id, tournament_id, stage, group_id, round_code, team_a_id, team_b_id, left_side_team_id, status, created_at, updated_at) VALUES (?, ?, 'GROUP', ?, 'MD1', ?, ?, ?, 'SCHEDULED', datetime('now'), datetime('now'))`, [gfx, TID, grp, gA, gB, gA]);
  const msg2 = { ...msg, caption: 'GA vs GB hasilnya', message_type: 'IMAGE' } as unknown as NormalizedMessage;
  const r2 = await resolveFixtureForMessage(db, resolver, msg2);

  const ok = !koLeak && r2?.id === gfx;
  console.log('plain-photo-during-KO resolves:', r ? r.id.slice(0, 8) + '…' : 'null (OK)');
  console.log('group-caption resolves to group fixture:', r2?.id === gfx);
  console.log(ok ? 'T4-FIX VERIFIED' : 'T4-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
