/**
 * Flash Peak TMS - Walkover & Room Host Engine
 * 
 * Manages host assignment, forfeit handling, and strictly distinguishes:
 * 1. Genuine in-game draw (Group Stage only: 1 point each, stats eligible per FR-CALC-001)
 * 2. Double room-card unavailable / double forfeit in Group Stage (0 points each, NO stats per FR-FIX-006, D-031)
 * 3. Double room-card unavailable in Knockout Stage (Mandatory RESCHEDULE per FR-FIX-006, D-032)
 * 4. Single forfeit (host unavailable & opponent declines, or no-show: Group 3-0 WO, KO 0-2/0-3 series loss per FR-FIX-005, D-029)
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  WalkoverType,
  UUID,
  ISODateString,
} from '../shared/types/index.js';
import { getSeriesByFixture } from './series.js';

export type WalkoverResolutionAction =
  | 'GENUINE_DRAW_RECORDED'
  | 'GROUP_DOUBLE_WALKOVER_RECORDED'
  | 'KNOCKOUT_DOUBLE_LOSS_RECORDED'
  | 'SINGLE_FORFEIT_RECORDED';

export interface WalkoverOutcome {
  action: WalkoverResolutionAction;
  fixture_id: UUID;
  game_id?: UUID;
  is_reschedule_required: boolean;
  points_awarded: {
    team_a_points: number;
    team_b_points: number;
  };
  score: {
    team_a_score: number;
    team_b_score: number;
  };
  winner_team_id: UUID | null;
  loser_team_id: UUID | null;
  walkover_type: WalkoverType;
  generates_player_statistics: boolean; // Strictly false for all walkovers per FR-CALC-006!
  reason: string;
}

/**
 * Handles Group Stage double room-card unavailability or double no-show (FR-FIX-006, D-031).
 * Crucial invariant: yields 0 points each, score 0-0, NO player statistics.
 * NEVER conflate with a genuine 1-point draw!
 */
