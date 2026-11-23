/**
 * Flash Peak TMS - Interactive Knockout Evidence Pipeline (per-game)
 *
 * Replaces the BO1-reuse approach of the first FIX2-KO-001 revision: a BO3/BO5
 * series is structurally "one series = N games", so evidence flows per game.
 *
 * Flow:
 *   Delegate of one of the two teams sends a match-result screenshot for the
 *   series (caption "!kogame ..." or plain photo in the series context) ->
 *   classify -> extract score -> record into games/series via
 *   recordSeriesGameResult -> reply per-game (result + running series score +
 *   "next game needed" / "series complete").
 *
 * Robustness principles (see worklog for the design rationale):
 *   1. The game number is NEVER trusted from user input. It is derived from
 *      persisted state: the first slot that has no decisive result yet. This
 *      single rule makes out-of-order, reversed, and batch-submitted photos
 *      converge to the correct series state.
 *   2. A photo for a game whose series-relevant outcome is already recorded
 *      with the SAME score is idempotent (no double count). Duplicate
 *      detection is SLOT-SCOPED only: a photo is a duplicate of a decided
 *      game if and only if the open-slot derivation points at that slot AND
 *      the score matches. A photo whose score pair happens to EQUAL a
 *      decided game's pair is a legitimate new game (score pairs are not
 *      unique identifiers — e.g. a BO3 can legitimately have two 2-0 games).
 *   3. Because the slot derivation never re-targets a decided slot, a
 *      same-slot conflicting score can only occur on the tied-pending-replay
 *      slot (handled by the replay path) — there is no cross-slot conflict
 *      detection by design. Genuine result disputes go through the organizer
 *      correction path (!kores can re-record any game, even after COMPLETED).
 *   4. Photos arriving after the series completed are journaled IGNORED with
 *      an explicit message (never recorded as official results).
 *   5. Best-of-N generic: target wins come from the series row; nothing is
 *      hardcoded for BO3 vs BO5.
 *   6. Slot derivation + duplicate check + apply all run inside ONE write
 *      transaction, so two photos arriving concurrently cannot both derive
 *      the same open slot (the second writer sees the first one's committed
 *      games row when the transaction begins).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import {
  recordSeriesGameResult,
  getSeriesByFixture,
  evaluateSeriesProgress,
  type SeriesGameResultOutcome,
} from '../competition/series.js';

export interface KoEvidenceInput {
  fixtureId: string;
  /** Extracted score, already oriented as team_a vs team_b of the fixture. */
  teamAScore: number;
  teamBScore: number;
  submittedByDelegateId: string | null;
  mediaAssetId?: string | null;
  sourceMessageId?: string | null;
  extractionJson?: string | null;
}

export interface KoEvidenceOutcome {
  status:
    | 'GAME_APPLIED'        // result recorded, series continues
    | 'SERIES_COMPLETE'     // result recorded, series ended
    | 'SERIES_ALREADY_COMPLETE' // photo arrived after series end -> ignored
    | 'DUPLICATE';          // same slot, same score already recorded (idempotent resend)
  gameNumber: number;
  seriesScore: { team_a: number; team_b: number };
  seriesFormat: 'BO3' | 'BO5';
  targetWins: number;
  winnerTeamId: string | null;
  nextGameNumber: number | null;
  evidenceId: string;
  message: string;
  seriesOutcome?: SeriesGameResultOutcome;
}

/**
 * Derives the slot this photo should fill: the first game slot of the series
 * that has no decisive (non-tied, non-replay-pending) result yet.
 *
 * Tied games stay in their slot awaiting a decisive replay (D-028), so a tied
 * slot is still "open" and will be filled by the next decisive photo — which
 * is exactly how the interactive replay flow is meant to work.
 */
export async function deriveOpenGameSlot(
  db: Client,
  fixtureId: string
): Promise<{ gameNumber: number; isTiedPendingReplay: boolean } | null> {
  const series = await getSeriesByFixture(db, fixtureId);
  if (!series) return null;

  const gamesRes = await db.execute({
    sql: `SELECT game_number, winner_team_id, is_draw FROM games
          WHERE fixture_id = ? AND series_id IS NOT NULL
          ORDER BY game_number ASC`,
    args: [fixtureId],
  });

  const decided = new Set<number>();
  let tiedPending = 0;
  for (const row of gamesRes.rows as unknown as Array<Record<string, unknown>>) {
    const gameNumber = Number(row.game_number);
    const winner = row.winner_team_id ? String(row.winner_team_id) : null;
    const isDraw = Number(row.is_draw) === 1;
    if (winner) {
      decided.add(gameNumber);
    } else if (isDraw) {
      // tied game: slot stays open for the replay; only ONE tied slot is ever
      // open because a decisive photo consumes it before another is derived
      tiedPending = gameNumber;
    }
  }

  if (tiedPending > 0) {
    return { gameNumber: tiedPending, isTiedPendingReplay: true };
  }

  // First slot with no decisive result
  for (let n = 1; n <= 32; n++) {
    if (!decided.has(n)) {
      return { gameNumber: n, isTiedPendingReplay: false };
    }
  }
  return null;
}

