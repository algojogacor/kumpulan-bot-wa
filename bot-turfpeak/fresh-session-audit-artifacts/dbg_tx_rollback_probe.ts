// Probe: reproduce the rust panic seen in vitest — applyKoGameEvidence with a
// BOGUS source_message_id should trigger the FK failure INSIDE the transaction,
// then rollback. The panic may come from libsql's rust binding when execute()
// is called on a Transaction typed as Client (it is not a Client instance —
// it lacks the internal connection wrapper).
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

try {
  const out = await applyKoGameEvidence(db, {
    fixtureId: 'f1',
    teamAScore: 2,
    teamBScore: 0,
    submittedByDelegateId: null,
    sourceMessageId: 'not-a-real-inbound-row-id',
  });
  console.log('UNEXPECTED SUCCESS:', out.status);
} catch (e) {
  console.log('THREW as expected:', (e as Error).message.slice(0, 140));
}
const g = await db.execute('SELECT COUNT(*) AS c FROM games');
const ev = await db.execute('SELECT COUNT(*) AS c FROM ko_game_evidence');
console.log('games rows:', g.rows[0], '| evidence rows:', ev.rows[0]);
db.close();
