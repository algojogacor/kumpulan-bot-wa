/**
 * Flash Peak TMS - Cumulative Statistics Aggregator (Task 6.1)
 * 
 * Recomputes player and team totals authoritatively from approved/locked games only (FR-CALC-007).
 * Never trusts LLM totals — all values are derived strictly from source `player_game_stats`
 * joined with completed, locked `games` records.
 * 
 * Walkovers generate NO player statistics (FR-CALC-006) and are excluded from player totals.
 */

import type { Client, InValue } from '@libsql/client';
import type { UUID } from '../shared/types/index.js';

export interface AggregatedPlayerStats {
  playerId: UUID;
  tournamentId: UUID;
  teamId: UUID;
  teamName: string;
  nicknameRaw: string;
  position: 'GOALKEEPER' | 'OUTFIELD';
  gamesPlayed: number;
  totalGoals: number;
  totalAssists: number;
  totalPasses: number;
  totalDefenseRaw: number;
  totalGoalkeeperSaves: number;
  awardEligibleSaves: number; // goalkeeper_saves where is_award_eligible = 1 (FR-GK-008)
  cleanSheets: number;
  averageRating: number | null;
}

export interface PlayerStatsFilter {
  teamId?: UUID;
  playerId?: UUID;
  position?: 'GOALKEEPER' | 'OUTFIELD';
}

export interface AggregatedTeamStats {
  teamId: UUID;
  teamName: string;
  tournamentId: UUID;
  gamesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  cleanSheets: number;
  totalPasses: number;
  totalDefenseRaw: number;
  totalSaves: number;
}

/**
 * Aggregates cumulative statistics for players in a tournament from approved/locked games only.
 */
export async function aggregatePlayerStats(
  db: Client,
  tournamentId: UUID,
  filter?: PlayerStatsFilter
): Promise<AggregatedPlayerStats[]> {
  const params: InValue[] = [tournamentId];
  let filterClause = '';

  if (filter?.teamId) {
    filterClause += ' AND p.team_id = ?';
    params.push(filter.teamId);
  }
  if (filter?.playerId) {
    filterClause += ' AND p.id = ?';
    params.push(filter.playerId);
  }
  if (filter?.position) {
    filterClause += ' AND p.position = ?';
    params.push(filter.position);
  }

  // Join players, teams, player_game_stats, games, fixtures
  // Filter for completed, non-walkover games (FR-CALC-006, FR-CALC-007)
  const sql = `
    SELECT
      p.id AS player_id,
      p.tournament_id,
      p.team_id,
      t.team_name AS team_name,
      p.nickname_raw,
      p.position,
      COUNT(pgs.id) AS games_played,
      SUM(COALESCE(pgs.goals, 0)) AS total_goals,
      SUM(COALESCE(pgs.assists, 0)) AS total_assists,
      SUM(COALESCE(pgs.passes, 0)) AS total_passes,
      SUM(COALESCE(pgs.defense_raw, 0)) AS total_defense_raw,
      SUM(COALESCE(pgs.goalkeeper_saves, 0)) AS total_saves,
      SUM(CASE WHEN pgs.is_award_eligible = 1 THEN COALESCE(pgs.goalkeeper_saves, 0) ELSE 0 END) AS award_eligible_saves,
      AVG(pgs.rating) AS average_rating,
      SUM(
        CASE
          WHEN (f.team_a_id = pgs.team_id AND g.team_b_score = 0)
            OR (f.team_b_id = pgs.team_id AND g.team_a_score = 0)
          THEN 1
          ELSE 0
        END
      ) AS clean_sheets
    FROM players p
    JOIN teams t ON p.team_id = t.id
    JOIN player_game_stats pgs ON p.id = pgs.player_id
    JOIN games g ON pgs.game_id = g.id
    JOIN fixtures f ON g.fixture_id = f.id
    WHERE p.tournament_id = ?
      AND p.status = 'ACTIVE'
      AND g.status = 'COMPLETED'
      AND g.is_walkover = 0
      ${filterClause}
    GROUP BY p.id, p.tournament_id, p.team_id, t.team_name, p.nickname_raw, p.position
    ORDER BY total_goals DESC, total_assists DESC, total_defense_raw DESC, games_played DESC
  `;

  const res = await db.execute({ sql, args: params });

  return res.rows.map((row) => {
    const rawAvg = row[13] != null ? Number(row[13]) : null;
    return {
      playerId: String(row[0]),
      tournamentId: String(row[1]),
      teamId: String(row[2]),
      teamName: String(row[3]),
      nicknameRaw: String(row[4]),
      position: String(row[5]) as 'GOALKEEPER' | 'OUTFIELD',
      gamesPlayed: Number(row[6] ?? 0),
      totalGoals: Number(row[7] ?? 0),
      totalAssists: Number(row[8] ?? 0),
      totalPasses: Number(row[9] ?? 0),
      totalDefenseRaw: Number(row[10] ?? 0),
      totalGoalkeeperSaves: Number(row[11] ?? 0),
      awardEligibleSaves: Number(row[12] ?? 0),
      averageRating: rawAvg !== null && !isNaN(rawAvg) ? Number(rawAvg.toFixed(2)) : null,
      cleanSheets: Number(row[14] ?? 0),
    };
  });
}

