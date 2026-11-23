// T12 fix check: loose ids rejected; explicit flag / ORGANIZER constant still pass.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { handleManualReport } from '../src/reports/manual.js';

async function main() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);
  const tries: Array<[string, boolean | undefined, string]> = [
    ['org_legit', undefined, 'loose org_ prefix'],
    ['i-am-the-organizer-trust-me', undefined, 'includes organizer'],
    ['ORGANIZER', undefined, 'system constant'],
    ['whatever-id', true, 'explicit flag'],
  ];
  const results: boolean[] = [];
  for (const [id, flag, label] of tries) {
    let unauthorized = false;
    try {
      await handleManualReport(db, { organizer_id: id, is_organizer: flag, fixture_id: 'nope', team_a_score: 1, team_b_score: 0, team_a_players: [], team_b_players: [] });
    } catch (e: any) {
      unauthorized = e.message.includes('Unauthorized');
    }
    const shouldBlock = label.startsWith('loose') || label.includes('includes organizer');
    const pass = shouldBlock ? unauthorized : !unauthorized;
    results.push(pass);
    console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: ${unauthorized ? 'blocked (Unauthorized)' : 'passed gate'}`);
  }
  const ok = results.every(Boolean);
  console.log(ok ? 'T12-FIX VERIFIED' : 'T12-FIX FAILED');
  db.close();
  process.exit(ok ? 0 : 1);
}
main();
