/**
 * AUDIT ARTIFACT: WhatsApp Command Router Comprehensive Call Chain Verification
 * Verifies that EVERY command registered in the router has a valid handler
 * that executes and returns a responseText when invoked.
 */

import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { CommandRouter } from '../src/whatsapp/router.js';
import { registerTournamentCommands } from '../src/application/tournament-commands.js';
import { IdentityResolver } from '../src/identity/resolver.js';
import { OnboardingService } from '../src/identity/onboarding.js';
import { ManualReportSessionManager } from '../src/application/manual-report-session.js';
import { WoClaimSessionManager } from '../src/application/wo-claim-session.js';
import { MatchdayService } from '../src/application/matchday-service.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';
import { createTournament } from '../src/competition/tournament.js';
import { randomUUID } from 'node:crypto';

console.log('=== AUDIT TEST: WHATSAPP COMMAND ROUTER WIRING TRACE ===');

async function testAllCommands() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);

  const identityResolver = new IdentityResolver(db);
  const onboardingService = new OnboardingService(identityResolver, db);
  const manualReportSession = new ManualReportSessionManager();
  const woClaimSession = new WoClaimSessionManager();
  const matchdayService = new MatchdayService({ db, centralGroupJid: 'central-group@g.us' });

  const router = new CommandRouter({
    centralGroupJid: 'central-group@g.us',
    organizerPhone: '6281234567890',
    organizerJid: '6281234567890@s.whatsapp.net',
    identityResolver,
  });

  registerTournamentCommands(router, {
    db,
    identityResolver,
    onboardingService,
    manualReportSession,
    woClaimSession,
    matchdayService,
    getStandingsTable: async () => 'Table Standings',
    submitApproval: async () => ({} as any),
    findVersionByMessageKey: async () => null,
  });

  // Setup active tournament & teams for context
  const tourney = await createTournament(db, { name: 'Audit Test Tournament' });
  await db.execute({
    sql: "UPDATE tournaments SET status = 'REGISTRATION' WHERE id = ?",
    args: [tourney.id],
  });

  const registeredCommands = [
    // Builtin
    { cmd: 'ping', role: 'ANY', args: '' },
    { cmd: 'help', role: 'ANY', args: '' },
    { cmd: 'id', role: 'ANY', args: '' },
    { cmd: 'myid', role: 'ANY', args: '' },
    { cmd: 'setgroup', role: 'ORGANIZER', args: '' },
    // Tournament Commands
    { cmd: 'createtournament', role: 'ORGANIZER', args: 'Piala Presiden TMS' },
    { cmd: 'addteam', role: 'ORGANIZER', args: 'Garuda Muda' },
    { cmd: 'teams', role: 'ANY', args: '' },
    { cmd: 'tim', role: 'ANY', args: '' },
    { cmd: 'daftartim', role: 'ANY', args: '' },
    { cmd: 'peserta', role: 'ANY', args: '' },
    { cmd: 'status', role: 'ANY', args: '' },
    { cmd: 'info', role: 'ANY', args: '' },
    { cmd: 'turnamen', role: 'ANY', args: '' },
    { cmd: 'rule', role: 'ANY', args: '' },
    { cmd: 'rules', role: 'ANY', args: '' },
    { cmd: 'regulasi', role: 'ANY', args: '' },
    { cmd: 'matchday', role: 'ANY', args: '' },
    { cmd: 'ronde', role: 'ANY', args: '' },
    { cmd: 'schedule', role: 'ANY', args: '' },
    { cmd: 'jadwal', role: 'ANY', args: '' },
    { cmd: 'standings', role: 'ANY', args: '' },
    { cmd: 'awards', role: 'ANY', args: '' },
    { cmd: 'roster', role: 'ANY', args: 'Garuda Muda' },
    { cmd: 'daftarroster', role: 'ANY', args: 'Garuda Muda' },
    { cmd: 'daftarpemain', role: 'ANY', args: 'Garuda Muda' },
    { cmd: 'manualreport', role: 'ORGANIZER', args: 'help' },
    { cmd: 'claimwo', role: 'ORGANIZER', args: 'help' },
    { cmd: 'klaimwo', role: 'ORGANIZER', args: 'help' },
    { cmd: 'wo', role: 'ORGANIZER', args: 'help' },
    { cmd: 'confirm', role: 'ORGANIZER', args: '' },
    { cmd: 'ok', role: 'ORGANIZER', args: '' },
    { cmd: 'batal', role: 'ORGANIZER', args: '' },
    { cmd: 'reject', role: 'ORGANIZER', args: '' },
    { cmd: 'tolak', role: 'ORGANIZER', args: '' },
    { cmd: 'approve', role: 'DELEGATE', args: '' },
    { cmd: 'onboarding', role: 'ORGANIZER', args: '' },
    { cmd: 'draw', role: 'ORGANIZER', args: '' },
  ];

  console.log(`Auditing ${registeredCommands.length} commands registered in router...\n`);

  let allPassed = true;
  for (const item of registeredCommands) {
    const isOrg = item.role === 'ORGANIZER';
    const sender = isOrg ? '6281234567890@s.whatsapp.net' : '6289999999999@s.whatsapp.net';

    const msg: NormalizedMessage = {
      id: randomUUID(),
      provider_message_key: `key-${item.cmd}`,
      chat_id: 'central-group@g.us',
      sender_raw_address: sender,
      sender_normalized_address: sender,
      message_timestamp: new Date().toISOString(),
      received_at: new Date().toISOString(),
      message_type: 'TEXT',
      text_body: `!${item.cmd}${item.args ? ' ' + item.args : ''}`,
    };

    const hasCmd = router.hasCommand(item.cmd);
    if (!hasCmd) {
      console.error(`❌ NOT REGISTERED: !${item.cmd}`);
      allPassed = false;
      continue;
    }

    const res = await router.handleMessage(msg);
    const hasResponse = Boolean(res && (res.responseText || res.error));
    if (!hasResponse) {
      console.error(`❌ NO RESPONSE: !${item.cmd}`);
      allPassed = false;
    } else {
      console.log(`✅ !${item.cmd.padEnd(16)} -> Responded (${res?.success ? 'SUCCESS' : 'HANDLED_ERROR: ' + res?.error})`);
    }
  }

  // Test Non-Organizer attempting Organizer command
  console.log('\n--- Role RBAC Security Test ---');
  const unauthorizedMsg: NormalizedMessage = {
    id: randomUUID(),
    provider_message_key: 'key-unauth',
    chat_id: 'central-group@g.us',
    sender_raw_address: '6289999999999@s.whatsapp.net',
    sender_normalized_address: '6289999999999@s.whatsapp.net',
    message_timestamp: new Date().toISOString(),
    received_at: new Date().toISOString(),
    message_type: 'TEXT',
    text_body: '!draw',
  };
  const unauthRes = await router.handleMessage(unauthorizedMsg);
  console.log(`Non-Organizer running !draw: ${unauthRes?.error === 'FORBIDDEN_ORGANIZER_ONLY' ? 'BLOCKED (PASS)' : 'FAILED'}`);

  db.close();
  console.log(`\n=== AUDIT CONCLUSION: COMMAND ROUTER WIRING ===`);
  console.log(allPassed ? 'ALL COMMANDS REGISTERED AND EXECUTABLE.' : 'SOME COMMANDS FAILED WIRING.');
}

testAllCommands().catch((err) => {
  console.error('Audit command router error:', err);
  process.exit(1);
});
