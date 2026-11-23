// T3 fix check: phone-only organizer config now authorizes the JID-form approver id.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { CommandRouter } from '../src/whatsapp/router.js';
import { IdentityResolver } from '../src/identity/resolver.js';
import type { NormalizedMessage } from '../src/whatsapp/types.js';
import { randomUUID } from 'node:crypto';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const resolver = new IdentityResolver(db);
  const router = new CommandRouter({
    centralGroupJid: 'g@g.us',
    organizerPhone: '6281234567890', // ONLY phone configured (T3 scenario)
    identityResolver: resolver,
  });
  const msg = {
    id: randomUUID(), provider_message_key: randomUUID(),
    chat_id: 'g@g.us',
    sender_raw_address: '6281234567890@s.whatsapp.net',
    sender_normalized_address: '6281234567890@s.whatsapp.net',
    message_type: 'TEXT', text_body: '!ping',
    message_timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
  } as unknown as NormalizedMessage;

  const isOrg = router.isSenderOrganizer(msg);
  const identities = router.getOrganizerIdentities();
  const approverId = '6281234567890@s.whatsapp.net'; // what !approve passes
  const allowed = new Set(['ORGANIZER', ...identities]);

  // JID-config scenario (regression: must still work)
  const router2 = new CommandRouter({ centralGroupJid: 'g@g.us', organizerJid: '6285550001111@s.whatsapp.net', identityResolver: resolver });
  const ids2 = router2.getOrganizerIdentities();
  const ok2 = ids2.includes('6285550001111@s.whatsapp.net') && ids2.includes('6285550001111');

  const ok = isOrg && allowed.has(approverId) && ok2;
  console.log('phone-only: isOrg=' + isOrg, 'identities=[' + identities.join(', ') + ']', 'approverAllowed=' + allowed.has(approverId));
  console.log('jid-config: identities=[' + ids2.join(', ') + ']');
  console.log(ok ? 'T3-FIX VERIFIED' : 'T3-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