export async function handleGroupDoubleWalkover(
  db: Client,
  fixtureId: string,
  walkoverType: 'DOUBLE_ROOM_CARD_UNAVAILABLE' | 'DOUBLE_ABSENT' = 'DOUBLE_ROOM_CARD_UNAVAILABLE',
  reason: string = 'Kedua tim tidak dapat menyediakan room card / tidak hadir'
): Promise<WalkoverOutcome> {
  const fixtureResult = await db.execute({
    sql: 'SELECT id, tournament_id, stage, team_a_id, team_b_id FROM fixtures WHERE id = ?',
    args: [fixtureId],
  });

  if (fixtureResult.rows.length === 0) {
    throw new Error(`Fixture with id '${fixtureId}' not found`);
  }

  const fixture = fixtureResult.rows[0] as unknown as Record<string, unknown>;
  const stage = String(fixture.stage);

  if (stage !== 'GROUP') {
    throw new Error(
      'handleGroupDoubleWalkover hanya dapat digunakan untuk Group Stage. Pada babak Knockout wajib reschedule (D-032).'
    );
  }

  const now: ISODateString = new Date().toISOString();

  // Upsert game record for this fixture
  const gameResult = await db.execute({
    sql: 'SELECT id FROM games WHERE fixture_id = ? AND game_number = 1',
    args: [fixtureId],
  });

  let gameId: UUID;
  if (gameResult.rows.length > 0) {
    gameId = String(gameResult.rows[0]?.[0] ?? (gameResult.rows[0] as { id?: unknown }).id);
    await db.execute({
      sql: `
        UPDATE games
        SET team_a_score = 0, team_b_score = 0, winner_team_id = NULL,
            is_draw = 0, is_walkover = 1, walkover_type = ?,
            status = 'WALKOVER', updated_at = ?
        WHERE id = ?
      `,
      args: [walkoverType, now, gameId],
    });
  } else {
    gameId = randomUUID();
    await db.execute({
      sql: `
        INSERT INTO games (
          id, fixture_id, series_id, game_number, status,
          team_a_score, team_b_score, winner_team_id, is_draw,
          is_walkover, walkover_type, evidence_status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        gameId,
        fixtureId,
        null,
        1,
        'WALKOVER',
        0,
        0,
        null,
        0,
        1,
        walkoverType,
        'MISSING',
        now,
        now,
      ],
    });
  }

  // Set fixture status to WALKOVER
  await db.execute({
    sql: "UPDATE fixtures SET status = 'WALKOVER', updated_at = ? WHERE id = ?",
    args: [now, fixtureId],
  });

  // Audit event
  await db.execute({
    sql: `
      INSERT INTO audit_events (
        id, actor_type, actor_id, event_type, entity_type, entity_id,
        before_json, after_json, reason, correlation_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      'SYSTEM',
      'COMPETITION_ENGINE',
      'DOUBLE_WALKOVER_RECORDED',
      'FIXTURE',
      fixtureId,
      null,
      JSON.stringify({ walkover_type: walkoverType, points: [0, 0] }),
      reason,
      randomUUID(),
      now,
    ],
  });

  return {
    action: 'GROUP_DOUBLE_WALKOVER_RECORDED',
    fixture_id: fixtureId,
    game_id: gameId,
    is_reschedule_required: false,
    points_awarded: { team_a_points: 0, team_b_points: 0 },
    score: { team_a_score: 0, team_b_score: 0 },
    winner_team_id: null,
    loser_team_id: null,
    walkover_type: walkoverType,
    generates_player_statistics: false, // Double WO produces NO statistics (FR-FIX-006, FR-CALC-006)
    reason,
  };
}

/**
 * Handles Knockout Stage double room-card unavailability / double no-show
 * (FR-FIX-006, D-032 as revised 20 Nov 2026 by the organizer).
 *
 * REVISED RULE (replaces the old mandatory-reschedule ruling): when BOTH
 * teams in a Knockout fixture are absent or cannot provide a room card, BOTH
 * teams are declared LOSERS (double loss). The fixture produces NO winner, so
 * the team scheduled to meet the winner of this fixture in the next round
 * advances automatically (bye/walkover) — !startknockout's next-round
 * generator recognizes a completed double-loss fixture and grants the bye.
 */
export async function handleKnockoutDoubleRoomCardFailure(
  db: Client,
  fixtureId: string,
  reason: string = 'Kedua tim di babak Knockout tidak hadir / tidak dapat menyediakan room card; keduanya dinyatakan kalah (D-032 revisi 20 Nov 2026)'
): Promise<WalkoverOutcome> {
  const fixtureResult = await db.execute({
    sql: 'SELECT id, tournament_id, stage, team_a_id, team_b_id FROM fixtures WHERE id = ?',
    args: [fixtureId],
  });

  if (fixtureResult.rows.length === 0) {
    throw new Error(`Fixture with id '${fixtureId}' not found`);
  }

  const fixture = fixtureResult.rows[0] as unknown as Record<string, unknown>;
  const stage = String(fixture.stage);
  const teamAId = String(fixture.team_a_id);
  const teamBId = String(fixture.team_b_id);

  if (stage !== 'KNOCKOUT') {
    throw new Error(
      'handleKnockoutDoubleRoomCardFailure hanya berlaku untuk babak Knockout. Untuk Group Stage gunakan handleGroupDoubleWalkover.'
    );
  }

  const now: ISODateString = new Date().toISOString();

  // Both teams lose: mark the fixture WALKOVER (resolved, no winner) with a
  // game record carrying the double-loss outcome. No series winner is set,
  // which is exactly what the next-round generator uses to detect a bye.
  await db.execute({
    sql: "UPDATE fixtures SET status = 'WALKOVER', updated_at = ? WHERE id = ?",
    args: [now, fixtureId],
  });

  const gameResult = await db.execute({
    sql: 'SELECT id FROM games WHERE fixture_id = ? AND game_number = 1',
    args: [fixtureId],
  });

  let gameId: UUID;
  if (gameResult.rows.length > 0) {
    gameId = String(gameResult.rows[0]?.[0] ?? (gameResult.rows[0] as { id?: unknown }).id);
    await db.execute({
      sql: `
        UPDATE games
        SET team_a_score = 0, team_b_score = 0, winner_team_id = NULL,
            is_draw = 0, is_walkover = 1, walkover_type = 'DOUBLE_ROOM_CARD_UNAVAILABLE',
            status = 'WALKOVER', updated_at = ?
        WHERE id = ?
      `,
      args: [now, gameId],
    });
  } else {
    gameId = randomUUID();
    await db.execute({
      sql: `
        INSERT INTO games (
          id, fixture_id, series_id, game_number, status,
          team_a_score, team_b_score, winner_team_id, is_draw,
          is_walkover, walkover_type, evidence_status, created_at, updated_at
        )
        VALUES (?, ?, NULL, 1, 'WALKOVER', 0, 0, NULL, 0, 1, 'DOUBLE_ROOM_CARD_UNAVAILABLE', 'MISSING', ?, ?)
      `,
      args: [gameId, fixtureId, now, now],
    });
  }

  // If a series row exists, close it without a winner (double loss).
  await db.execute({
    sql: `UPDATE series SET status = 'COMPLETED', winner_team_id = NULL, updated_at = ?
          WHERE fixture_id = ?`,
    args: [now, fixtureId],
  });

  // Audit event
  await db.execute({
    sql: `
      INSERT INTO audit_events (
        id, actor_type, actor_id, event_type, entity_type, entity_id,
        before_json, after_json, reason, correlation_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      'SYSTEM',
      'COMPETITION_ENGINE',
      'KNOCKOUT_DOUBLE_LOSS_RECORDED',
      'FIXTURE',
      fixtureId,
      JSON.stringify({ team_a_id: teamAId, team_b_id: teamBId }),
      JSON.stringify({ status: 'WALKOVER', winner: null, both_teams_lose: true }),
      reason,
      randomUUID(),
      now,
    ],
  });

  return {
    action: 'KNOCKOUT_DOUBLE_LOSS_RECORDED',
    fixture_id: fixtureId,
    game_id: gameId,
    is_reschedule_required: false,
    points_awarded: { team_a_points: 0, team_b_points: 0 },
    score: { team_a_score: 0, team_b_score: 0 },
    winner_team_id: null,
    loser_team_id: null, // Both teams lose; no single loser column can carry two ids
    walkover_type: 'DOUBLE_ROOM_CARD_UNAVAILABLE',
    generates_player_statistics: false,
    reason,
  };
}

/**
 * Handles single forfeit (FR-FIX-005, D-029, COMPETITION_RULES §6).
 * Opponent wins by forfeit:
 * - Group Stage: 3-0 walkover win, 3 points to winner, 0 to loser. NO player stats.
 * - Knockout Stage: Series awarded to opponent (BO3: 0-2 series loss, BO5: 0-3 series loss). NO player stats.
 */
export async function handleSingleForfeit(
  db: Client,
  fixtureId: string,
  forfeitingTeamId: string,
  reason: string = 'Tim lawan memenangkan pertandingan melalui forfeit/walkover'
): Promise<WalkoverOutcome> {
  const fixtureResult = await db.execute({
    sql: 'SELECT id, tournament_id, stage, team_a_id, team_b_id FROM fixtures WHERE id = ?',
    args: [fixtureId],
  });

  if (fixtureResult.rows.length === 0) {
    throw new Error(`Fixture with id '${fixtureId}' not found`);
  }

  const fixture = fixtureResult.rows[0] as unknown as Record<string, unknown>;
  const stage = String(fixture.stage);
  const teamAId = String(fixture.team_a_id);
  const teamBId = String(fixture.team_b_id);

  if (forfeitingTeamId !== teamAId && forfeitingTeamId !== teamBId) {
    throw new Error(
      `Tim yang forfeit '${forfeitingTeamId}' bukan peserta dalam fixture '${fixtureId}'`
    );
  }

  const winningTeamId = forfeitingTeamId === teamAId ? teamBId : teamAId;
  const now: ISODateString = new Date().toISOString();

  if (stage === 'GROUP') {
    // Group Stage single WO: 3-0 to winner, 3 points (COMPETITION_RULES §6)
    const scoreA = winningTeamId === teamAId ? 3 : 0;
    const scoreB = winningTeamId === teamBId ? 3 : 0;

    const gameResult = await db.execute({
      sql: 'SELECT id FROM games WHERE fixture_id = ? AND game_number = 1',
      args: [fixtureId],
    });

    let gameId: UUID;
    if (gameResult.rows.length > 0) {
      gameId = String(gameResult.rows[0]?.[0] ?? (gameResult.rows[0] as { id?: unknown }).id);
      await db.execute({
        sql: `
          UPDATE games
          SET team_a_score = ?, team_b_score = ?, winner_team_id = ?,
              is_draw = 0, is_walkover = 1, walkover_type = 'SINGLE_FORFEIT',
              status = 'WALKOVER', updated_at = ?
          WHERE id = ?
        `,
        args: [scoreA, scoreB, winningTeamId, now, gameId],
      });
    } else {
      gameId = randomUUID();
      await db.execute({
        sql: `
          INSERT INTO games (
            id, fixture_id, series_id, game_number, status,
            team_a_score, team_b_score, winner_team_id, is_draw,
            is_walkover, walkover_type, evidence_status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          gameId,
          fixtureId,
          null,
          1,
          'WALKOVER',
          scoreA,
          scoreB,
          winningTeamId,
          0,
          1,
          'SINGLE_FORFEIT',
          'MISSING',
          now,
          now,
        ],
      });
    }

    await db.execute({
      sql: "UPDATE fixtures SET status = 'WALKOVER', updated_at = ? WHERE id = ?",
      args: [now, fixtureId],
    });

    return {
      action: 'SINGLE_FORFEIT_RECORDED',
      fixture_id: fixtureId,
      game_id: gameId,
      is_reschedule_required: false,
      points_awarded: {
        team_a_points: winningTeamId === teamAId ? 3 : 0,
        team_b_points: winningTeamId === teamBId ? 3 : 0,
      },
      score: { team_a_score: scoreA, team_b_score: scoreB },
      winner_team_id: winningTeamId,
      loser_team_id: forfeitingTeamId,
      walkover_type: 'SINGLE_FORFEIT',
      generates_player_statistics: false, // WO generates no player stats (FR-CALC-006)
      reason,
    };
  }

  // Knockout Stage Single Forfeit:
  // Opponent wins series (BO3: 2-0, BO5: 3-0)
  const series = await getSeriesByFixture(db, fixtureId);
  if (!series) {
    throw new Error(`Knockout series not found for fixture '${fixtureId}'`);
  }

  const targetWins = series.target_wins; // 2 for BO3, 3 for BO5
  const teamAWins = winningTeamId === teamAId ? targetWins : 0;
  const teamBWins = winningTeamId === teamBId ? targetWins : 0;

  await db.execute({
    sql: `
      UPDATE series
      SET team_a_game_wins = ?, team_b_game_wins = ?,
          status = 'COMPLETED', winner_team_id = ?, updated_at = ?
      WHERE id = ?
    `,
    args: [teamAWins, teamBWins, winningTeamId, now, series.id],
  });

  await db.execute({
    sql: "UPDATE fixtures SET status = 'WALKOVER', updated_at = ? WHERE id = ?",
    args: [now, fixtureId],
  });

  return {
    action: 'SINGLE_FORFEIT_RECORDED',
    fixture_id: fixtureId,
    is_reschedule_required: false,
    points_awarded: { team_a_points: 0, team_b_points: 0 },
    score: {
      team_a_score: teamAWins,
      team_b_score: teamBWins,
    },
    winner_team_id: winningTeamId,
    loser_team_id: forfeitingTeamId,
    walkover_type: 'SINGLE_FORFEIT',
    generates_player_statistics: false,
    reason: `${reason} (Series won by forfeit: ${teamAWins}-${teamBWins})`,
  };
}

