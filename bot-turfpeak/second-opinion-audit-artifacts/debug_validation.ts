/** Debug isolasi: kenapa validasi mengembalikan NEEDS_CORRECTION? */
import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../src/db/migrate.js';
import { validateMatchReport } from '../src/reports/validation.js';

async function main() {
  const db = createClient({ url: 'file::memory:?cache=shared' });
  await runMigrations(db);
  const now = new Date().toISOString();
  const tId = randomUUID();
  await db.execute({ sql: "INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at) VALUES (?, 'T', 'ACTIVE', 'Asia/Jakarta', 'v1', '{}', ?, ?)", args: [tId, now, now] });
  const aId = randomUUID(), bId = randomUUID();
  await db.execute({ sql: 'INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?,?,?, ?, ?, ?)', args: [aId, tId, 'A FC', 'VERIFIED', now, now] });
  await db.execute({ sql: 'INSERT INTO teams (id, tournament_id, team_name, registration_status, created_at, updated_at) VALUES (?,?,?, ?, ?, ?)', args: [bId, tId, 'B FC', 'VERIFIED', now, now] });
  const players = ['GkA', 'A1', 'A2', 'A3', 'A4'];
  const playersB = ['GkB', 'B1', 'B2', 'B3', 'B4'];
  for (let i = 0; i < 5; i++) {
    await db.execute({ sql: 'INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [randomUUID(), tId, aId, players[i], players[i], players[i].toLowerCase(), i === 0 ? 'GOALKEEPER' : 'OUTFIELD', i + 1, 'STARTER', 'ACTIVE', now, now] });
    await db.execute({ sql: 'INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [randomUUID(), tId, bId, playersB[i], playersB[i], playersB[i].toLowerCase(), i === 0 ? 'GOALKEEPER' : 'OUTFIELD', i + 1, 'STARTER', 'ACTIVE', now, now] });
  }
  const fixId = randomUUID();
  await db.execute({ sql: "INSERT INTO fixtures (id, tournament_id, stage, status, team_a_id, team_b_id, left_side_team_id, round_code, created_at, updated_at) VALUES (?,?,'GROUP','SCHEDULED',?,?,?, 'ROUND_1', ?, ?)", args: [fixId, tId, aId, bId, aId, now, now] });
  const gameId = randomUUID();
  await db.execute({ sql: "INSERT INTO games (id, fixture_id, game_number, status, evidence_status, created_at, updated_at) VALUES (?,?,1,'SCHEDULED','PENDING',?,?)", args: [gameId, fixId, now, now] });
  const mk = (names: string[], win: boolean) => names.map((n, i) => ({ nickname_raw: n, rating: 8.0, goals: i === 1 ? (win ? 2 : 1) : 0, assists: 0, passes: 20, defense_raw: 2, goalkeeper_saves: null }));
  const v = await validateMatchReport(db, {
    fixture_id: fixId, game_id: gameId, team_a_id: aId, team_b_id: bId,
    team_a_score: 2, team_b_score: 1,
    team_a_players: mk(players, true), team_b_players: mk(playersB, false),
  });
  console.log('isValid:', v.isValid);
  console.log('errors:', JSON.stringify(v.errors, null, 2));
  console.log('warnings:', JSON.stringify(v.warnings, null, 2));
  process.exit(0);
}
main();
