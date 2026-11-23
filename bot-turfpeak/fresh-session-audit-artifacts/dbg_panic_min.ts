// Minimal repro of the vitest-only rust panic: transaction + FK failure inside
// vitest worker. Works fine under tsx — the difference must be an environment
// detail. Try the exact sequence the failing test uses, but in tsx.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { applyKoGameEvidence } from '../src/application/ko-evidence-pipeline.js';

const db = createClient({ url: ':memory:' });
await runMigrations(db);
const now = new Date().toISOString();
await db.execute({ sql: `INSERT INTO tournaments (id,name,status,timezone,rules_version,config_json,created_at,updated_at) VALUES ('t1','X','ACTIVE','Asia/Jakarta','1','{}',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('a1','t1','Alpha','VERIFIED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('b1','t1','Beta','VERIFIED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO fixtures (id,tournament_id,stage,group_id,round_code,team_a_id,team_b_id,left_side_team_id,scheduled_at,timezone,host_team_id,host_assignment_reason,status,created_at,updated_at) VALUES ('f1','t1','KNOCKOUT',NULL,'SEMI_FINAL','a1','b1','a1',NULL,'Asia/Jakarta',NULL,'DEFAULT_LEFT_SIDE','SCHEDULED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO series (id,fixture_id,format,target_wins,status,winner_team_id,team_a_game_wins,team_b_game_wins,created_at,updated_at) VALUES ('s1','f1','BO3',2,'PENDING',NULL,0,0,?,?)`, args: [now, now] });

// Same as dbg_tx_rollback_probe but WITHOUT catch — let it fly, then inspect.
try {
  await applyKoGameEvidence(db, { fixtureId: 'f1', teamAScore: 2, teamBScore: 0, submittedByDelegateId: null, sourceMessageId: 'not-a-real-inbound-row-id' });
  console.log('NO THROW');
} catch (e) {
  console.log('threw:', (e as Error).message.slice(0, 90));
}
// CRITICAL second use of the SAME db after the rolled-back tx (like the test does):
const g = await db.execute('SELECT COUNT(*) AS c FROM games');
console.log('after-rollback query OK:', g.rows[0]);
db.close();
console.log('closed cleanly');