/**
 * Gets aggregated tournament stats for a single player.
 */
export async function getPlayerTournamentStats(
  db: Client,
  tournamentId: UUID,
  playerId: UUID
): Promise<AggregatedPlayerStats | null> {
  const stats = await aggregatePlayerStats(db, tournamentId, { playerId });
  return stats[0] || null;
}

/**
 * Aggregates team totals across all completed, locked games in a tournament.
 */
export async function aggregateTeamStats(
  db: Client,
  tournamentId: UUID
): Promise<AggregatedTeamStats[]> {
  // First, get all teams in tournament
  const teamsRes = await db.execute({
    sql: 'SELECT id, team_name FROM teams WHERE tournament_id = ? ORDER BY team_name ASC',
    args: [tournamentId],
  });

  const results: AggregatedTeamStats[] = [];

  for (const teamRow of teamsRes.rows) {
    const teamId = String(teamRow[0]);
    const teamName = String(teamRow[1]);

    // Query completed games involving this team
    const gamesRes = await db.execute({
      sql: `
        SELECT
          g.id,
          f.team_a_id,
          f.team_b_id,
          g.team_a_score,
          g.team_b_score,
          g.winner_team_id,
          g.is_draw,
          g.is_walkover
        FROM games g
        JOIN fixtures f ON g.fixture_id = f.id
        WHERE f.tournament_id = ?
          AND (f.team_a_id = ? OR f.team_b_id = ?)
          AND g.status IN ('COMPLETED', 'WALKOVER')
          AND g.team_a_score IS NOT NULL
          AND g.team_b_score IS NOT NULL
      `,
      args: [tournamentId, teamId, teamId],
    });

    let gamesPlayed = 0;
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let goalsFor = 0;
    let goalsAgainst = 0;
    let cleanSheets = 0;

    for (const gRow of gamesRes.rows) {
      gamesPlayed++;
      const teamAId = String(gRow[1]);
      const scoreA = Number(gRow[3]);
      const scoreB = Number(gRow[4]);
      const winnerId = gRow[5] ? String(gRow[5]) : null;
      const isDraw = Number(gRow[6]) === 1;

      const isTeamA = teamId === teamAId;
      const myScore = isTeamA ? scoreA : scoreB;
      const oppScore = isTeamA ? scoreB : scoreA;

      goalsFor += myScore;
      goalsAgainst += oppScore;

      if (oppScore === 0) {
        cleanSheets++;
      }

      if (isDraw) {
        draws++;
      } else if (winnerId === teamId) {
        wins++;
      } else {
        losses++;
      }
    }

    // Query player aggregates for passes, defense_raw, saves
    const playerAggRes = await db.execute({
      sql: `
        SELECT
          SUM(COALESCE(pgs.passes, 0)) AS total_passes,
          SUM(COALESCE(pgs.defense_raw, 0)) AS total_defense,
          SUM(COALESCE(pgs.goalkeeper_saves, 0)) AS total_saves
        FROM player_game_stats pgs
        JOIN games g ON pgs.game_id = g.id
        WHERE pgs.team_id = ?
          AND g.status = 'COMPLETED'
          AND g.is_walkover = 0
      `,
      args: [teamId],
    });

    const pRow = playerAggRes.rows[0];
    const totalPasses = Number(pRow?.[0] ?? 0);
    const totalDefenseRaw = Number(pRow?.[1] ?? 0);
    const totalSaves = Number(pRow?.[2] ?? 0);

    results.push({
      teamId,
      teamName,
      tournamentId,
      gamesPlayed,
      wins,
      draws,
      losses,
      goalsFor,
      goalsAgainst,
      goalDifference: goalsFor - goalsAgainst,
      cleanSheets,
      totalPasses,
      totalDefenseRaw,
      totalSaves,
    });
  }

  return results;
}
