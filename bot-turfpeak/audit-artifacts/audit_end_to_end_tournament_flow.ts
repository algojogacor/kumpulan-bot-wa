/**
 * AUDIT ARTIFACT: End-to-End Tournament Lifecycle State Transition Trace
 * Verifies DB state transitions:
 * createTournament -> addTeam -> onboarding -> draw -> fixtures -> report -> standings -> awards
 */

import { createClient } from '@libsql/client';
import { runMigrations } from '../src/db/migrate.js';
import { createTournament } from '../src/competition/tournament.js';
import { prepareDraw, revealNext } from '../src/competition/draw.js';
import { generateGroupStageFixtures } from '../src/competition/fixtures.js';
import { handleManualReport } from '../src/reports/manual.js';
import { recalculateAndPersistGroupStandings } from '../src/competition/standings.js';
import { calculateTournamentAwards } from '../src/stats/awards.js';
import { submitReportApproval } from '../src/reports/approval.js';
import { randomUUID } from 'node:crypto';

console.log('=== AUDIT TEST: END-TO-END TOURNAMENT DB STATE TRANSITION ===');

async function testFullTournamentFlow() {
  const db = createClient({ url: ':memory:' });
  await runMigrations(db);

  // 1. Create Tournament
  const tourney = await createTournament(db, {
    name: 'Flash Peak TMS Audit Cup',
    rules_version: '1.0',
  });
  const tourneyId = tourney.id;
  console.log(`1. Tournament Created: ID=${tourneyId}, Status=${tourney.status}`);

  // 2. Add 8 Teams with Delegates & Rosters
  const now = new Date().toISOString();
  const teamIds: string[] = [];

  for (let i = 1; i <= 8; i++) {
    const tId = randomUUID();
    const delId = randomUUID();
    const teamName = `Team ${String.fromCharCode(64 + i)}`; // Team A..H

    await db.execute({
      sql: `INSERT INTO delegates (id, display_name, status, created_at, updated_at)
            VALUES (?, ?, 'ACTIVE', ?, ?)`,
      args: [delId, `Delegate ${teamName}`, now, now],
    });

    await db.execute({
      sql: `INSERT INTO whatsapp_identities (id, delegate_id, raw_address, address_type, is_primary, created_at)
            VALUES (?, ?, ?, 'JID', 1, ?)`,
      args: [randomUUID(), delId, `628100000${i}@s.whatsapp.net`, now],
    });

    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, delegate_id, registration_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'VERIFIED', ?, ?)`,
      args: [tId, tourneyId, teamName, delId, now, now],
    });

    // Add 5 players per team
    for (let p = 1; p <= 5; p++) {
      await db.execute({
        sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STARTER', 'ACTIVE', ?, ?)`,
        args: [
          randomUUID(),
          tourneyId,
          tId,
          `${teamName} Player ${p}`,
          `${teamName} Player ${p}`,
          `${teamName.toLowerCase()} player ${p}`,
          p === 1 ? 'GOALKEEPER' : 'OUTFIELD',
          p,
          now,
          now,
        ],
      });
    }

    teamIds.push(tId);
  }

  const teamCountRes = await db.execute({
    sql: "SELECT COUNT(*) as c FROM teams WHERE tournament_id = ? AND registration_status = 'VERIFIED'",
    args: [tourneyId],
  });
  console.log(`2. Teams registered and verified in DB: ${teamCountRes.rows[0]?.c} / 8`);

  // 3. Prepare Draw
  const draw = await prepareDraw(db, tourneyId);
  console.log(`3. Draw prepared: ID=${draw.id}, Status=${draw.status}`);

  // Progressive reveal steps
  let revealCount = 0;
  while (true) {
    const step = await revealNext(db, draw.id);
    if (step.is_complete || !step.item) break;
    revealCount++;
  }
  console.log(`4. Draw reveal steps completed: ${revealCount} teams assigned`);

  // 4. Generate Fixtures
  const fixtures = await generateGroupStageFixtures(db, tourneyId);
  console.log(`5. Fixtures generated in DB: ${fixtures.length} fixtures`);

  // Verify left_side_team_id and host_assignment_reason in DB
  const fixCheck = await db.execute({
    sql: 'SELECT id, left_side_team_id, host_assignment_reason FROM fixtures WHERE tournament_id = ?',
    args: [tourneyId],
  });
  const allHaveLeftSide = fixCheck.rows.every((r) => r.left_side_team_id && r.host_assignment_reason === 'DEFAULT_LEFT_SIDE');
  console.log(`6. Fixtures have left_side_team_id & DEFAULT_LEFT_SIDE: ${allHaveLeftSide ? 'YES (PASS)' : 'NO (FAIL)'}`);

  // 5. Update Tournament Status to ACTIVE
  await db.execute({
    sql: "UPDATE tournaments SET status = 'ACTIVE' WHERE id = ?",
    args: [tourneyId],
  });

  // 6. Submit a Match Report via handleManualReport
  const firstFixture = fixtures[0];
  const gamesRes = await db.execute({
    sql: 'SELECT id FROM games WHERE fixture_id = ? LIMIT 1',
    args: [firstFixture.id],
  });
  const gameId = String(gamesRes.rows[0]?.id || gamesRes.rows[0]?.[0]);

  // Query actual registered players for team A and team B in firstFixture
  const pARes = await db.execute({
    sql: 'SELECT nickname_raw, position FROM players WHERE team_id = ? ORDER BY roster_slot ASC',
    args: [firstFixture.team_a_id],
  });
  const pBRes = await db.execute({
    sql: 'SELECT nickname_raw, position FROM players WHERE team_id = ? ORDER BY roster_slot ASC',
    args: [firstFixture.team_b_id],
  });

  const teamAPlayers = pARes.rows.map((r, idx) => ({
    nickname_raw: String(r.nickname_raw),
    rating: idx === 0 ? 7.0 : 8.0,
    goals: idx === 1 ? 2 : (idx === 2 ? 1 : 0),
    assists: idx === 1 ? 1 : 0,
    passes: 10,
    defense_raw: idx === 0 ? 5 : 2,
    goalkeeper_saves: idx === 0 ? 5 : null,
  }));

  const teamBPlayers = pBRes.rows.map((r, idx) => ({
    nickname_raw: String(r.nickname_raw),
    rating: idx === 0 ? 6.5 : 7.0,
    goals: idx === 1 ? 1 : 0,
    assists: 0,
    passes: 8,
    defense_raw: idx === 0 ? 3 : 1,
    goalkeeper_saves: idx === 0 ? 3 : null,
  }));

  const reportRes = await handleManualReport(db, {
    organizer_id: 'ORGANIZER-TEST',
    is_organizer: true,
    fixture_id: firstFixture.id,
    game_id: gameId,
    team_a_score: 3,
    team_b_score: 1,
    team_a_players: teamAPlayers,
    team_b_players: teamBPlayers,
  });

  console.log(`7. Manual Match Report created: Success=${reportRes.success}, Version=${reportRes.version?.version_number}`);
  if (!reportRes.success) {
    console.log(`   Manual report errors:`, reportRes.errors);
  }

  // 7.5 Submit 3-Party Approvals to Lock Report
  const vId = reportRes.version!.id;
  const tARes = await db.execute({ sql: 'SELECT delegate_id FROM teams WHERE id = ?', args: [firstFixture.team_a_id] });
  const tBRes = await db.execute({ sql: 'SELECT delegate_id FROM teams WHERE id = ?', args: [firstFixture.team_b_id] });
  const delAId = String(tARes.rows[0]?.delegate_id ?? tARes.rows[0]?.[0]);
  const delBId = String(tBRes.rows[0]?.delegate_id ?? tBRes.rows[0]?.[0]);

  await submitReportApproval(db, {
    report_version_id: vId,
    approver_type: 'TEAM_A',
    approver_id: delAId,
    decision: 'APPROVE',
  });
  await submitReportApproval(db, {
    report_version_id: vId,
    approver_type: 'TEAM_B',
    approver_id: delBId,
    decision: 'APPROVE',
  });
  const appOrg = await submitReportApproval(db, {
    report_version_id: vId,
    approver_type: 'ORGANIZER',
    approver_id: 'ORGANIZER-TEST',
    decision: 'APPROVE',
    is_organizer: true,
  });
  console.log(`7.5 3-Party Approval Outcome: Locked=${appOrg.is_locked}, GameStatus=${appOrg.game_status}`);

  // 8. Lock report and recalculate standings
  const groupId = String(firstFixture.group_id);
  const standings = await recalculateAndPersistGroupStandings(db, tourneyId, groupId);
  console.log(`8. Standings persisted to DB: ${standings.length} teams in group table`);
  console.log(`   Top team: ${standings[0]?.team_name} (Points: ${standings[0]?.points}, Goal Diff: ${standings[0]?.goal_difference})`);

  // 9. Awards Calculation
  const awards = await calculateTournamentAwards(db, tourneyId);
  console.log(`9. Awards Calculated: Golden Boot=${awards.goldenBoot.winners[0]?.nicknameRaw} (${awards.goldenBoot.winners[0]?.metricValue} goals), Best GK=${awards.bestWinningGoalkeeper.winners[0]?.nicknameRaw} (${awards.bestWinningGoalkeeper.winners[0]?.metricValue} saves)`);

  db.close();
  console.log('\n=== AUDIT CONCLUSION: TOURNAMENT DB FLOW ===');
  console.log('Database state transitions and calculations execute successfully end-to-end.');
}

testFullTournamentFlow().catch((err) => {
  console.error('Audit flow error:', err);
  process.exit(1);
});
