/**
 * Flash Peak TMS - Backend Report Validation Engine (Task 5.2)
 * 
 * Deterministic business validation layer (AI_PIPELINE.md §6, ARCHITECTURE.md §8).
 * Never trusts LLM totals — recomputes and validates all sums in authoritative backend code.
 * 
 * Validations enforced:
 * 1. Lineup count: Exactly 5 active players per side (1 GOALKEEPER, 4 OUTFIELD).
 * 2. Roster membership: Every player must be a registered member of that team in `players` table.
 * 3. Duplicate player detection: No player may appear more than once in a lineup or on both sides.
 * 4. Numeric validity: Scores, goals, assists, passes, defense, saves >= 0; ratings non-negative.
 * 5. Score consistency: Recalculated sum of player goals must match team score.
 * 6. Fixture context: Teams and game must strictly match fixture records.
 * 7. Goalkeeper saves mapping: Map summary DEFENSE to goalkeeper_saves for confirmed keepers (FR-GK-003).
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { distance } from 'fastest-levenshtein';
import type {
  ValidatedMatchData,
  Player,
  UUID,
} from '../shared/types/index.js';

export interface RawPlayerMatchStat {
  player_id?: UUID;
  nickname_raw: string;
  rating?: number | null;
  goals?: number | null;
  assists?: number | null;
  passes?: number | null;
  defense_raw?: number | null;
  goalkeeper_saves?: number | null;
}

export interface MatchValidationInput {
  fixture_id: UUID;
  game_id: UUID;
  team_a_id: UUID;
  team_b_id: UUID;
  team_a_score: number;
  team_b_score: number;
  team_a_players: RawPlayerMatchStat[];
  team_b_players: RawPlayerMatchStat[];
  allow_unassigned_goals?: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  validatedData?: ValidatedMatchData;
  recalculatedScoreA: number;
  recalculatedScoreB: number;
}

/**
 * Normalizes a nickname for lookup comparison (NFC + trimmed + lowercased).
 */
export function normalizeNickname(nick: string): string {
  return nick.normalize('NFC').trim().toLowerCase();
}

/**
 * Strips non-alphanumeric characters for clean search key matching.
 * Also handles NFKD normalization for combining marks/diacritics.
 */
