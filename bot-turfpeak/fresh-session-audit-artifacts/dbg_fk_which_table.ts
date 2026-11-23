// Isolate WHICH insert violates the FK: journal insert vs earlier steps.
// Strategy: run applyKoGameEvidence steps manually with sourceMessageId = null (valid) vs key (invalid).
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { applyKoGameEvidence } from '../src/application/ko-evidence-pipeline.js';
import { recordSeriesGameResult, getSeriesByFixture } from '../src/competition/series.js';

const db = createClient({ url: 'file:fresh-session-audit-artifacts/fk_which.sqlite' });
await runMigrations(db);
const now = new Date().toISOString();
await db.execute({ sql: `INSERT INTO tournaments (id,name,status,timezone,rules_version,config_json,created_at,updated_at) VALUES ('t1','X','ACTIVE','Asia/Jakarta','1','{}',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('a1','t1','Alpha','VERIFIED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO teams (id,tournament_id,team_name,registration_status,created_at,updated_at) VALUES ('b1','t1','Beta','VERIFIED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO fixtures (id,tournament_id,stage,group_id,round_code,team_a_id,team_b_id,left_side_team_id,scheduled_at,timezone,host_team_id,host_assignment_reason,status,created_at,updated_at) VALUES ('f1','t1','KNOCKOUT',NULL,'SEMI_FINAL','a1','b1','a1',NULL,'Asia/Jakarta',NULL,'DEFAULT_LEFT_SIDE','SCHEDULED',?,?)`, args: [now, now] });
await db.execute({ sql: `INSERT INTO series (id,fixture_id,format,target_wins,status,winner_team_id,team_a_game_wins,team_b_game_wins,created_at,updated_at) VALUES ('s1','f1','BO3',2,'PENDING',NULL,0,0,?,?)`, args: [now, now] });

// A) sourceMessageId = null
try {
  const out = await applyKoGameEvidence(db, { fixtureId: 'f1', teamAScore: 2, teamBScore: 0, submittedByDelegateId: null, sourceMessageId: null });
  console.log('A) sourceMessageId=null ->', out.status);
} catch (e: any) { console.log('A) FAILED:', e.message); }

// B) sourceMessageId = provider message key (nonexistent inbound row)
try {
  const out = await applyKoGameEvidence(db, { fixtureId: 'f1', teamAScore: 1, teamBScore: 2, submittedByDelegateId: null, sourceMessageId: 'WA-MSG-KEY-XYZ' });
  console.log('B) sourceMessageId=key ->', out.status);
} catch (e: any) { console.log('B) FAILED:', e.message); }

const g = await db.execute('SELECT game_number, team_a_score, team_b_score FROM games WHERE fixture_id=\'f1\'');
for (const r of g.rows as any[]) console.log('game row:', r.game_number, r.team_a_score, r.team_b_score);
const ev = await db.execute('SELECT game_number, status, source_message_id FROM ko_game_evidence');
for (const r of ev.rows as any[]) console.log('evidence row:', r.game_number, r.status, r.source_message_id);
db.close();
