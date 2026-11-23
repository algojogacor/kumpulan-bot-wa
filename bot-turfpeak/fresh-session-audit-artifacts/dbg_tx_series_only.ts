// Isolate WHICH statement inside applyKoGameEvidence's transaction path panics
// under vitest. Strategy: replicate the pipeline's transaction usage EXACTLY:
// recordSeriesGameResult on a Transaction object cast to Client, then journal.
// Under tsx this works; if this file panics under vitest, the transaction-cast
// is the trigger. We import the real functions.
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { recordSeriesGameResult } from '../src/competition/series.js';

const db = createClient({ url: ':memory:' });
await runMigrations(db);
const now = new Date().toISOString();
await db.execute({ sql: `INSERT INTO tournaments (id,name,status,timezone,rules_version,config_json,created_at,updated_at) VALUES ('t1','X','ACTIVE','Asia/Jakarta','1','{}',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('a1','t1','Alpha','VERIFIED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('b1','t1','Beta','VERIFIED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO fixtures (id,tournament_id,stage,group_id,round_code,team_a_id,team_b_id,left_side_team_id,scheduled_at,timezone,host_team_id,host_assignment_reason,status,created_at,updated_at) VALUES ('f1','t1','KNOCKOUT',NULL,'SEMI_FINAL','a1','b1','a1',NULL,'Asia/Jakarta',NULL,'DEFAULT_LEFT_SIDE','SCHEDULED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO series (id,fixture_id,format,target_wins,status,winner_team_id,team_a_game_wins,team_b_game_wins,created_at,updated_at) VALUES ('s1','f1','BO3',2,'PENDING',NULL,0,0,?,?)`, args: [now, now] });

const tx = await db.transaction('write');
try {
  const out = await recordSeriesGameResult(tx as unknown as import('@libsql/client').Client, {
    series_id: 's1',
    game_number: 1,
    team_a_score: 2,
    team_b_score: 0,
    evidence_status: 'VERIFIED',
  });
  console.log('recordSeriesGameResult OK, complete:', out.is_series_complete);
  await tx.commit();
  console.log('commit OK');
} catch (e) {
  console.log('failed:', (e as Error).message.slice(0, 120));
  if (!tx.closed) { try { await tx.rollback(); } catch { /* ignore */ } }
  console.log('rollback OK');
}
const g = await db.execute('SELECT COUNT(*) AS c FROM games');
console.log('games:', g.rows[0]);
db.close();
console.log('DONE');
