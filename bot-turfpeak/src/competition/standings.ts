/**
 * Flash Peak TMS - Group Standings Calculator
 * 
 * Computes official group stage standings derived strictly from approved/locked games (FR-CALC-007).
 * Implements tie-breaking order per FR-CALC-001/002 and COMPETITION_RULES §3.2:
 * 1. Points (Win 3 / Draw 1 / Loss 0; Double WO = 0)
 * 2. Goal Difference (GD)
 * 3. Goals For (GF)
 * 4. Head-to-Head points among tied teams
 * 5. Head-to-Head GD
 * 6. Head-to-Head GF
 * 7. Stable tie-resolution / playoff requirement
 */

import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  Standing,
  UUID,
  ISODateString,
  WalkoverType,
} from '../shared/types/index.js';

export interface CompletedGameRecord {
  id: UUID;
  fixture_id: UUID;
  team_a_id: UUID;
  team_b_id: UUID;
  team_a_score: number | null;
  team_b_score: number | null;
  winner_team_id: UUID | null;
  is_draw: number; // 1 for genuine draw
  is_walkover: number; // 1 for walkover
  walkover_type: WalkoverType | null;
  status: string; // Must be 'COMPLETED' or 'WALKOVER' to count
}

export interface GroupTeamInfo {
  team_id: UUID;
  team_name: string;
}

export interface StandingWithTeamName extends Standing {
  team_name: string;
  rank: number;
}

/**
 * Computes group standings from given teams and locked games.
 * Pure deterministic logic.
 */
