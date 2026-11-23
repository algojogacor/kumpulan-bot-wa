import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations } from '../../src/db/migrate.js';
import {
  aggregatePlayerStats,
  aggregateTeamStats,
  getPlayerTournamentStats,
} from '../../src/stats/aggregator.js';
import {
  calculateTournamentAwards,
} from '../../src/stats/awards.js';
import { randomUUID } from 'node:crypto';

describe('Fase 6: Statistics Aggregator & Awards Calculator', () => {
  let db: Client;
  const tournamentId = 'tourn-stats-01';
  const teamAId = 'team-stats-a';
  const teamBId = 'team-stats-b';
  const teamCId = 'team-stats-c';

  const p1OutfieldA = 'player-out-a1';
  const p2OutfieldA = 'player-out-a2';
  const p3GkA = 'player-gk-a';

  const p4OutfieldB = 'player-out-b1';
  const p5GkB = 'player-gk-b';

  const p6OutfieldC = 'player-out-c1';

  beforeEach(async () => {
    db = createClient({ url: ':memory:' });
    await runMigrations(db);

    const now = new Date().toISOString();

    // 1. Create tournament
    await db.execute({
      sql: `INSERT INTO tournaments (id, name, status, timezone, rules_version, config_json, created_at, updated_at)
            VALUES (?, 'Flash Peak Championship', 'ACTIVE', 'Asia/Jakarta', '1.0', '{}', ?, ?)`,
      args: [tournamentId, now, now],
    });

    // 2. Create teams
    await db.execute({
      sql: `INSERT INTO teams (id, tournament_id, team_name, team_code, registration_status, created_at, updated_at)
            VALUES (?, ?, 'Astra Stars', 'AST', 'VERIFIED', ?, ?),
                   (?, ?, 'Blaze Titans', 'BLZ', 'VERIFIED', ?, ?),
                   (?, ?, 'Cosmo Rangers', 'CSM', 'VERIFIED', ?, ?)`,
      args: [
        teamAId, tournamentId, now, now,
        teamBId, tournamentId, now, now,
        teamCId, tournamentId, now, now,
      ],
    });

    // 3. Create players (Outfield vs Goalkeeper)
    await db.execute({
      sql: `INSERT INTO players (id, tournament_id, team_id, nickname_raw, nickname_nfc, nickname_search_key, position, roster_slot, roster_type, status, created_at, updated_at)
            VALUES (?, ?, ?, 'StrikerAce', 'StrikerAce', 'strikerace', 'OUTFIELD', 1, 'STARTER', 'ACTIVE', ?, ?),
                   (?, ?, ?, 'MidfieldMaestro', 'MidfieldMaestro', 'midfieldmaestro', 'OUTFIELD', 2, 'STARTER', 'ACTIVE', ?, ?),
                   (?, ?, ?, 'WallKeeperA', 'WallKeeperA', 'wallkeepera', 'GOALKEEPER', 3, 'STARTER', 'ACTIVE', ?, ?),
                   (?, ?, ?, 'RivalStriker', 'RivalStriker', 'rivalstriker', 'OUTFIELD', 1, 'STARTER', 'ACTIVE', ?, ?),
                   (?, ?, ?, 'IronWallB', 'IronWallB', 'ironwallb', 'GOALKEEPER', 2, 'STARTER', 'ACTIVE', ?, ?),
                   (?, ?, ?, 'DefenderBossC', 'DefenderBossC', 'defenderbossc', 'OUTFIELD', 1, 'STARTER', 'ACTIVE', ?, ?)`,
      args: [
        p1OutfieldA, tournamentId, teamAId, now, now,
        p2OutfieldA, tournamentId, teamAId, now, now,
        p3GkA, tournamentId, teamAId, now, now,
        p4OutfieldB, tournamentId, teamBId, now, now,
        p5GkB, tournamentId, teamBId, now, now,
        p6OutfieldC, tournamentId, teamCId, now, now,
      ],
    });

    // 4. Create fixtures and games
    const fixture1 = 'fix-1';
    const game1 = 'game-1'; // A (3) vs B (0) -> Completed, Team A won, Clean sheet for A
    const fixture2 = 'fix-2';
    const game2 = 'game-2'; // B (2) vs C (1) -> Completed, Team B won
    const fixture3 = 'fix-3';
    const game3 = 'game-3'; // Walkover game -> Walkover, NO player stats
    const fixture4 = 'fix-4';
    const game4 = 'game-4'; // In progress game -> NOT completed, should be ignored

    await db.execute({
      sql: `INSERT INTO fixtures (id, tournament_id, stage, team_a_id, team_b_id, left_side_team_id, scheduled_at, status, created_at, updated_at)
            VALUES (?, ?, 'GROUP', ?, ?, ?, ?, 'COMPLETED', ?, ?),
                   (?, ?, 'GROUP', ?, ?, ?, ?, 'COMPLETED', ?, ?),
                   (?, ?, 'GROUP', ?, ?, ?, ?, 'COMPLETED', ?, ?),
                   (?, ?, 'GROUP', ?, ?, ?, ?, 'SCHEDULED', ?, ?)`,
      args: [
        fixture1, tournamentId, teamAId, teamBId, teamAId, now, now, now,
        fixture2, tournamentId, teamBId, teamCId, teamBId, now, now, now,
        fixture3, tournamentId, teamAId, teamCId, teamAId, now, now, now,
        fixture4, tournamentId, teamAId, teamBId, teamAId, now, now, now,
      ],
    });

    await db.execute({
      sql: `INSERT INTO games (id, fixture_id, game_number, status, team_a_score, team_b_score, winner_team_id, is_draw, is_walkover, evidence_status, created_at, updated_at)
            VALUES (?, ?, 1, 'COMPLETED', 3, 0, ?, 0, 0, 'VERIFIED', ?, ?),
                   (?, ?, 1, 'COMPLETED', 2, 1, ?, 0, 0, 'VERIFIED', ?, ?),
                   (?, ?, 1, 'COMPLETED', 3, 0, ?, 0, 1, 'VERIFIED', ?, ?),
                   (?, ?, 1, 'IN_PROGRESS', 0, 0, NULL, 0, 0, 'PENDING', ?, ?)`,
      args: [
        game1, fixture1, teamAId, now, now,
        game2, fixture2, teamBId, now, now,
        game3, fixture3, teamAId, now, now,
        game4, fixture4, now, now,
      ],
    });

    // 5. Create report sessions & versions for referencing
    const session1 = 'sess-1';
    const version1 = 'ver-1';
    await db.execute({
      sql: `INSERT INTO report_sessions (id, fixture_id, submitting_team_id, status, last_message_at, debounce_due_at, version, created_at, updated_at)
            VALUES (?, ?, ?, 'DRAFT_READY', ?, ?, 1, ?, ?)`,
      args: [session1, fixture1, teamAId, now, now, now, now],
    });
    await db.execute({
      sql: `INSERT INTO report_versions (id, report_session_id, fixture_id, version_number, status, extraction_json, validated_data_json, provenance, created_by, created_at)
            VALUES (?, ?, ?, 1, 'LOCKED', '{}', '{}', 'AI', 'SYSTEM', ?)`,
      args: [version1, session1, fixture1, now],
    });

    // 6. Insert player_game_stats for Game 1 (A 3 - 0 B)
    await db.execute({
      sql: `INSERT INTO player_game_stats (id, game_id, player_id, team_id, rating, goals, assists, passes, defense_raw, goalkeeper_saves, is_award_eligible, source_report_version_id, created_at)
            VALUES (?, ?, ?, ?, 9.2, 2, 1, 15, 3, NULL, 1, ?, ?),
                   (?, ?, ?, ?, 8.5, 1, 1, 20, 5, NULL, 1, ?, ?),
                   (?, ?, ?, ?, 9.0, 0, 0, 8, 0, 6, 1, ?, ?),
                   (?, ?, ?, ?, 6.2, 0, 0, 10, 2, NULL, 1, ?, ?),
                   (?, ?, ?, ?, 6.0, 0, 0, 5, 0, 4, 0, ?, ?)`,
      args: [
        randomUUID(), game1, p1OutfieldA, teamAId, version1, now, // StrikerAce: 2G, 1A, 3D
        randomUUID(), game1, p2OutfieldA, teamAId, version1, now, // MidfieldMaestro: 1G, 1A, 5D
        randomUUID(), game1, p3GkA, teamAId, version1, now,       // WallKeeperA: 6 saves, won game -> award_eligible=1
        randomUUID(), game1, p4OutfieldB, teamBId, version1, now, // RivalStriker: 0G, 0A, 2D
        randomUUID(), game1, p5GkB, teamBId, version1, now,       // IronWallB: 4 saves, lost game -> award_eligible=0
      ],
    });

    // 7. Insert player_game_stats for Game 2 (B 2 - 1 C)
    await db.execute({
      sql: `INSERT INTO player_game_stats (id, game_id, player_id, team_id, rating, goals, assists, passes, defense_raw, goalkeeper_saves, is_award_eligible, source_report_version_id, created_at)
            VALUES (?, ?, ?, ?, 8.8, 2, 0, 12, 1, NULL, 1, ?, ?),
                   (?, ?, ?, ?, 8.2, 0, 0, 6, 0, 5, 1, ?, ?),
                   (?, ?, ?, ?, 7.5, 1, 0, 8, 8, NULL, 1, ?, ?)`,
      args: [
        randomUUID(), game2, p4OutfieldB, teamBId, version1, now, // RivalStriker: 2G, 0A, 1D
        randomUUID(), game2, p5GkB, teamBId, version1, now,       // IronWallB: 5 saves, won game -> award_eligible=1
        randomUUID(), game2, p6OutfieldC, teamCId, version1, now, // DefenderBossC: 1G, 0A, 8D
      ],
    });
  });

  afterEach(async () => {
    db.close();
  });

  it('aggregates cumulative player statistics correctly and excludes walkover/incomplete games', async () => {
    const stats = await aggregatePlayerStats(db, tournamentId);
    expect(stats.length).toBe(6);

    const strikerA = stats.find((s) => s.playerId === p1OutfieldA);
    expect(strikerA).toBeDefined();
    expect(strikerA?.totalGoals).toBe(2);
    expect(strikerA?.totalAssists).toBe(1);
    expect(strikerA?.gamesPlayed).toBe(1);
    expect(strikerA?.cleanSheets).toBe(1); // Team A conceded 0 in Game 1
    expect(strikerA?.averageRating).toBe(9.2);

    const keeperA = stats.find((s) => s.playerId === p3GkA);
    expect(keeperA).toBeDefined();
    expect(keeperA?.totalGoalkeeperSaves).toBe(6);
    expect(keeperA?.awardEligibleSaves).toBe(6);
    expect(keeperA?.cleanSheets).toBe(1);

    const rivalB = stats.find((s) => s.playerId === p4OutfieldB);
    expect(rivalB).toBeDefined();
    expect(rivalB?.gamesPlayed).toBe(2); // Played Game 1 and Game 2
    expect(rivalB?.totalGoals).toBe(2); // 0 in Game 1, 2 in Game 2
    expect(rivalB?.cleanSheets).toBe(0); // Conceded 3 in Game 1, 1 in Game 2

    const keeperB = stats.find((s) => s.playerId === p5GkB);
    expect(keeperB).toBeDefined();
    expect(keeperB?.totalGoalkeeperSaves).toBe(9); // 4 in Game 1, 5 in Game 2
    expect(keeperB?.awardEligibleSaves).toBe(5); // Only Game 2 was won by Team B!
  });

  it('filters player stats by team or player ID', async () => {
    const teamAStats = await aggregatePlayerStats(db, tournamentId, { teamId: teamAId });
    expect(teamAStats.length).toBe(3);
    expect(teamAStats.every((s) => s.teamId === teamAId)).toBe(true);

    const singlePlayer = await getPlayerTournamentStats(db, tournamentId, p6OutfieldC);
    expect(singlePlayer).toBeDefined();
    expect(singlePlayer?.nicknameRaw).toBe('DefenderBossC');
    expect(singlePlayer?.totalDefenseRaw).toBe(8);
  });

  it('aggregates team totals across completed games accurately', async () => {
    const teamStats = await aggregateTeamStats(db, tournamentId);
    expect(teamStats.length).toBe(3);

    const teamA = teamStats.find((t) => t.teamId === teamAId);
    expect(teamA).toBeDefined();
    expect(teamA?.gamesPlayed).toBe(2); // Game 1 + Game 3 (Walkover counts in team record)
    expect(teamA?.wins).toBe(2);
    expect(teamA?.goalsFor).toBe(6); // 3 (Game 1) + 3 (WO Game 3)
    expect(teamA?.goalsAgainst).toBe(0);
    expect(teamA?.cleanSheets).toBe(2);
  });

  it('calculates tournament awards according to Competition Rules §10 and D-013/O-013', async () => {
    const awards = await calculateTournamentAwards(db, tournamentId);

    // 1. Golden Boot: StrikerAce (2) and RivalStriker (2) tie -> Co-winners!
    expect(awards.goldenBoot.winners.length).toBe(2);
    expect(awards.goldenBoot.isTie).toBe(true);
    const goldenBootNicknames = awards.goldenBoot.winners.map((w) => w.nicknameRaw);
    expect(goldenBootNicknames).toContain('StrikerAce');
    expect(goldenBootNicknames).toContain('RivalStriker');
    expect(awards.goldenBoot.winners[0].metricValue).toBe(2);

    // 2. Top Assist: StrikerAce (1) and MidfieldMaestro (1) tie
    expect(awards.topAssist.winners.length).toBe(2);
    expect(awards.topAssist.isTie).toBe(true);
    expect(awards.topAssist.winners[0].metricValue).toBe(1);

    // 3. Best Defender: DefenderBossC has 8 total defense_raw (outfield only)
    expect(awards.bestDefender.winners.length).toBe(1);
    expect(awards.bestDefender.winners[0].nicknameRaw).toBe('DefenderBossC');
    expect(awards.bestDefender.winners[0].metricValue).toBe(8);

    // 4. Best Winning Goalkeeper: WallKeeperA has 6 won-game saves vs IronWallB with 5
    expect(awards.bestWinningGoalkeeper.winners.length).toBe(1);
    expect(awards.bestWinningGoalkeeper.winners[0].nicknameRaw).toBe('WallKeeperA');
    expect(awards.bestWinningGoalkeeper.winners[0].metricValue).toBe(6);
  });

  it('honors organizer override for tie-breaking on awards', async () => {
    // Break tie for Golden Boot in favor of StrikerAce
    const awards = await calculateTournamentAwards(db, tournamentId, {
      overrides: {
        GOLDEN_BOOT: [p1OutfieldA],
      },
    });

    expect(awards.goldenBoot.winners.length).toBe(1);
    expect(awards.goldenBoot.winners[0].playerId).toBe(p1OutfieldA);
    expect(awards.goldenBoot.isOverride).toBe(true);
  });
});
