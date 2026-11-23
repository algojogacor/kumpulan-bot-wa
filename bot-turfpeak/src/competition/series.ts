/**
 * Flash Peak TMS - Knockout Series Engine (BO3 / BO5)
 * 
 * Manages best-of-series lifecycles, target wins (BO3 = 2, BO5 = 3),
 * and individual tied game replay handling reusing the same game_number slot
 * (FR-CALC-003, FR-CALC-004, FR-CALC-005, D-010, D-011, D-028).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  Series,
  Game,
  SeriesFormat,
  UUID,
  ISODateString,
} from '../shared/types/index.js';

export interface RecordSeriesGameInput {
  series_id: UUID;
  game_number: number;
  team_a_score: number;
  team_b_score: number;
  evidence_status?: 'PENDING' | 'RECEIVED' | 'VERIFIED' | 'MISSING';
  is_replay?: boolean;
  /**
   * AUDIT-VERIFY-T5 (21 Nov 2026): organizer correction path (!kores) must be
   * able to RE-RECORD a game of an already COMPLETED series (documented in
   * cara-penggunaan.md §"Kalau Ada Masalah di Knockout"). The photo pipeline
   * (ko-evidence-pipeline) never sets this flag — it keeps the old behavior
   * of rejecting photos for completed series.
   */
  allow_completed_series?: boolean;
}

export interface SeriesGameResultOutcome {
  series: Series;
  game: Game;
  is_tied_game: boolean;
  is_replay_required: boolean;
  is_series_complete: boolean;
  winner_team_id: UUID | null;
  next_game_number: number | null;
  message: string;
}

/**
 * Pure calculation helper for series completion status.
 */
export function evaluateSeriesProgress(
  format: SeriesFormat,
  teamAGameWins: number,
  teamBGameWins: number
): {
  target_wins: number;
  is_complete: boolean;
  winner: 'TEAM_A' | 'TEAM_B' | null;
} {
  const targetWins = format === 'BO5' ? 3 : 2;
  if (teamAGameWins >= targetWins) {
    return { target_wins: targetWins, is_complete: true, winner: 'TEAM_A' };
  }
  if (teamBGameWins >= targetWins) {
    return { target_wins: targetWins, is_complete: true, winner: 'TEAM_B' };
  }
  return { target_wins: targetWins, is_complete: false, winner: null };
}

/**
 * Retrieves a series by ID.
 */
