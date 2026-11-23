// T10-close: verify auto-bind behavior matches Arya's description EXACTLY.
// Expected (by design): first sender of a VALID roster-format message naming a
// team without a delegate gets auto-bound as that team's delegate, no
// organizer confirmation, no tournament-status gate. Also verify: team WITH a
// delegate cannot be seized (auth check fires).
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { registerTournamentCommands } from '../src/application/tournament-commands.js';
import { CommandRouter } from '../src/whatsapp/router.js';
import { IdentityResolver } from '../src/identity/resolver.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const TID = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [TID]);

  const resolver = new IdentityResolver(db);
  const router = new CommandRouter({ centralGroupJid: 'g@g.us', organizerPhone: '6281234567890', identityResolver: resolver });
  registerTournamentCommands(router, {
    db,
    identityResolver: resolver,
    manualReportSession: undefined as any,
    onboardingService: undefined as any,
    matchdayService: undefined as any,
    woClaimSession: undefined,
  } as any);

  const teamId = randomUUID();
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, 'Garuda FC', 'PENDING', datetime('now'), datetime('now'))`, [teamId, TID]);

  const mk = (from: string, text: string): NormalizedMessage => ({
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: 'g@g.us', sender_raw_address: from, sender_normalized_address: from,
    message_type: 'TEXT', text_body: text, caption: null,
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage);

  // Case 1: stranger sends valid roster format for a delegate-less team, ACTIVE tournament.
  const r1 = await router.handleMessage(mk('6289999999999@s.whatsapp.net', '!roster Garuda FC GK: Ikyy | Inti: A, B, C, D | Cadangan: E, F'));
  const bind1 = await db.execute(`SELECT delegate_id, registration_status FROM teams WHERE id = ?`, [teamId]);
  const bound1 = (bind1.rows[0] as any).delegate_id !== null;
  console.log('case1 (ACTIVE, valid format, delegate-less team):');
  console.log('  response ok:', r1?.success, '| delegate bound:', bound1, '| status:', (bind1.rows[0] as any).registration_status);

  // Case 2: a SECOND stranger tries the same for the same team — must be REJECTED (auth check).
  const r2 = await router.handleMessage(mk('6288888888888@s.whatsapp.net', '!roster Garuda FC GK: Ikyy | Inti: A, B, C, D | Cadangan: E, F'));
  const bind2 = await db.execute(`SELECT delegate_id FROM teams WHERE id = ?`, [teamId]);
  const stillFirst = String((bind2.rows[0] as any).delegate_id) === String((bind1.rows[0] as any).delegate_id);
  console.log('case2 (second stranger, same team):');
  console.log('  response ok:', r2?.success, '| response:', (r2?.responseText || '').slice(0, 60).replace(/\n/g, ' '), '| delegate unchanged:', stillFirst);

  // Case 3: invalid roster format from another stranger for a NEW delegate-less team —
  // auto-bind should NOT happen (parser fails before team bind; here we test missing GK etc.)
  const team2 = randomUUID();
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?, ?, 'Elang FC', 'PENDING', datetime('now'), datetime('now'))`, [team2, TID]);
  const r3 = await router.handleMessage(mk('6287777777777@s.whatsapp.net', '!roster Elang FC halooo saya mau daftar'));
  const bind3 = await db.execute(`SELECT delegate_id FROM teams WHERE id = ?`, [team2]);
  const noBindOnGarbage = (bind3.rows[0] as any).delegate_id === null;
  console.log('case3 (invalid format, delegate-less team):');
  console.log('  response ok:', r3?.success, '| no auto-bind:', noBindOnGarbage);

  const matchesDescription = bound1 && stillFirst && noBindOnGarbage;
  console.log(matchesDescription ? 'T10-BEHAVIOR MATCHES DESCRIPTION (by design confirmed)' : 'T10-BEHAVIOR DIFFERS FROM DESCRIPTION — REPORT');
  db.close();
  process.exit(matchesDescription ? 0 : 1);
}
main();