/**
 * Resolves room host availability and default host recommendation (FR-FIX-005, D-029).
 * - Default recommended host is left_side_team_id.
 * - If left side cannot host and right side agrees to substitute -> right side hosts.
 * - If left side cannot host and right side refuses -> right side wins by forfeit.
 * - If neither can host:
 *     - Group Stage -> double walkover (0 points each).
 *     - Knockout Stage -> mandatory reschedule.
 */
export async function evaluateRoomHostAvailability(
  db: Client,
  fixtureId: string,
  input: {
    left_side_has_card: boolean;
    right_side_willing_to_host: boolean;
    right_side_has_card?: boolean;
  }
): Promise<{
  match_can_proceed: boolean;
  host_team_id: UUID | null;
  host_assignment_reason: 'DEFAULT_LEFT_SIDE' | 'OPPONENT_SUBSTITUTED' | null;
  walkover_outcome?: WalkoverOutcome;
}> {
  const fixtureResult = await db.execute({
    sql: 'SELECT id, left_side_team_id, team_a_id, team_b_id, stage FROM fixtures WHERE id = ?',
    args: [fixtureId],
  });

  if (fixtureResult.rows.length === 0) {
    throw new Error(`Fixture '${fixtureId}' not found`);
  }

  const fixture = fixtureResult.rows[0] as unknown as Record<string, unknown>;
  const leftSideTeamId = String(fixture.left_side_team_id);
  const rightSideTeamId =
    leftSideTeamId === String(fixture.team_a_id)
      ? String(fixture.team_b_id)
      : String(fixture.team_a_id);
  const stage = String(fixture.stage);

  // Case 1: Designated left-side host has room card
  if (input.left_side_has_card) {
    const now = new Date().toISOString();
    await db.execute({
      sql: `
        UPDATE fixtures
        SET host_team_id = ?, host_assignment_reason = 'DEFAULT_LEFT_SIDE', updated_at = ?
        WHERE id = ?
      `,
      args: [leftSideTeamId, now, fixtureId],
    });

    return {
      match_can_proceed: true,
      host_team_id: leftSideTeamId,
      host_assignment_reason: 'DEFAULT_LEFT_SIDE',
    };
  }

  // Case 2: Left side has no card, but opposing team is willing to host
  if (input.right_side_willing_to_host) {
    const now = new Date().toISOString();
    await db.execute({
      sql: `
        UPDATE fixtures
        SET host_team_id = ?, host_assignment_reason = 'OPPONENT_SUBSTITUTED', updated_at = ?
        WHERE id = ?
      `,
      args: [rightSideTeamId, now, fixtureId],
    });

    return {
      match_can_proceed: true,
      host_team_id: rightSideTeamId,
      host_assignment_reason: 'OPPONENT_SUBSTITUTED',
    };
  }

  // Case 3: Left side has no card and opposing team is UNWILLING to substitute
  // Sub-case 3a: Opposing team also has no card (both cannot host)
  const rightHasCard = input.right_side_has_card ?? false;
  if (!rightHasCard) {
    if (stage === 'GROUP') {
      const outcome = await handleGroupDoubleWalkover(
        db,
        fixtureId,
        'DOUBLE_ROOM_CARD_UNAVAILABLE',
        'Kedua tim tidak memiliki room card untuk pertandingan Group Stage'
      );
      return {
        match_can_proceed: false,
        host_team_id: null,
        host_assignment_reason: null,
        walkover_outcome: outcome,
      };
    } else {
      const outcome = await handleKnockoutDoubleRoomCardFailure(
        db,
        fixtureId,
        'Kedua tim tidak memiliki room card untuk pertandingan Knockout; keduanya dinyatakan kalah (double loss)'
      );
      return {
        match_can_proceed: false,
        host_team_id: null,
        host_assignment_reason: null,
        walkover_outcome: outcome,
      };
    }
  }

  // Sub-case 3b: Opponent had card or declined to substitute -> opponent wins by forfeit (FR-FIX-005)
  const outcome = await handleSingleForfeit(
    db,
    fixtureId,
    leftSideTeamId,
    'Tim tuan rumah (left side) tidak memiliki room card dan lawan menolak menggantikan; lawan menang WO'
  );

  return {
    match_can_proceed: false,
    host_team_id: null,
    host_assignment_reason: null,
    walkover_outcome: outcome,
  };
}