export async function getSeries(db: Client, seriesId: string): Promise<Series | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM series WHERE id = ?',
    args: [seriesId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as unknown as Record<string, unknown>;
  return {
    id: String(row.id),
    fixture_id: String(row.fixture_id),
    format: row.format as Series['format'],
    target_wins: Number(row.target_wins),
    status: row.status as Series['status'],
    winner_team_id: row.winner_team_id ? String(row.winner_team_id) : null,
    team_a_game_wins: Number(row.team_a_game_wins),
    team_b_game_wins: Number(row.team_b_game_wins),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * Retrieves a series by its associated fixture ID.
 */
export async function getSeriesByFixture(
  db: Client,
  fixtureId: string
): Promise<Series | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM series WHERE fixture_id = ?',
    args: [fixtureId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as unknown as Record<string, unknown>;
  return {
    id: String(row.id),
    fixture_id: String(row.fixture_id),
    format: row.format as Series['format'],
    target_wins: Number(row.target_wins),
    status: row.status as Series['status'],
    winner_team_id: row.winner_team_id ? String(row.winner_team_id) : null,
    team_a_game_wins: Number(row.team_a_game_wins),
    team_b_game_wins: Number(row.team_b_game_wins),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * Records an individual match result within a Knockout BO3/BO5 series.
 * 
 * Invariants enforced:
 * 1. Tied KO game is replayed; tied game does NOT consume a numbered slot of its own.
 *    Replay result reuses the SAME game_number slot (FR-CALC-004, FR-CALC-005, D-028).
 * 2. Series score is games won, separate from goal scores (FR-CALC-003).
 * 3. No drawn series (BO3/BO5 ends strictly when a team reaches target wins: 2 for BO3, 3 for BO5).
 */
export async function recordSeriesGameResult(
  db: Client,
  input: RecordSeriesGameInput
): Promise<SeriesGameResultOutcome> {
  const series = await getSeries(db, input.series_id);
  if (!series) {
    throw new Error(`Series with id '${input.series_id}' not found`);
  }

  if (series.status === 'COMPLETED' && !input.allow_completed_series) {
    throw new Error('Series ini sudah selesai. Tidak dapat menambah atau memperbarui game.');
  }

  // Load parent fixture to identify team_a_id and team_b_id
  const fixtureResult = await db.execute({
    sql: 'SELECT id, team_a_id, team_b_id, status FROM fixtures WHERE id = ?',
    args: [series.fixture_id],
  });

  if (fixtureResult.rows.length === 0) {
    throw new Error(`Fixture with id '${series.fixture_id}' not found`);
  }

  const fixtureRow = fixtureResult.rows[0] as unknown as Record<string, unknown>;
  const teamAId = String(fixtureRow.team_a_id);
  const teamBId = String(fixtureRow.team_b_id);

  const now: ISODateString = new Date().toISOString();
  const isTied = input.team_a_score === input.team_b_score;

  // Check if a game for this (fixture_id, game_number) already exists
  const existingGameResult = await db.execute({
    sql: 'SELECT * FROM games WHERE fixture_id = ? AND game_number = ?',
    args: [series.fixture_id, input.game_number],
  });

  const existingGameRow =
    existingGameResult.rows.length > 0
      ? (existingGameResult.rows[0] as unknown as Record<string, unknown>)
      : null;

  let gameId: UUID;

  if (isTied) {
    // -------------------------------------------------------------------------
    // TIED GAME CASE:
    // Game must be replayed. It does NOT award a win or advance series game wins.
    // It stays in slot `game_number` awaiting the decisive replay result.
    // -------------------------------------------------------------------------
    if (existingGameRow) {
      gameId = String(existingGameRow.id);
      await db.execute({
        sql: `
          UPDATE games
          SET team_a_score = ?, team_b_score = ?, winner_team_id = NULL,
              is_draw = 1, status = 'REPORT_PENDING', updated_at = ?
          WHERE id = ?
        `,
        args: [input.team_a_score, input.team_b_score, now, gameId],
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
          series.fixture_id,
          series.id,
          input.game_number,
          'REPORT_PENDING',
          input.team_a_score,
          input.team_b_score,
          null,
          1,
          0,
          'NONE',
          input.evidence_status || 'RECEIVED',
          now,
          now,
        ],
      });
    }

    const tiedGame: Game = {
      id: gameId,
      fixture_id: series.fixture_id,
      series_id: series.id,
      game_number: input.game_number,
      status: 'REPORT_PENDING',
      team_a_score: input.team_a_score,
      team_b_score: input.team_b_score,
      winner_team_id: null,
      is_draw: 1,
      is_walkover: 0,
      walkover_type: 'NONE',
      evidence_status: input.evidence_status || 'RECEIVED',
      created_at: existingGameRow ? String(existingGameRow.created_at) : now,
      updated_at: now,
    };

    return {
      series,
      game: tiedGame,
      is_tied_game: true,
      is_replay_required: true,
      is_series_complete: false,
      winner_team_id: null,
      next_game_number: input.game_number, // Replay reuses the same game_number slot
      message: `Pertandingan game ke-${input.game_number} seri (${input.team_a_score} - ${input.team_b_score}). Wajib di-replay pada slot game ke-${input.game_number} (D-028, FR-CALC-005).`,
    };
  }

  // ---------------------------------------------------------------------------
  // DECISIVE GAME CASE (or decisive replay):
  // Winner is determined, slot game_number holds decisive result, series score advances.
  // ---------------------------------------------------------------------------
  const gameWinnerId = input.team_a_score > input.team_b_score ? teamAId : teamBId;

  // Determine if this game slot had already been counted toward series wins
  let newTeamAWins = series.team_a_game_wins;
  let newTeamBWins = series.team_b_game_wins;

  const previousWinner = existingGameRow && existingGameRow.winner_team_id ? String(existingGameRow.winner_team_id) : null;

  if (previousWinner) {
    // If it was previously counted for another team, decrement previous winner
    if (previousWinner === teamAId) newTeamAWins = Math.max(0, newTeamAWins - 1);
    if (previousWinner === teamBId) newTeamBWins = Math.max(0, newTeamBWins - 1);
  }

  if (gameWinnerId === teamAId) {
    newTeamAWins += 1;
  } else {
    newTeamBWins += 1;
  }

  const progress = evaluateSeriesProgress(series.format, newTeamAWins, newTeamBWins);
  const isSeriesComplete = progress.is_complete;
  const seriesWinnerTeamId = progress.winner === 'TEAM_A' ? teamAId : (progress.winner === 'TEAM_B' ? teamBId : null);
  const newSeriesStatus: Series['status'] = isSeriesComplete ? 'COMPLETED' : 'IN_PROGRESS';

  // Upsert game record with decisive result
  if (existingGameRow) {
    gameId = String(existingGameRow.id);
    await db.execute({
      sql: `
        UPDATE games
        SET team_a_score = ?, team_b_score = ?, winner_team_id = ?,
            is_draw = 0, status = 'COMPLETED', updated_at = ?
        WHERE id = ?
      `,
      args: [input.team_a_score, input.team_b_score, gameWinnerId, now, gameId],
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
        series.fixture_id,
        series.id,
        input.game_number,
        'COMPLETED',
        input.team_a_score,
        input.team_b_score,
        gameWinnerId,
        0,
        0,
        'NONE',
        input.evidence_status || 'VERIFIED',
        now,
        now,
      ],
    });
  }

  // Update series record in DB
  await db.execute({
    sql: `
      UPDATE series
      SET team_a_game_wins = ?, team_b_game_wins = ?,
          status = ?, winner_team_id = ?, updated_at = ?
      WHERE id = ?
    `,
    args: [
      newTeamAWins,
      newTeamBWins,
      newSeriesStatus,
      seriesWinnerTeamId,
      now,
      series.id,
    ],
  });

  // If series is complete, also mark fixture COMPLETED
  if (isSeriesComplete) {
    await db.execute({
      sql: 'UPDATE fixtures SET status = ?, updated_at = ? WHERE id = ?',
      args: ['COMPLETED', now, series.fixture_id],
    });
  } else {
    await db.execute({
      sql: 'UPDATE fixtures SET status = ?, updated_at = ? WHERE id = ?',
      args: ['IN_PROGRESS', now, series.fixture_id],
    });
  }

  const updatedSeries: Series = {
    ...series,
    team_a_game_wins: newTeamAWins,
    team_b_game_wins: newTeamBWins,
    status: newSeriesStatus,
    winner_team_id: seriesWinnerTeamId,
    updated_at: now,
  };

  const completedGame: Game = {
    id: gameId,
    fixture_id: series.fixture_id,
    series_id: series.id,
    game_number: input.game_number,
    status: 'COMPLETED',
    team_a_score: input.team_a_score,
    team_b_score: input.team_b_score,
    winner_team_id: gameWinnerId,
    is_draw: 0,
    is_walkover: 0,
    walkover_type: 'NONE',
    evidence_status: input.evidence_status || 'VERIFIED',
    created_at: existingGameRow ? String(existingGameRow.created_at) : now,
    updated_at: now,
  };

  const nextGameNumber = isSeriesComplete ? null : input.game_number + 1;

  return {
    series: updatedSeries,
    game: completedGame,
    is_tied_game: false,
    is_replay_required: false,
    is_series_complete: isSeriesComplete,
    winner_team_id: seriesWinnerTeamId,
    next_game_number: nextGameNumber,
    message: isSeriesComplete
      ? `Series selesai (${newTeamAWins} - ${newTeamBWins}). Pemenang: ${seriesWinnerTeamId}.`
      : `Game ke-${input.game_number} tercatat. Skor series saat ini: ${newTeamAWins} - ${newTeamBWins}. Lanjut ke game ke-${nextGameNumber}.`,
  };
}