export function computeGroupStandings(
  tournamentId: string,
  groupId: string,
  teams: GroupTeamInfo[],
  completedGames: CompletedGameRecord[]
): StandingWithTeamName[] {
  // Filter for valid completed/locked games only (FR-CALC-007)
  const validGames = completedGames.filter(
    (g) =>
      (g.status === 'COMPLETED' || g.status === 'WALKOVER') &&
      g.team_a_score !== null &&
      g.team_b_score !== null
  );

  // Initialize accumulator map for each team
  interface TeamAccumulator {
    team_id: UUID;
    team_name: string;
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goals_for: number;
    goals_against: number;
    goal_difference: number;
    points: number;
    head_to_head_points: number;
    h2h_gd: number;
    h2h_gf: number;
  }

  const teamMap = new Map<UUID, TeamAccumulator>();
  for (const t of teams) {
    teamMap.set(t.team_id, {
      team_id: t.team_id,
      team_name: t.team_name,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goals_for: 0,
      goals_against: 0,
      goal_difference: 0,
      points: 0,
      head_to_head_points: 0,
      h2h_gd: 0,
      h2h_gf: 0,
    });
  }

  // Accumulate basic match stats
  for (const game of validGames) {
    const teamA = teamMap.get(game.team_a_id);
    const teamB = teamMap.get(game.team_b_id);

    if (!teamA || !teamB) {
      continue;
    }

    const scoreA = game.team_a_score!;
    const scoreB = game.team_b_score!;

    teamA.played += 1;
    teamB.played += 1;
    teamA.goals_for += scoreA;
    teamA.goals_against += scoreB;
    teamB.goals_for += scoreB;
    teamB.goals_against += scoreA;

    if (game.is_walkover) {
      if (
        game.walkover_type === 'DOUBLE_ROOM_CARD_UNAVAILABLE' ||
        game.walkover_type === 'DOUBLE_ABSENT'
      ) {
        // Double forfeit / double room-card unavailable:
        // FR-FIX-006 & D-031: 0 points each, NO player statistics.
        // Both receive a loss / 0 points.
        teamA.losses += 1;
        teamB.losses += 1;
        // Points remain +0 for both
      } else if (game.winner_team_id === teamA.team_id) {
        // Single forfeit: teamA wins 3-0
        teamA.wins += 1;
        teamA.points += 3;
        teamB.losses += 1;
      } else if (game.winner_team_id === teamB.team_id) {
        // Single forfeit: teamB wins 3-0
        teamB.wins += 1;
        teamB.points += 3;
        teamA.losses += 1;
      } else {
        // Unspecified WO winner: fallback 0 points each
        teamA.losses += 1;
        teamB.losses += 1;
      }
    } else if (game.is_draw || scoreA === scoreB) {
      // Genuine in-game draw: 1 point each (FR-CALC-001)
      teamA.draws += 1;
      teamB.draws += 1;
      teamA.points += 1;
      teamB.points += 1;
    } else if (scoreA > scoreB) {
      teamA.wins += 1;
      teamA.points += 3;
      teamB.losses += 1;
    } else {
      teamB.wins += 1;
      teamB.points += 3;
      teamA.losses += 1;
    }
  }

  // Calculate goal differences
  for (const acc of teamMap.values()) {
    acc.goal_difference = acc.goals_for - acc.goals_against;
  }

  const teamList = Array.from(teamMap.values());

  // Function to compute head-to-head metrics among a group of tied teams
  function calculateH2H(tiedSubset: TeamAccumulator[]): void {
    const tiedIds = new Set(tiedSubset.map((t) => t.team_id));

    // Reset H2H metrics for tied teams
    for (const t of tiedSubset) {
      t.head_to_head_points = 0;
      t.h2h_gd = 0;
      t.h2h_gf = 0;
    }

    // Filter games between teams in tiedSubset
    const h2hGames = validGames.filter(
      (g) => tiedIds.has(g.team_a_id) && tiedIds.has(g.team_b_id)
    );

    for (const g of h2hGames) {
      const a = teamMap.get(g.team_a_id);
      const b = teamMap.get(g.team_b_id);
      if (!a || !b) continue;

      const scoreA = g.team_a_score!;
      const scoreB = g.team_b_score!;

      a.h2h_gf += scoreA;
      b.h2h_gf += scoreB;
      a.h2h_gd += scoreA - scoreB;
      b.h2h_gd += scoreB - scoreA;

      if (g.is_walkover) {
        if (
          g.walkover_type === 'DOUBLE_ROOM_CARD_UNAVAILABLE' ||
          g.walkover_type === 'DOUBLE_ABSENT'
        ) {
          // 0 pts each
        } else if (g.winner_team_id === a.team_id) {
          a.head_to_head_points += 3;
        } else if (g.winner_team_id === b.team_id) {
          b.head_to_head_points += 3;
        }
      } else if (g.is_draw || scoreA === scoreB) {
        a.head_to_head_points += 1;
        b.head_to_head_points += 1;
      } else if (scoreA > scoreB) {
        a.head_to_head_points += 3;
      } else {
        b.head_to_head_points += 3;
      }
    }
  }

  // Initial group sort by primary criteria: Points -> GD -> GF
  teamList.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goal_difference !== a.goal_difference)
      return b.goal_difference - a.goal_difference;
    return b.goals_for - a.goals_for;
  });

  // Group tied clusters and resolve with Head-to-Head
  const resolvedList: TeamAccumulator[] = [];
  let i = 0;

  while (i < teamList.length) {
    let j = i + 1;
    while (
      j < teamList.length &&
      teamList[j]!.points === teamList[i]!.points &&
      teamList[j]!.goal_difference === teamList[i]!.goal_difference &&
      teamList[j]!.goals_for === teamList[i]!.goals_for
    ) {
      j++;
    }

    const tiedCluster = teamList.slice(i, j);
    if (tiedCluster.length > 1) {
      // Calculate Head-to-Head among tiedCluster
      calculateH2H(tiedCluster);

      // Sort cluster by H2H Points -> H2H GD -> H2H GF -> stable team_name
      tiedCluster.sort((a, b) => {
        if (b.head_to_head_points !== a.head_to_head_points) {
          return b.head_to_head_points - a.head_to_head_points;
        }
        if (b.h2h_gd !== a.h2h_gd) {
          return b.h2h_gd - a.h2h_gd;
        }
        if (b.h2h_gf !== a.h2h_gf) {
          return b.h2h_gf - a.h2h_gf;
        }
        return a.team_name.localeCompare(b.team_name);
      });
    }

    for (const team of tiedCluster) {
      resolvedList.push(team);
    }
    i = j;
  }

  const now: ISODateString = new Date().toISOString();
  const sourceRevision = createHash('sha256')
    .update(
      JSON.stringify(
        validGames.map((g) => ({
          id: g.id,
          a: g.team_a_score,
          b: g.team_b_score,
          w: g.winner_team_id,
        }))
      )
    )
    .digest('hex')
    .substring(0, 16);

  return resolvedList.map((item, index) => ({
    tournament_id: tournamentId,
    group_id: groupId,
    team_id: item.team_id,
    team_name: item.team_name,
    rank: index + 1,
    played: item.played,
    wins: item.wins,
    draws: item.draws,
    losses: item.losses,
    goals_for: item.goals_for,
    goals_against: item.goals_against,
    goal_difference: item.goal_difference,
    points: item.points,
    head_to_head_points: item.head_to_head_points,
    computed_at: now,
    source_revision: sourceRevision,
  }));
}

