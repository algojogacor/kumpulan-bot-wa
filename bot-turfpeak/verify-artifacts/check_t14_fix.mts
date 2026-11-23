// T14 fix check: delegate with teams in TWO tournaments resolves to the ACTIVE one.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';
import { IdentityResolver } from '../src/identity/resolver.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const resolver = new IdentityResolver(db);

  const tOld = randomUUID(), tNew = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'Old', 'COMPLETED', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [tOld]);
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'New', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [tNew]);

  // One delegate with a team in the OLD tournament (created first) and one in the NEW.
  const { delegate } = await resolver.createDelegateWithIdentity('Dual Delegate', '6287777777777@s.whatsapp.net', 'PHONE', {});
  const teamOld = randomUUID(), teamNew = randomUUID();
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES (?, ?, 'Old Team', ?, 'VERIFIED', datetime('now'), datetime('now'))`, [teamOld, tOld, delegate.id]);
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES (?, ?, 'New Team', ?, 'VERIFIED', datetime('now'), datetime('now'))`, [teamNew, tNew, delegate.id]);

  const res = await resolver.resolveIdentity('6287777777777@s.whatsapp.net');
  const resolvedNew = res.status === 'VERIFIED' && res.team?.id === teamNew && res.team?.team_name === 'New Team';

  // Regression: delegate with a single (old) team still resolves to it.
  const { delegate: d2 } = await resolver.createDelegateWithIdentity('Old Only', '6286666666666@s.whatsapp.net', 'PHONE', {});
  const tOld2 = randomUUID();
  await db.execute(`INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'Old2', 'COMPLETED', 'Asia/Jakarta', 'v1', '{}', datetime('now'), datetime('now'))`, [tOld2]);
  await db.execute(`INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at) VALUES (?, ?, 'Only Team', ?, 'VERIFIED', datetime('now'), datetime('now'))`, [randomUUID(), tOld2, d2.id]);
  const res2 = await resolver.resolveIdentity('6286666666666@s.whatsapp.net');
  const singleStillWorks = res2.status === 'VERIFIED' && res2.team?.team_name === 'Only Team';

  console.log('dual delegate resolves to:', res.team?.team_name);
  console.log('single delegate resolves to:', res2.team?.team_name);
  const ok = resolvedNew && singleStillWorks;
  console.log(ok ? 'T14-FIX VERIFIED' : 'T14-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
