/**
 * Flash Peak TMS - Player Game Stats & Report Lock Finalizer (Task 5.6)
 * 
 * Writes validated player statistics to `player_game_stats` and finalizes `games`
 * when a report version transitions to `LOCKED`.
 * 
 * Rules:
 * 1. Walkovers generate NO player statistics (FR-CALC-006).
 * 2. `defense_raw` and `goalkeeper_saves` are preserved separately.
 * 3. Award eligibility (FR-GK-008):
 *    - Outfield players: `is_award_eligible = 1`.
 *    - Goalkeepers: `is_award_eligible = 1` ONLY for won games (0 for lost or drawn games).
 * 4. Authoritative game finalization: Updates `games` with score, winner, draw flag, and COMPLETED status.
 * 5. Standings recalculation: Updates group standings if fixture is part of Group Stage.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  ValidatedMatchData,
  UUID,
  ISODateString,
} from '../shared/types/index.js';
import { getReportVersion } from './versioning.js';
import { recalculateAndPersistGroupStandings } from '../competition/standings.js';

export interface ReportLockOutcome {
  locked: boolean;
  gameId: UUID;
  statsWrittenCount: number;
  winnerTeamId: UUID | null;
  isDraw: boolean;
  isWalkover: boolean;
}

/**
 * Executes post-lock side-effects when a report version is officialized (`LOCKED`).
 */