export function cleanSearchKey(nick: string): string {
  return nick
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Computes Levenshtein similarity between 0.0 and 1.0.
 */
export function computeSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1.0;
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1.0;
  const dist = distance(str1, str2);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Tiered Player-to-Roster Matcher (Zero False Positives & OCR Resilient)
 * - Tier 1: Exact raw string match.
 * - Tier 2: NFC normalized match.
 * - Tier 3: Clean alphanumeric key match (ignores clan tags, bullets, decorative symbols, and spacing).
 * - Tier 4: Safe fuzzy match (threshold >= 0.75 + safety gap >= 0.15 over runner-up teammate).
 */
export function matchPlayerToRoster(
  raw: RawPlayerMatchStat,
  roster: Player[]
): Player | null {
  if (raw.player_id) {
    const matchById = roster.find((p) => p.id === raw.player_id);
    if (matchById) return matchById;
  }

  const norm = normalizeNickname(raw.nickname_raw);

  // 1. Exact raw match
  const exact = roster.find((p) => p.nickname_raw === raw.nickname_raw);
  if (exact) return exact;

  // 2. NFC normalized match
  const nfcMatch = roster.find((p) => normalizeNickname(p.nickname_nfc) === norm);
  if (nfcMatch) return nfcMatch;

  // 3. Clean Alphanumeric Key match (ignores decorative symbols, bullets, spaces, clan tags)
  const cleanRaw = cleanSearchKey(raw.nickname_raw);
  if (cleanRaw.length >= 3) {
    const cleanMatch = roster.find(
      (p) =>
        cleanSearchKey(p.nickname_raw) === cleanRaw ||
        (p.nickname_search_key && p.nickname_search_key.toLowerCase() === cleanRaw)
    );
    if (cleanMatch) return cleanMatch;
  }

  // 4. Safe Fuzzy Match (safety threshold >= 0.75 + safety margin gap >= 0.15)
  // Ensures minor OCR typos (e.g. 1 char substitution) resolve safely without ever
  // confusing distinct teammates (such as Kuroko vs Kurona).
  if (cleanRaw.length >= 3 && roster.length > 0) {
    const scored = roster
      .map((p) => {
        const pClean = cleanSearchKey(p.nickname_raw);
        const score =
          pClean.length >= 3
            ? computeSimilarity(cleanRaw, pClean)
            : computeSimilarity(norm, normalizeNickname(p.nickname_raw));
        return { player: p, score };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const runnerUpScore = scored.length > 1 ? scored[1].score : 0;
    const gap = best.score - runnerUpScore;

    if (best.score >= 0.75 && gap >= 0.15) {
      return best.player;
    }
  }

  return null;
}

/**
 * Resolves or registers an unregistered player as INELIGIBLE.
 * Used when a losing team fields an unregistered player: their stats are recorded
 * with status = 'INELIGIBLE' (is_award_eligible = 0) so the winning team's goal
 * difference and victory are preserved without corrupting individual awards.
 */
export async function resolveOrRegisterIneligiblePlayer(
  db: Client,
  tournamentId: string,
  teamId: string,
  nicknameRaw: string,
  position: 'GOALKEEPER' | 'OUTFIELD'
): Promise<Player> {
  const normNfc = normalizeNickname(nicknameRaw);
  const cleanKey = cleanSearchKey(nicknameRaw);

  // 1. Check if player already exists in tournament
  const existing = await db.execute({
    sql: `
      SELECT id, tournament_id, team_id, nickname_raw, nickname_nfc,
             nickname_search_key, position, roster_slot, roster_type, status
      FROM players
      WHERE tournament_id = ? AND (nickname_raw = ? OR nickname_nfc = ?)
      LIMIT 1
    `,
    args: [tournamentId, nicknameRaw, normNfc],
  });

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return {
      id: String(row[0]),
      tournament_id: String(row[1]),
      team_id: String(row[2]),
      nickname_raw: String(row[3]),
      nickname_nfc: String(row[4]),
      nickname_search_key: String(row[5]),
      position: String(row[6]) as Player['position'],
      roster_slot: Number(row[7]),
      roster_type: String(row[8]) as Player['roster_type'],
      status: String(row[9]) as Player['status'],
      created_at: '',
      updated_at: '',
    };
  }

  // 2. Find first free roster slot 1..10
  const slotsRes = await db.execute({
    sql: `SELECT roster_slot FROM players WHERE team_id = ?`,
    args: [teamId],
  });
  const occupiedSlots = new Set(slotsRes.rows.map((r) => Number(r[0])));
  let targetSlot = 1;
  while (occupiedSlots.has(targetSlot) && targetSlot <= 10) {
    targetSlot++;
  }
  if (targetSlot > 10) {
    targetSlot = 10;
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  await db.execute({
    sql: `
      INSERT INTO players (
        id, tournament_id, team_id, nickname_raw, nickname_nfc,
        nickname_search_key, position, roster_slot, roster_type,
        status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUBSTITUTE', 'INELIGIBLE', ?, ?)
    `,
    args: [
      id,
      tournamentId,
      teamId,
      nicknameRaw,
      normNfc,
      cleanKey,
      position,
      targetSlot,
      now,
      now,
    ],
  });

  return {
    id,
    tournament_id: tournamentId,
    team_id: teamId,
    nickname_raw: nicknameRaw,
    nickname_nfc: normNfc,
    nickname_search_key: cleanKey,
    position,
    roster_slot: targetSlot,
    roster_type: 'SUBSTITUTE',
    status: 'INELIGIBLE',
    created_at: now,
    updated_at: now,
  };
}

/**
 * Deterministically validates a match report against database records and game rules.
 */
export async function validateMatchReport(
  db: Client,
  input: MatchValidationInput
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Fixture & Game Context Checks
  const fixtureResult = await db.execute({
    sql: 'SELECT id, tournament_id, team_a_id, team_b_id, status FROM fixtures WHERE id = ?',
    args: [input.fixture_id],
  });

  if (fixtureResult.rows.length === 0) {
    errors.push(`Fixture not found: ${input.fixture_id}`);
    return {
      isValid: false,
      errors,
      warnings,
      recalculatedScoreA: 0,
      recalculatedScoreB: 0,
    };
  }

  const fixtureRow = fixtureResult.rows[0];
  const tournamentId = String(fixtureRow[1]);
  const fixtureTeamAId = String(fixtureRow[2]);
  const fixtureTeamBId = String(fixtureRow[3]);

  if (input.team_a_id !== fixtureTeamAId || input.team_b_id !== fixtureTeamBId) {
    // If swapped, report clear error
    if (input.team_a_id === fixtureTeamBId && input.team_b_id === fixtureTeamAId) {
      errors.push(
        `Team sides are inverted compared to fixture: Team A expected ${fixtureTeamAId}, got ${input.team_a_id}`
      );
    } else {
      errors.push(
        `Teams in report (${input.team_a_id}, ${input.team_b_id}) do not match fixture teams (${fixtureTeamAId}, ${fixtureTeamBId})`
      );
    }
  }

  const gameResult = await db.execute({
    sql: 'SELECT id, fixture_id, status FROM games WHERE id = ?',
    args: [input.game_id],
  });

  if (gameResult.rows.length === 0) {
    errors.push(`Game not found: ${input.game_id}`);
  } else if (String(gameResult.rows[0][1]) !== input.fixture_id) {
    errors.push(`Game ${input.game_id} does not belong to fixture ${input.fixture_id}`);
  }

  // 2. Score Range Checks
  if (input.team_a_score < 0 || !Number.isInteger(input.team_a_score)) {
    errors.push(`Team A score must be a non-negative integer (got ${input.team_a_score})`);
  }
  if (input.team_b_score < 0 || !Number.isInteger(input.team_b_score)) {
    errors.push(`Team B score must be a non-negative integer (got ${input.team_b_score})`);
  }

  const isTeamAWinner = input.team_a_score > input.team_b_score;
  const isTeamBWinner = input.team_b_score > input.team_a_score;
  const isDraw = input.team_a_score === input.team_b_score;

  // 3. Player Counts per Side (Exactly 5 active players per side in lineup)
  if (input.team_a_players.length !== 5) {
    errors.push(
      `Team A must have exactly 5 players in the lineup (1 GK, 4 outfield), got ${input.team_a_players.length}`
    );
  }
  if (input.team_b_players.length !== 5) {
    errors.push(
      `Team B must have exactly 5 players in the lineup (1 GK, 4 outfield), got ${input.team_b_players.length}`
    );
  }

  // 4. Fetch registered rosters from DB
  const rosterResult = await db.execute({
    sql: `
      SELECT id, tournament_id, team_id, nickname_raw, nickname_nfc,
             nickname_search_key, position, roster_slot, roster_type, status
      FROM players
      WHERE team_id IN (?, ?) AND status = 'ACTIVE'
    `,
    args: [input.team_a_id, input.team_b_id],
  });

  const registeredPlayers: Player[] = rosterResult.rows.map((row) => ({
    id: String(row[0]),
    tournament_id: String(row[1]),
    team_id: String(row[2]),
    nickname_raw: String(row[3]),
    nickname_nfc: String(row[4]),
    nickname_search_key: String(row[5]),
    position: String(row[6]) as Player['position'],
    roster_slot: Number(row[7]),
    roster_type: String(row[8]) as Player['roster_type'],
    status: String(row[9]) as Player['status'],
    created_at: '',
    updated_at: '',
  }));

  const rosterA = registeredPlayers.filter((p) => p.team_id === input.team_a_id);
  const rosterB = registeredPlayers.filter((p) => p.team_id === input.team_b_id);

  // Helper to match a raw player to registered player using tiered matching
  function matchPlayer(raw: RawPlayerMatchStat, roster: Player[]): Player | null {
    return matchPlayerToRoster(raw, roster);
  }

  // 5. Validate Team A Lineup
  const resolvedTeamAPlayers: ValidatedMatchData['team_a_players'] = [];
  const seenPlayerIdsA = new Set<string>();
  let teamAGkCount = 0;
  let teamAOutfieldCount = 0;
  let sumGoalsA = 0;

  for (let idx = 0; idx < input.team_a_players.length; idx++) {
    const p = input.team_a_players[idx];
    let registered = matchPlayer(p, rosterA);

    if (!registered) {
      if (isTeamBWinner) {
        // Team A lost the match. Sesuai regulasi (Rule 2.12):
        // Skor asli tetap disahkan demi keadilan tim pemenang (Team B).
        // Pemain tidak terdaftar ini dicatat sebagai INELIGIBLE dan tim mendapatkan peringatan resmi.
        warnings.push(
          `⚠️ Peringatan Pelanggaran Roster: Pemain #${idx + 1} "${p.nickname_raw}" tidak terdaftar di roster aktif Tim A. Karena Tim A kalah (${input.team_a_score} - ${input.team_b_score}), skor asli tetap berlaku demi keadilan tim pemenang, namun pemain ini berstatus INELIGIBLE (tidak berhak atas penghargaan individu).`
        );
        registered = await resolveOrRegisterIneligiblePlayer(
          db,
          tournamentId,
          input.team_a_id,
          p.nickname_raw,
          p.goalkeeper_saves !== null && p.goalkeeper_saves !== undefined ? 'GOALKEEPER' : 'OUTFIELD'
        );
      } else {
        // Team A won or drew with an unregistered player: FATAL VIOLATION
        errors.push(
          `🚨 Pelanggaran Roster Berat: Tim A memainkan pemain tidak terdaftar (not a registered active player: "${p.nickname_raw}") saat memenangkan/menahan imbang pertandingan (${input.team_a_score} - ${input.team_b_score}). Sesuai regulasi, kemenangan/hasil seri dibatalkan dan wajib diproses sebagai Walkover (WO 0-3) untuk Tim B dengan persetujuan 2 pihak.`
        );
      }
    }

    if (registered) {
      if (seenPlayerIdsA.has(registered.id)) {
        errors.push(`Duplicate player detected in Team A lineup: "${registered.nickname_raw}"`);
      }
      seenPlayerIdsA.add(registered.id);

      if (registered.position === 'GOALKEEPER') {
        teamAGkCount++;
      } else {
        teamAOutfieldCount++;
      }
    }

    // Validate numeric stats
    const goals = p.goals ?? 0;
    const assists = p.assists ?? 0;
    const passes = p.passes ?? 0;
    const defenseRaw = p.defense_raw ?? 0;
    let saves = p.goalkeeper_saves ?? null;

    if (goals < 0 || !Number.isInteger(goals)) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid goals: ${goals}`);
    }
    if (assists < 0 || !Number.isInteger(assists)) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid assists: ${assists}`);
    }
    if (passes < 0 || !Number.isInteger(passes)) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid passes: ${passes}`);
    }
    if (defenseRaw < 0 || !Number.isInteger(defenseRaw)) {
      errors.push(`Team A player "${p.nickname_raw}" has invalid defense: ${defenseRaw}`);
    }
    let normalizedRating = p.rating ?? null;
    if (normalizedRating !== null && normalizedRating !== undefined) {
      if (normalizedRating > 10.0 && normalizedRating <= 100.0) {
        normalizedRating = Number((normalizedRating / 10).toFixed(1));
      }
      if (normalizedRating < 0 || normalizedRating > 10.0 || isNaN(normalizedRating)) {
        errors.push(`Team A player "${p.nickname_raw}" has invalid rating: ${p.rating}`);
      }
    }

    // Map goalkeeper DEFENSE to saves if registered as GK and saves not explicitly specified
    if (registered && registered.position === 'GOALKEEPER') {
      if (saves === null) {
        saves = defenseRaw; // FR-GK-003: map summary DEFENSE to goalkeeper_saves
      }
    } else {
      // Outfield player saves should be null
      saves = null;
    }

    sumGoalsA += Math.max(0, goals);

    resolvedTeamAPlayers.push({
      player_id: registered ? registered.id : (p.player_id || ''),
      nickname_raw: p.nickname_raw,
      rating: normalizedRating,
      goals: Math.max(0, goals),
      assists: Math.max(0, assists),
      passes: Math.max(0, passes),
      defense_raw: Math.max(0, defenseRaw),
      goalkeeper_saves: saves,
    });
  }

  // 6. Validate Team B Lineup
  const resolvedTeamBPlayers: ValidatedMatchData['team_b_players'] = [];
  const seenPlayerIdsB = new Set<string>();
  let teamBGkCount = 0;
  let teamBOutfieldCount = 0;
  let sumGoalsB = 0;

  for (let idx = 0; idx < input.team_b_players.length; idx++) {
    const p = input.team_b_players[idx];
    let registered = matchPlayer(p, rosterB);

    if (!registered) {
      if (isTeamAWinner) {
        // Team B lost the match. Sesuai regulasi (Rule 2.12):
        // Skor asli tetap disahkan demi keadilan tim pemenang (Team A).
        // Pemain tidak terdaftar ini dicatat sebagai INELIGIBLE dan tim mendapatkan peringatan resmi.
        warnings.push(
          `⚠️ Peringatan Pelanggaran Roster: Pemain #${idx + 1} "${p.nickname_raw}" tidak terdaftar di roster aktif Tim B. Karena Tim B kalah (${input.team_b_score} - ${input.team_a_score}), skor asli tetap berlaku demi keadilan tim pemenang, namun pemain ini berstatus INELIGIBLE (tidak berhak atas penghargaan individu).`
        );
        registered = await resolveOrRegisterIneligiblePlayer(
          db,
          tournamentId,
          input.team_b_id,
          p.nickname_raw,
          p.goalkeeper_saves !== null && p.goalkeeper_saves !== undefined ? 'GOALKEEPER' : 'OUTFIELD'
        );
      } else {
        // Team B won or drew with an unregistered player: FATAL VIOLATION
        errors.push(
          `🚨 Pelanggaran Roster Berat: Tim B memainkan pemain tidak terdaftar (not a registered active player: "${p.nickname_raw}") saat memenangkan/menahan imbang pertandingan (${input.team_b_score} - ${input.team_a_score}). Sesuai regulasi, kemenangan/hasil seri dibatalkan dan wajib diproses sebagai Walkover (WO 3-0) untuk Tim A dengan persetujuan 2 pihak.`
        );
      }
    }

    if (registered) {
      if (seenPlayerIdsB.has(registered.id)) {
        errors.push(`Duplicate player detected in Team B lineup: "${registered.nickname_raw}"`);
      }
      seenPlayerIdsB.add(registered.id);

      // Cross-team check
      if (seenPlayerIdsA.has(registered.id)) {
        errors.push(
          `Player "${registered.nickname_raw}" appears on BOTH Team A and Team B in the same match`
        );
      }

      if (registered.position === 'GOALKEEPER') {
        teamBGkCount++;
      } else {
        teamBOutfieldCount++;
      }
    }

    // Validate numeric stats
    const goals = p.goals ?? 0;
    const assists = p.assists ?? 0;
    const passes = p.passes ?? 0;
    const defenseRaw = p.defense_raw ?? 0;
    let saves = p.goalkeeper_saves ?? null;

    if (goals < 0 || !Number.isInteger(goals)) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid goals: ${goals}`);
    }
    if (assists < 0 || !Number.isInteger(assists)) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid assists: ${assists}`);
    }
    if (passes < 0 || !Number.isInteger(passes)) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid passes: ${passes}`);
    }
    if (defenseRaw < 0 || !Number.isInteger(defenseRaw)) {
      errors.push(`Team B player "${p.nickname_raw}" has invalid defense: ${defenseRaw}`);
    }
    let normalizedRating = p.rating ?? null;
    if (normalizedRating !== null && normalizedRating !== undefined) {
      if (normalizedRating > 10.0 && normalizedRating <= 100.0) {
        normalizedRating = Number((normalizedRating / 10).toFixed(1));
      }
      if (normalizedRating < 0 || normalizedRating > 10.0 || isNaN(normalizedRating)) {
        errors.push(`Team B player "${p.nickname_raw}" has invalid rating: ${p.rating}`);
      }
    }

    // Map goalkeeper DEFENSE to saves if registered as GK
    if (registered && registered.position === 'GOALKEEPER') {
      if (saves === null) {
        saves = defenseRaw; // FR-GK-003
      }
    } else {
      saves = null;
    }

    sumGoalsB += Math.max(0, goals);

    resolvedTeamBPlayers.push({
      player_id: registered ? registered.id : (p.player_id || ''),
      nickname_raw: p.nickname_raw,
      rating: normalizedRating,
      goals: Math.max(0, goals),
      assists: Math.max(0, assists),
      passes: Math.max(0, passes),
      defense_raw: Math.max(0, defenseRaw),
      goalkeeper_saves: saves,
    });
  }

  // 7. Check 1 GK + 4 Outfield composition (when all 5 players are registered)
  if (input.team_a_players.length === 5 && seenPlayerIdsA.size === 5) {
    if (teamAGkCount !== 1 || teamAOutfieldCount !== 4) {
      errors.push(
        `Team A lineup must contain exactly 1 GOALKEEPER and 4 OUTFIELD players (got ${teamAGkCount} GK, ${teamAOutfieldCount} outfield)`
      );
    }
  }

  if (input.team_b_players.length === 5 && seenPlayerIdsB.size === 5) {
    if (teamBGkCount !== 1 || teamBOutfieldCount !== 4) {
      errors.push(
        `Team B lineup must contain exactly 1 GOALKEEPER and 4 OUTFIELD players (got ${teamBGkCount} GK, ${teamBOutfieldCount} outfield)`
      );
    }
  }

  // 8. Recompute & Validate Score Consistency (ARCHITECTURE.md §8)
  // Backend recomputes individual goal sums and compares to team score
  if (input.team_a_score !== sumGoalsA) {
    if (input.allow_unassigned_goals) {
      warnings.push(
        `Skor tim A adalah ${input.team_a_score}, tetapi jumlah gol pemain baru ${sumGoalsA} (${input.team_a_score - sumGoalsA} gol belum ditugaskan/unassigned)`
      );
    } else {
      errors.push(
        `Score inconsistency for Team A: team score is ${input.team_a_score}, but sum of individual player goals is ${sumGoalsA}`
      );
    }
  }

  if (input.team_b_score !== sumGoalsB) {
    if (input.allow_unassigned_goals) {
      warnings.push(
        `Skor tim B adalah ${input.team_b_score}, tetapi jumlah gol pemain baru ${sumGoalsB} (${input.team_b_score - sumGoalsB} gol belum ditugaskan/unassigned)`
      );
    } else {
      errors.push(
        `Score inconsistency for Team B: team score is ${input.team_b_score}, but sum of individual player goals is ${sumGoalsB}`
      );
    }
  }

  const isValid = errors.length === 0;

  const validatedData: ValidatedMatchData | undefined = isValid
    ? {
        fixture_id: input.fixture_id,
        game_id: input.game_id,
        team_a_id: input.team_a_id,
        team_b_id: input.team_b_id,
        team_a_score: input.team_a_score,
        team_b_score: input.team_b_score,
        team_a_players: resolvedTeamAPlayers,
        team_b_players: resolvedTeamBPlayers,
      }
    : undefined;

  return {
    isValid,
    errors,
    warnings,
    validatedData,
    recalculatedScoreA: sumGoalsA,
    recalculatedScoreB: sumGoalsB,
  };
}