/**
 * Fetches series + fixture context for the pipeline.
 */
export async function getKoSeriesContext(
  db: Client,
  fixtureId: string
): Promise<{
  seriesId: string;
  fixtureId: string;
  tournamentId: string;
  teamAId: string;
  teamBId: string;
  teamAName: string;
  teamBName: string;
  roundCode: string;
  format: 'BO3' | 'BO5';
  targetWins: number;
  status: string;
  gameWinsA: number;
  gameWinsB: number;
  seriesWinnerTeamId: string | null;
} | null> {
  const res = await db.execute({
    sql: `SELECT s.id AS series_id, s.format, s.target_wins, s.status,
                 s.team_a_game_wins, s.team_b_game_wins, s.winner_team_id,
                 f.id AS fixture_id, f.tournament_id, f.round_code,
                 f.team_a_id, f.team_b_id,
                 ta.team_name AS team_a_name, tb.team_name AS team_b_name
          FROM series s
          JOIN fixtures f ON s.fixture_id = f.id
          JOIN teams ta ON f.team_a_id = ta.id
          JOIN teams tb ON f.team_b_id = tb.id
          WHERE s.fixture_id = ?`,
    args: [fixtureId],
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as unknown as Record<string, unknown>;
  return {
    seriesId: String(r.series_id),
    fixtureId: String(r.fixture_id),
    tournamentId: String(r.tournament_id),
    teamAId: String(r.team_a_id),
    teamBId: String(r.team_b_id),
    teamAName: String(r.team_a_name),
    teamBName: String(r.team_b_name),
    roundCode: String(r.round_code || ''),
    format: (String(r.format) as 'BO3' | 'BO5'),
    targetWins: Number(r.target_wins),
    status: String(r.status),
    gameWinsA: Number(r.team_a_game_wins),
    gameWinsB: Number(r.team_b_game_wins),
    seriesWinnerTeamId: r.winner_team_id ? String(r.winner_team_id) : null,
  };
}

export type KoEvidenceJournalStatus =
  | 'APPLIED'      // extraction was recorded into games/series as the game result
  | 'SUPERSEDED'   // replaced by a newer photo for the same game (kept for audit)
  | 'IGNORED';     // not applied: series already complete when this photo arrived

async function journalEvidence(
  db: Client,
  input: KoEvidenceInput,
  seriesId: string,
  gameNumber: number,
  status: KoEvidenceJournalStatus,
  resolutionNote: string
): Promise<string> {
  const evidenceId = randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO ko_game_evidence (
            id, fixture_id, series_id, game_number, media_asset_id, source_message_id,
            submitted_by_delegate_id, extracted_team_a_score, extracted_team_b_score,
            extracted_winner_team_id, extraction_json, status, resolution_note,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      evidenceId,
      input.fixtureId,
      seriesId,
      gameNumber,
      input.mediaAssetId ?? null,
      input.sourceMessageId ?? null,
      input.submittedByDelegateId ?? null,
      input.teamAScore,
      input.teamBScore,
      input.teamAScore > input.teamBScore ? 'TEAM_A' : (input.teamBScore > input.teamAScore ? 'TEAM_B' : null),
      input.extractionJson ?? null,
      status,
      resolutionNote,
      now,
      now,
    ],
  });
  return evidenceId;
}

async function markSuperseded(
  db: Client,
  fixtureId: string,
  gameNumber: number,
  newEvidenceId: string
): Promise<void> {
  await db.execute({
    sql: `UPDATE ko_game_evidence
          SET status = 'SUPERSEDED', resolution_note = ?, updated_at = ?
          WHERE fixture_id = ? AND game_number = ? AND status = 'APPLIED' AND id != ?`,
    args: [
      `Superseded by evidence ${newEvidenceId}`,
      new Date().toISOString(),
      fixtureId,
      gameNumber,
      newEvidenceId,
    ],
  });
}

/**
 * Core state-machine step: applies one extracted game photo to its series.
 *
 * Pure domain function — receives the extracted score, decides which slot it
 * belongs to, applies it via recordSeriesGameResult, journals the evidence,
 * and returns a structured outcome for the WhatsApp reply.
 */