export async function onReportLocked(
  db: Client,
  reportVersionId: UUID
): Promise<ReportLockOutcome> {
  const version = await getReportVersion(db, reportVersionId);
  if (!version) {
    throw new Error(`Report version not found: ${reportVersionId}`);
  }

  const validatedData: ValidatedMatchData = JSON.parse(version.validated_data_json);
  const now: ISODateString = new Date().toISOString();

  // 1. Fetch game record
  const gameRes = await db.execute({
    sql: 'SELECT id, fixture_id, series_id, game_number, status, is_walkover, walkover_type FROM games WHERE id = ?',
    args: [validatedData.game_id],
  });

  if (gameRes.rows.length === 0) {
    throw new Error(`Game not found: ${validatedData.game_id}`);
  }

  const gameRow = gameRes.rows[0];
  const isWalkover = Number(gameRow[5]) === 1;

  // 2. Walkover Rule: Walkovers generate NO player statistics (FR-CALC-006)
  if (isWalkover) {
    await db.execute({
      sql: `
        UPDATE games
        SET status = 'COMPLETED', updated_at = ?
        WHERE id = ?
      `,
      args: [now, validatedData.game_id],
    });

    // Check Fixture and Group Standings
    const fixtureRes = await db.execute({
      sql: 'SELECT id, tournament_id, stage, group_id FROM fixtures WHERE id = ?',
      args: [validatedData.fixture_id],
    });

    if (fixtureRes.rows.length > 0) {
      const fRow = fixtureRes.rows[0];
      const tournamentId = String(fRow[1]);
      const stage = String(fRow[2]);
      const groupId = fRow[3] ? String(fRow[3]) : null;

      const gamesRes = await db.execute({
        sql: "SELECT COUNT(*) as unfinished FROM games WHERE fixture_id = ? AND status NOT IN ('COMPLETED', 'WALKOVER')",
        args: [validatedData.fixture_id],
      });
      const unfinished = Number(gamesRes.rows[0]?.[0] ?? (gamesRes.rows[0] as { unfinished?: unknown })?.unfinished ?? 0);
      if (unfinished === 0) {
        await db.execute({
          sql: "UPDATE fixtures SET status = 'COMPLETED', updated_at = ? WHERE id = ?",
          args: [now, validatedData.fixture_id],
        });
      }

      if (stage === 'GROUP' && groupId) {
        try {
          await recalculateAndPersistGroupStandings(db, tournamentId, groupId);
        } catch (err) {
          console.warn(`[reports:stats] Standings recalculation notice: ${String(err)}`);
        }
      }
    }

    return {
      locked: true,
      gameId: validatedData.game_id,
      statsWrittenCount: 0,
      winnerTeamId: null,
      isDraw: false,
      isWalkover: true,
    };
  }

  // 3. Determine winner and draw status
  const scoreA = validatedData.team_a_score;
  const scoreB = validatedData.team_b_score;
  const isDraw = scoreA === scoreB;
  let winnerTeamId: UUID | null = null;
  if (scoreA > scoreB) {
    winnerTeamId = validatedData.team_a_id;
  } else if (scoreB > scoreA) {
    winnerTeamId = validatedData.team_b_id;
  }

  // 4. Look up registered player positions for award eligibility
  const allPlayerIds = [
    ...validatedData.team_a_players.map((p) => p.player_id),
    ...validatedData.team_b_players.map((p) => p.player_id),
  ].filter(Boolean);

  const playerPositions = new Map<string, string>();
  const playerStatuses = new Map<string, string>();
  if (allPlayerIds.length > 0) {
    const placeholders = allPlayerIds.map(() => '?').join(',');
    const posRes = await db.execute({
      sql: `SELECT id, position, status FROM players WHERE id IN (${placeholders})`,
      args: allPlayerIds,
    });
    for (const r of posRes.rows) {
      playerPositions.set(String(r[0]), String(r[1]));
      playerStatuses.set(String(r[0]), String(r[2]));
    }
  }

  // 5. Write Player Game Stats
  let statsWrittenCount = 0;

  const allPlayers = [
    ...validatedData.team_a_players.map((p) => ({ ...p, team_id: validatedData.team_a_id })),
    ...validatedData.team_b_players.map((p) => ({ ...p, team_id: validatedData.team_b_id })),
  ];

  for (const p of allPlayers) {
    if (!p.player_id) continue;

    const pos = playerPositions.get(p.player_id) || (p.goalkeeper_saves !== null ? 'GOALKEEPER' : 'OUTFIELD');
    const status = playerStatuses.get(p.player_id) || 'ACTIVE';
    const isGK = pos === 'GOALKEEPER';

    // FR-GK-008 & Rule 2.12:
    // Ineligible players (e.g. unregistered player on losing team) are NEVER award-eligible (0).
    // Outfield active players are award eligible (1);
    // Goalkeepers are eligible (1) ONLY for won games (0 for lost or drawn games).
    let isAwardEligible = 1;
    if (status === 'INELIGIBLE') {
      isAwardEligible = 0;
    } else if (isGK) {
      const gkTeamWon = winnerTeamId !== null && winnerTeamId === p.team_id;
      isAwardEligible = gkTeamWon ? 1 : 0;
    }

    const statId: UUID = randomUUID();
    const statsJson = JSON.stringify({
      rating: p.rating,
      goals: p.goals,
      assists: p.assists,
      passes: p.passes,
      defense_raw: p.defense_raw,
      goalkeeper_saves: p.goalkeeper_saves,
    });

    await db.execute({
      sql: `
        INSERT OR REPLACE INTO player_game_stats (
          id, game_id, player_id, team_id, rating,
          goals, assists, passes, defense_raw, goalkeeper_saves,
          stats_json, source_report_version_id, is_award_eligible, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        statId,
        validatedData.game_id,
        p.player_id,
        p.team_id,
        p.rating,
        p.goals,
        p.assists,
        p.passes,
        p.defense_raw,
        p.goalkeeper_saves,
        statsJson,
        reportVersionId,
        isAwardEligible,
        now,
      ],
    });

    statsWrittenCount++;
  }

  // 6. Finalize Game Record
  await db.execute({
    sql: `
      UPDATE games
      SET status = 'COMPLETED',
          team_a_score = ?,
          team_b_score = ?,
          winner_team_id = ?,
          is_draw = ?,
          evidence_status = 'VERIFIED',
          updated_at = ?
      WHERE id = ?
    `,
    args: [
      scoreA,
      scoreB,
      winnerTeamId,
      isDraw ? 1 : 0,
      now,
      validatedData.game_id,
    ],
  });

  // 7. Check Fixture and Group Standings
  const fixtureRes = await db.execute({
    sql: 'SELECT id, tournament_id, stage, group_id FROM fixtures WHERE id = ?',
    args: [validatedData.fixture_id],
  });

  if (fixtureRes.rows.length > 0) {
    const fRow = fixtureRes.rows[0];
    const tournamentId = String(fRow[1]);
    const stage = String(fRow[2]);
    const groupId = fRow[3] ? String(fRow[3]) : null;

    // Check if all games for fixture are completed
    const gamesRes = await db.execute({
      sql: "SELECT COUNT(*) as unfinished FROM games WHERE fixture_id = ? AND status NOT IN ('COMPLETED', 'WALKOVER')",
      args: [validatedData.fixture_id],
    });
    const unfinished = Number(gamesRes.rows[0]?.[0] ?? (gamesRes.rows[0] as { unfinished?: unknown })?.unfinished ?? 0);
    if (unfinished === 0) {
      await db.execute({
        sql: "UPDATE fixtures SET status = 'COMPLETED', updated_at = ? WHERE id = ?",
        args: [now, validatedData.fixture_id],
      });
    }

    // Recalculate group standings if group stage
    if (stage === 'GROUP' && groupId) {
      try {
        await recalculateAndPersistGroupStandings(db, tournamentId, groupId);
      } catch (err) {
        console.warn(`[reports:stats] Standings recalculation notice: ${String(err)}`);
      }
    }
  }

  return {
    locked: true,
    gameId: validatedData.game_id,
    statsWrittenCount,
    winnerTeamId,
    isDraw,
    isWalkover: false,
  };
}
