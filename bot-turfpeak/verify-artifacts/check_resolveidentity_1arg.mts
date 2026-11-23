// Verification dry-run for resolveIdentity-1arg (reported new-bug #2):
// Does the coordinator's 1-arg resolveIdentity call actually fail to
// recognize a legitimate delegate where the router's 2-arg call succeeds?
//
// Part A — signature equivalence: call resolveIdentity with 1 arg and 2 args
// for the same addresses across several scenarios (primary phone identity,
// LID identity, per-chat alias rows) and compare the results. Expectation from
// code reading: identical (the 2nd param is unused `_sourceChatId`).
//
// Part B — REAL impact: a registered delegate sends a natural-language
// correction; the coordinator falls back to sender_normalized_address when
// resolution fails for any reason, and verifyCorrectionAuthority then rejects
// them. Demonstrates the failure mode that actually matters: any resolution
// miss silently degrades sender_id to a non-delegate string.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { IdentityResolver } from '../src/identity/resolver.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const resolver = new IdentityResolver(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);

  // Delegate with TWO identities: phone (primary, source central group) and
  // LID alias (source another chat) — the "alias per-chat" shape.
  const delId = randomUUID();
  await db.execute(`INSERT INTO delegates (id, display_name, status, created_at, updated_at) VALUES (?, 'Delegasi Garuda', 'ACTIVE', datetime('now'), datetime('now'))`, [delId]);
  const teamId = randomUUID();
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES (?, ?, 'Garuda FC', ?, 'VERIFIED', datetime('now'), datetime('now'))`, [teamId, TID, delId]);
  await db.execute(`INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, source_chat_id, created_at) VALUES (?, ?, '6281111111111@s.whatsapp.net', 'PHONE', 1, 'central@g.us', datetime('now'))`, [randomUUID(), delId]);
  await db.execute(`INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, source_chat_id, created_at) VALUES (?, ?, '1234567890@lid', 'LID', 0, 'other-chat@g.us', datetime('now'))`, [randomUUID(), delId]);

  const addr = '1234567890@lid';
  const r1 = await resolver.resolveIdentity(addr);
  const r2 = await resolver.resolveIdentity(addr, 'central@g.us');
  console.log('Part A — LID alias:');
  console.log('  1-arg:', r1.status, '| delegate:', r1.delegate?.id === delId ? 'OK' : 'MISS', '| team:', r1.team?.team_name ?? '-');
  console.log('  2-arg:', r2.status, '| delegate:', r2.delegate?.id === delId ? 'OK' : 'MISS', '| team:', r2.team?.team_name ?? '-');
  const sameByAddress = JSON.stringify({ s: r1.status, d: r1.delegate?.id, t: r1.team?.id }) === JSON.stringify({ s: r2.status, d: r2.delegate?.id, t: r2.team?.id });

  const p1 = await resolver.resolveIdentity('6281111111111@s.whatsapp.net');
  const p2 = await resolver.resolveIdentity('6281111111111@s.whatsapp.net', 'central@g.us');
  const sameByPhone = p1.status === p2.status && p1.delegate?.id === p2.delegate?.id && p1.team?.id === p2.team?.id;
  console.log('Part A — primary phone: 1-arg', p1.status, '| 2-arg', p2.status, '| identical:', sameByPhone);

  const u1 = await resolver.resolveIdentity('6289999999999@s.whatsapp.net');
  const u2 = await resolver.resolveIdentity('6289999999999@s.whatsapp.net', 'central@g.us');
  const sameUnknown = u1.status === u2.status && u2.status === 'UNREGISTERED';
  console.log('Part A — unknown sender: 1-arg', u1.status, '| 2-arg', u2.status, '| identical:', sameUnknown);

  console.log(`Part A verdict: 1-arg vs 2-arg ${sameByAddress && sameByPhone && sameUnknown ? 'EQUIVALENT (2nd arg unused — suspicion of per-chat alias narrowing NOT confirmed)' : 'DIFFERENT (!)'}`);

  // Part B — the real degradation: unregistered sender (identity row missing)
  // falls back to sender_normalized_address, which can never match a
  // delegate_id in verifyCorrectionAuthority.
  const unreg = await resolver.resolveIdentity('6289999999999@s.whatsapp.net');
  const senderIdFallback = unreg?.delegate?.id || '6289999999999@s.whatsapp.net';
  console.log('Part B — resolution miss => sender_id used downstream:', JSON.stringify(senderIdFallback));
  console.log('  (verifyCorrectionAuthority compares sender_id against delegate_id UUIDs —', /^[0-9a-f-]{36}$/i.test(senderIdFallback) ? 'UUID: could match' : 'NOT a UUID: guaranteed UNAUTHORIZED for delegate role)');

  db.close();
}
main();