/**
 * Recomputes and persists group standings to the database for a specific group.
 */
export async function recalculateAndPersistGroupStandings(
  db: Client,
  tournamentId: string,
  groupId: string
): Promise<StandingWithTeamName[]> {
  // Fetch group teams
  const teamsResult = await db.execute({
    sql: `
      SELECT t.id as team_id, t.team_name
      FROM group_members gm
      JOIN teams t ON gm.team_id = t.id
      WHERE gm.group_id = ?
    `,
    args: [groupId],
  });

  const teams: GroupTeamInfo[] = teamsResult.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      team_id: String(row.team_id),
      team_name: String(row.team_name),
    };
  });

  // Fetch approved/locked games for this group
  const gamesResult = await db.execute({
    sql: `
      SELECT g.id, g.fixture_id, f.team_a_id, f.team_b_id,
             g.team_a_score, g.team_b_score, g.winner_team_id,
             g.is_draw, g.is_walkover, g.walkover_type, g.status
      FROM games g
      JOIN fixtures f ON g.fixture_id = f.id
      WHERE f.tournament_id = ? AND f.group_id = ?
    `,
    args: [tournamentId, groupId],
  });

  const completedGames: CompletedGameRecord[] = gamesResult.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      id: String(row.id),
      fixture_id: String(row.fixture_id),
      team_a_id: String(row.team_a_id),
      team_b_id: String(row.team_b_id),
      team_a_score: row.team_a_score !== null ? Number(row.team_a_score) : null,
      team_b_score: row.team_b_score !== null ? Number(row.team_b_score) : null,
      winner_team_id: row.winner_team_id ? String(row.winner_team_id) : null,
      is_draw: Number(row.is_draw || 0),
      is_walkover: Number(row.is_walkover || 0),
      walkover_type: (row.walkover_type as WalkoverType) || null,
      status: String(row.status),
    };
  });

  const calculatedStandings = computeGroupStandings(
    tournamentId,
    groupId,
    teams,
    completedGames
  );

  // Persist to standings table
  for (const s of calculatedStandings) {
    await db.execute({
      sql: `
        INSERT OR REPLACE INTO standings (
          tournament_id, group_id, team_id, played, wins, draws, losses,
          goals_for, goals_against, goal_difference, points, head_to_head_points,
          computed_at, source_revision
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        s.tournament_id,
        s.group_id,
        s.team_id,
        s.played,
        s.wins,
        s.draws,
        s.losses,
        s.goals_for,
        s.goals_against,
        s.goal_difference,
        s.points,
        s.head_to_head_points,
        s.computed_at,
        s.source_revision,
      ],
    });
  }

  return calculatedStandings;
}

/**
 * Reads existing persisted standings for a group.
 */
export async function getGroupStandings(
  db: Client,
  groupId: string
): Promise<StandingWithTeamName[]> {
  const result = await db.execute({
    sql: `
      SELECT s.*, t.team_name
      FROM standings s
      JOIN teams t ON s.team_id = t.id
      WHERE s.group_id = ?
      ORDER BY s.points DESC, s.goal_difference DESC, s.goals_for DESC, s.head_to_head_points DESC, t.team_name ASC
    `,
    args: [groupId],
  });

  return result.rows.map((r, idx) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      tournament_id: String(row.tournament_id),
      group_id: String(row.group_id),
      team_id: String(row.team_id),
      team_name: String(row.team_name),
      rank: idx + 1,
      played: Number(row.played),
      wins: Number(row.wins),
      draws: Number(row.draws),
      losses: Number(row.losses),
      goals_for: Number(row.goals_for),
      goals_against: Number(row.goals_against),
      goal_difference: Number(row.goal_difference),
      points: Number(row.points),
      head_to_head_points: Number(row.head_to_head_points),
      computed_at: String(row.computed_at),
      source_revision: String(row.source_revision),
    };
  });
}