export async function applyKoGameEvidence(
  db: Client,
  input: KoEvidenceInput
): Promise<KoEvidenceOutcome> {
  const ctx = await getKoSeriesContext(db, input.fixtureId);
  if (!ctx) {
    throw new Error(
      `Series knockout untuk fixture '${input.fixtureId}' tidak ditemukan. Fase knockout belum dimulai (ketik !startknockout) atau fixture bukan pertandingan knockout.`
    );
  }

  const seriesScore = { team_a: ctx.gameWinsA, team_b: ctx.gameWinsB };

  // Guard 1: series already complete -> photo is too late, journal as IGNORED
  if (ctx.status === 'COMPLETED') {
    const evidenceId = await journalEvidence(
      db,
      input,
      ctx.seriesId,
      0,
      'IGNORED',
      `Series sudah selesai (${ctx.gameWinsA}-${ctx.gameWinsB}); foto tidak diproses sebagai hasil resmi.`
    );
    return {
      status: 'SERIES_ALREADY_COMPLETE',
      gameNumber: 0,
      seriesScore,
      seriesFormat: ctx.format,
      targetWins: ctx.targetWins,
      winnerTeamId: ctx.seriesWinnerTeamId,
      nextGameNumber: null,
      evidenceId,
      message: `ℹ️ Series ${ctx.teamAName} vs ${ctx.teamBName} sudah selesai (${ctx.gameWinsA}-${ctx.gameWinsB}). Foto ini diabaikan dan tidak dihitung sebagai hasil resmi.`,
    };
  }

  // Derive the slot for this photo (never trusts user-declared game numbers).
  //
  // AUDIT-VERIFY-T1/T7/T11 (21 Nov 2026): slot derivation, duplicate check and
  // apply now all run inside ONE write transaction, and the old cross-slot
  // "decided pair match" guard (former Guard 3) is REMOVED. Rationale:
  //  - A score pair is not a game identifier: a BO3 can legitimately have two
  //    2-0 games. Guard 3 wrongly rejected the second game as a duplicate,
  //    freezing the series at 1-0 (dry-run: game1 2-0 GAME_APPLIED, game2 2-0
  //    DUPLICATE, series stuck 1-0).
  //  - True duplicates are resends of the SAME slot's photo; because the
  //    derivation picks the first undecided slot, a resend lands on the NEXT
  //    open slot, not the original — but if the series is still in progress
  //    that is indistinguishable from a legitimate next-game photo, and after
  //    the series completes Guard 1 (IGNORED) catches all late resends.
  //    The only slot-scoped duplicate that CAN be detected is the
  //    tied-pending-replay slot with an identical tied score (Guard 2 below).
  //  - Running the derivation inside the write transaction serializes two
  //    concurrent photos: the second transaction sees the first one's
  //    committed games row and derives the following slot (audit-verify T7).
  let slot: Awaited<ReturnType<typeof deriveOpenGameSlot>>;
  let seriesOutcome: Awaited<ReturnType<typeof recordSeriesGameResult>>;
  let evidenceId: string;
  let newSeriesScore: { team_a: number; team_b: number };
  try {
    const tx = await db.transaction('write');
    try {
      slot = await deriveOpenGameSlot(tx as unknown as Client, input.fixtureId);
      if (!slot) {
        // No open slot outside the COMPLETED check above (e.g. all 32 slots
        // filled) — journal IGNORED and bail, still atomically.
        evidenceId = await journalEvidence(
          tx as unknown as Client,
          input,
          ctx.seriesId,
          0,
          'IGNORED',
          'Tidak ada slot game terbuka.'
        );
        await tx.commit();
        return {
          status: 'SERIES_ALREADY_COMPLETE',
          gameNumber: 0,
          seriesScore,
          seriesFormat: ctx.format,
          targetWins: ctx.targetWins,
          winnerTeamId: ctx.seriesWinnerTeamId,
          nextGameNumber: null,
          evidenceId,
          message: `ℹ️ Tidak ada slot game terbuka untuk series ini.`,
        };
      }
      const gameNumber = slot.gameNumber;

      // Guard 2 (slot-scoped duplicate): the derived slot only ever holds a
      // TIED pending-replay result (decisive slots are skipped by the
      // derivation). A decisive photo with the same tied score pair as the
      // pending one cannot happen (decisive != tied), but a tied photo with
      // the same pair is an idempotent replay resend.
      const existingRes = await (tx as unknown as Client).execute({
        sql: `SELECT team_a_score, team_b_score FROM games
              WHERE fixture_id = ? AND game_number = ? AND series_id IS NOT NULL`,
        args: [input.fixtureId, gameNumber],
      });
      if (existingRes.rows.length > 0) {
        const ex = existingRes.rows[0] as unknown as Record<string, unknown>;
        const exA = ex.team_a_score !== null && ex.team_a_score !== undefined ? Number(ex.team_a_score) : null;
        const exB = ex.team_b_score !== null && ex.team_b_score !== undefined ? Number(ex.team_b_score) : null;
        const sameScore = exA === input.teamAScore && exB === input.teamBScore;
        if (sameScore) {
          evidenceId = await journalEvidence(
            tx as unknown as Client,
            input,
            ctx.seriesId,
            gameNumber,
            'APPLIED',
            `Idempotent: hasil identik (${input.teamAScore}-${input.teamBScore}) sudah tercatat; tidak dihitung ulang.`
          );
          await tx.commit();
          return {
            status: 'DUPLICATE',
            gameNumber,
            seriesScore,
            seriesFormat: ctx.format,
            targetWins: ctx.targetWins,
            winnerTeamId: null,
            nextGameNumber: null,
            evidenceId,
            message: `ℹ️ Hasil game ke-${gameNumber} yang sama sudah tercatat (${input.teamAScore}-${input.teamBScore}). Tidak ada perubahan.`,
          };
        }
      }

      // Apply the extracted result to the derived slot via the domain engine.
      // recordSeriesGameResult handles: tied -> stays in slot (replay pending),
      // decisive -> upsert slot, recount series wins, complete series & fixture.
      //
      // FIX2-KO-005 (audit temuan 3.4 Medium): game result + evidence journal are
      // written inside ONE transaction. Previously the game was recorded first and
      // the journal second with no rollback — a journal failure (e.g. the FK bug in
      // temuan 3.1) left an official score with NO evidence row (half-written state)
      // and the delegate's retry was then treated as DUPLICATE. All-or-nothing now.
      seriesOutcome = await recordSeriesGameResult(tx as unknown as Client, {
        series_id: ctx.seriesId,
        game_number: gameNumber,
        team_a_score: input.teamAScore,
        team_b_score: input.teamBScore,
        evidence_status: 'VERIFIED',
      });

      evidenceId = await journalEvidence(
        tx as unknown as Client,
        input,
        ctx.seriesId,
        gameNumber,
        'APPLIED',
        seriesOutcome.is_series_complete
          ? `Game ${gameNumber} tercatat; series selesai.`
          : seriesOutcome.is_replay_required
            ? `Game ${gameNumber} seri; menunggu replay pada slot yang sama.`
            : `Game ${gameNumber} tercatat.`
      );
      await tx.commit();
    } catch (txErr) {
      if (!tx.closed) {
        try { await tx.rollback(); } catch { /* transaction already closed */ }
      }
      throw txErr;
    }
  } catch (err) {
    // Atomic failure: nothing was applied (games/series untouched, no journal row).
    throw new Error(
      `Gagal mencatat hasil game knockout secara atomik untuk fixture '${input.fixtureId}'. ` +
      'Tidak ada perubahan yang tersimpan — kirim ulang foto, atau minta Panitia mencatat via !kores. Detail: ' +
      String((err as Error)?.message || err)
    );
  }

  newSeriesScore = {
    team_a: seriesOutcome.series.team_a_game_wins,
    team_b: seriesOutcome.series.team_b_game_wins,
  };

  return {
    status: seriesOutcome.is_series_complete ? 'SERIES_COMPLETE' : 'GAME_APPLIED',
    gameNumber: slot.gameNumber,
    seriesScore: newSeriesScore,
    seriesFormat: ctx.format,
    targetWins: ctx.targetWins,
    winnerTeamId: seriesOutcome.winner_team_id,
    nextGameNumber: seriesOutcome.next_game_number,
    evidenceId,
    message: seriesOutcome.message,
    seriesOutcome,
  };
}

/**
 * Series progress snapshot used by formatters and the next-round generator.
 */
export async function getSeriesProgress(db: Client, fixtureId: string) {
  const ctx = await getKoSeriesContext(db, fixtureId);
  if (!ctx) return null;
  const progress = evaluateSeriesProgress(ctx.format, ctx.gameWinsA, ctx.gameWinsB);
  return {
    ...ctx,
    is_complete: progress.is_complete,
    nextNeededGame: progress.is_complete
      ? null
      : await deriveOpenGameSlot(db, fixtureId),
  };
}
