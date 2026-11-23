/**
 * Flash Peak TMS - Admin Manual Report Parser & Nickname Matcher
 * 
 * Provides robust WhatsApp chat input parsing and fuzzy nickname matching
 * for explicit goal scorers in manual reports (FR-FAIL-003, FR-FAIL-004).
 */

import { distance } from 'fastest-levenshtein';
import type { Player } from '../shared/types/index.js';
import type { RawPlayerMatchStat } from './validation.js';

export interface ScorerItem {
  name: string;
  goals: number;
}

export interface ParsedQuickReport {
  fixtureId: string;
  scoreA: number;
  scoreB: number;
  rawScorersA: ScorerItem[];
  rawScorersB: ScorerItem[];
  notes?: string;
  hasExplicitScorers: boolean;
}

export interface ScorerMatchResult {
  player: Player | null;
  similarity: number;
  error?: string;
}

/**
 * Parses individual scorer items from a string like:
 * "Bunny, Razorr" -> [{ name: "Bunny", goals: 1 }, { name: "Razorr", goals: 1 }]
 * "Bunny (2), Razorr" -> [{ name: "Bunny", goals: 2 }, { name: "Razorr", goals: 1 }]
 * "Bunny 2x, Razorr" -> [{ name: "Bunny", goals: 2 }, { name: "Razorr", goals: 1 }]
 */
export function parseScorerList(raw: string): ScorerItem[] {
  if (!raw.trim()) return [];

  // Split by comma, semicolon, or newline
  const tokens = raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const rawItems: ScorerItem[] = [];

  for (const token of tokens) {
    // Patterns like: "Name (2)", "Name x2", "Name 2x", "Name: 2", "Name 2"
    const matchCount = token.match(/^(.+?)\s*(?:\((\d+)\)|[xX](\d+)|(\d+)[xX]|:\s*(\d+))\s*$/);
    if (matchCount) {
      const name = matchCount[1].trim();
      const countStr = matchCount[2] || matchCount[3] || matchCount[4] || matchCount[5];
      const count = parseInt(countStr, 10) || 1;
      if (name) {
        rawItems.push({ name, goals: count });
      }
    } else {
      if (token) {
        rawItems.push({ name: token, goals: 1 });
      }
    }
  }

  // Consolidate duplicates (e.g. "Bunny, Bunny" -> Bunny 2 goals)
  const consolidated = new Map<string, { originalName: string; goals: number }>();
  for (const item of rawItems) {
    const key = item.name.toLowerCase();
    const existing = consolidated.get(key);
    if (existing) {
      existing.goals += item.goals;
    } else {
      consolidated.set(key, { originalName: item.name, goals: item.goals });
    }
  }

  const result: ScorerItem[] = [];
  for (const entry of consolidated.values()) {
    result.push({ name: entry.originalName, goals: entry.goals });
  }

  return result;
}

/**
 * Parses quick manual report text from WhatsApp command into structured fields.
 * Supports:
 * - Positional score: fix-001 2-1 or fix-001 2 1
 * - Multiline:
 *     fix-001 2-1
 *     gol A: Bunny, Razorr
 *     gol B: Ikyy
 * - Single-line:
 *     fix-001 2-1 A: Bunny, Razorr B: Ikyy
 *     fix-001 2-1 gol A: Bunny, Razorr | gol B: Ikyy
 * - Fallback (no scorers):
 *     fix-001 2-1 Catatan pertandingan
 */
export function parseQuickReport(rawInput: string): {
  success: boolean;
  data?: ParsedQuickReport;
  error?: string;
} {
  let cleaned = rawInput.trim();
  // Strip optional leading !manualreport or manualreport
  cleaned = cleaned.replace(/^!?manualreport\s+/i, '').trim();

  if (!cleaned) {
    return {
      success: false,
      error: 'Teks perintah kosong.',
    };
  }

  // Extract fixture ID and score from the start
  // Pattern 1: <fixtureId> <scoreA>-<scoreB> or <fixtureId> <scoreA>:<scoreB>
  // Pattern 2: <fixtureId> <scoreA> <scoreB>
  const headerMatchDash = cleaned.match(/^([a-zA-Z0-9_\-:]+)\s+(\d+)\s*[-–:]\s*(\d+)([\s\S]*)$/);
  const headerMatchSpace = cleaned.match(/^([a-zA-Z0-9_\-:]+)\s+(\d+)\s+(\d+)([\s\S]*)$/);

  let fixtureId = '';
  let scoreA = 0;
  let scoreB = 0;
  let rest = '';

  if (headerMatchDash) {
    fixtureId = headerMatchDash[1];
    scoreA = parseInt(headerMatchDash[2], 10);
    scoreB = parseInt(headerMatchDash[3], 10);
    rest = (headerMatchDash[4] || '').trim();
  } else if (headerMatchSpace) {
    fixtureId = headerMatchSpace[1];
    scoreA = parseInt(headerMatchSpace[2], 10);
    scoreB = parseInt(headerMatchSpace[3], 10);
    rest = (headerMatchSpace[4] || '').trim();
  } else {
    return {
      success: false,
      error: 'Format skor tidak dikenali. Gunakan: `<fixture_id> <skor_a>-<skor_b>` atau `<fixture_id> <skor_a> <skor_b>`.',
    };
  }

  if (isNaN(scoreA) || isNaN(scoreB) || scoreA < 0 || scoreB < 0) {
    return {
      success: false,
      error: 'Skor harus berupa angka bulat non-negatif.',
    };
  }

  // Markers for Team A and Team B scorers
  const markerA = /(?:^|\n|\||\s)(?:gol\s*a|tim\s*a|team\s*a|\ba)\s*[:=]\s*/i;
  const markerB = /(?:^|\n|\||\s)(?:gol\s*b|tim\s*b|team\s*b|\bb)\s*[:=]\s*/i;

  const matchA = rest.match(markerA);
  const matchB = rest.match(markerB);

  let rawScorersA: ScorerItem[] = [];
  let rawScorersB: ScorerItem[] = [];
  let notes: string | undefined;
  let hasExplicitScorers = false;

  if (matchA || matchB) {
    hasExplicitScorers = true;
    const indexA = matchA ? matchA.index! + matchA[0].length : -1;
    const indexB = matchB ? matchB.index! + matchB[0].length : -1;

    // Check which marker comes first
    if (indexA !== -1 && indexB !== -1) {
      if (indexA < indexB) {
        // Pre-A text can be notes
        const preNote = rest.slice(0, matchA!.index!).trim();
        if (preNote) notes = preNote;

        // String between A marker and B match
        const aPart = rest.slice(indexA, matchB!.index!).replace(/\|$/, '').trim();
        const bPart = rest.slice(indexB).trim();

        // Check if bPart has trailing notes (e.g. "Catatan: ...")
        const noteMatch = bPart.match(/(?:\n|\||\s)(?:catatan|note|notes)\s*[:=]\s*([\s\S]+)$/i);
        if (noteMatch) {
          rawScorersB = parseScorerList(bPart.slice(0, noteMatch.index!).trim());
          notes = (notes ? notes + ' | ' : '') + noteMatch[1].trim();
        } else {
          rawScorersB = parseScorerList(bPart);
        }
        rawScorersA = parseScorerList(aPart);
      } else {
        // B comes before A
        const preNote = rest.slice(0, matchB!.index!).trim();
        if (preNote) notes = preNote;

        const bPart = rest.slice(indexB, matchA!.index!).replace(/\|$/, '').trim();
        const aPart = rest.slice(indexA).trim();

        const noteMatch = aPart.match(/(?:\n|\||\s)(?:catatan|note|notes)\s*[:=]\s*([\s\S]+)$/i);
        if (noteMatch) {
          rawScorersA = parseScorerList(aPart.slice(0, noteMatch.index!).trim());
          notes = (notes ? notes + ' | ' : '') + noteMatch[1].trim();
        } else {
          rawScorersA = parseScorerList(aPart);
        }
        rawScorersB = parseScorerList(bPart);
      }
    } else if (indexA !== -1) {
      // Only A specified
      const preNote = rest.slice(0, matchA!.index!).trim();
      if (preNote) notes = preNote;

      const aPart = rest.slice(indexA).trim();
      const noteMatch = aPart.match(/(?:\n|\||\s)(?:catatan|note|notes)\s*[:=]\s*([\s\S]+)$/i);
      if (noteMatch) {
        rawScorersA = parseScorerList(aPart.slice(0, noteMatch.index!).trim());
        notes = (notes ? notes + ' | ' : '') + noteMatch[1].trim();
      } else {
        rawScorersA = parseScorerList(aPart);
      }
    } else if (indexB !== -1) {
      // Only B specified
      const preNote = rest.slice(0, matchB!.index!).trim();
      if (preNote) notes = preNote;

      const bPart = rest.slice(indexB).trim();
      const noteMatch = bPart.match(/(?:\n|\||\s)(?:catatan|note|notes)\s*[:=]\s*([\s\S]+)$/i);
      if (noteMatch) {
        rawScorersB = parseScorerList(bPart.slice(0, noteMatch.index!).trim());
        notes = (notes ? notes + ' | ' : '') + noteMatch[1].trim();
      } else {
        rawScorersB = parseScorerList(bPart);
      }
    }
  } else {
    // No markers found -> fallback case (entire rest is notes, no explicit scorers)
    if (rest) {
      notes = rest;
    }
  }

  return {
    success: true,
    data: {
      fixtureId,
      scoreA,
      scoreB,
      rawScorersA,
      rawScorersB,
      notes,
      hasExplicitScorers,
    },
  };
}

/**
 * Fuzzy matches an input name against a team's roster.
 * Tolerates clan tags, symbols, whitespace, and minor typos.
 */
export function matchScorerToRoster(
  inputName: string,
  roster: Player[]
): ScorerMatchResult {
  const normInput = inputName.normalize('NFC').trim().toLowerCase();
  if (!normInput) {
    return { player: null, similarity: 0, error: 'Nama pencetak gol kosong.' };
  }

  const strippedInput = normInput.replace(/^[^a-zA-Z0-9_\u0080-\uFFFF]+|[^a-zA-Z0-9_\u0080-\uFFFF]+$/g, '');

  let bestPlayer: Player | null = null;
  let bestScore = 0;
  const scoredCandidates: { player: Player; score: number }[] = [];

  for (const player of roster) {
    const raw = player.nickname_raw;
    const normRaw = raw.normalize('NFC').trim().toLowerCase();
    const searchKey = (player.nickname_search_key || '').toLowerCase();

    // 1. Exact raw, NFC, or searchKey match
    if (normRaw === normInput || searchKey === normInput || normRaw === strippedInput) {
      return { player, similarity: 1.0 };
    }

    // 2. Token extraction & clan tag stripping
    // E.g. "AVO | Bunny" -> ["avo", "bunny"]
    // E.g. "AVO | lkyy.✘" -> ["avo", "lkyy.✘", "lkyy"]
    const phraseSet = new Set<string>();
    for (const t of normRaw.split(/[\s|·•\-_/[\]()]+/)) {
      if (t) phraseSet.add(t);
      const alphaOnly = t.replace(/[^a-zA-Z0-9]/g, '');
      if (alphaOnly) phraseSet.add(alphaOnly);
    }
    for (const w of normRaw.split(/[^a-zA-Z0-9]+/)) {
      if (w) phraseSet.add(w);
    }

    let maxTokenSim = 0;
    for (const token of phraseSet) {
      if (token === normInput || token === strippedInput) {
        maxTokenSim = 0.95;
        break;
      }
      const maxLen = Math.max(token.length, strippedInput.length);
      if (maxLen > 0) {
        const d = distance(token, strippedInput);
        const sim = Math.max(0, 1 - d / maxLen);
        if (sim > maxTokenSim) {
          maxTokenSim = sim;
        }
      }
    }

    // 3. Substring match
    let subSim = 0;
    if (normRaw.includes(strippedInput) && strippedInput.length >= 3) {
      subSim = 0.88;
    }

    // 4. Full string Levenshtein distance
    const maxFullLen = Math.max(normRaw.length, normInput.length);
    const fullDist = distance(normRaw, normInput);
    const fullSim = maxFullLen > 0 ? Math.max(0, 1 - fullDist / maxFullLen) : 0;

    const compositeScore = Math.max(maxTokenSim, subSim, fullSim);

    if (compositeScore >= 0.5) {
      scoredCandidates.push({ player, score: compositeScore });
    }
    if (compositeScore > bestScore) {
      bestScore = compositeScore;
      bestPlayer = player;
    }
  }

  if (!bestPlayer || bestScore < 0.5) {
    return {
      player: null,
      similarity: bestScore,
      error: `Tidak ada pemain di roster yang cocok dengan nama "${inputName}".`,
    };
  }

  // Check ambiguity / ties
  scoredCandidates.sort((a, b) => b.score - a.score);
  if (
    scoredCandidates.length > 1 &&
    scoredCandidates[0].score - scoredCandidates[1].score < 0.05 &&
    scoredCandidates[0].score < 0.9
  ) {
    return {
      player: null,
      similarity: bestScore,
      error: `Nama "${inputName}" ambigu antara "${scoredCandidates[0].player.nickname_raw}" dan "${scoredCandidates[1].player.nickname_raw}". Mohon ketik nama lebih spesifik.`,
    };
  }

  return { player: bestPlayer, similarity: bestScore };
}

/**
 * Builds the 5-player lineup (1 GK, 4 Outfield) with goals mapped to matched players.
 */
export function buildLineupWithScorers(
  roster: Player[],
  matchedScorers: { playerId: string; goals: number }[],
  opponentScore: number,
  allowUnassigned = false
): { lineup: RawPlayerMatchStat[]; error?: string } {
  if (roster.length < 5) {
    return {
      lineup: [],
      error: `Roster tim hanya memiliki ${roster.length} pemain aktif (dibutuhkan minimal 5: 1 GK, 4 outfield).`,
    };
  }

  const gk = roster.find((p) => p.position === 'GOALKEEPER');
  const outfields = roster.filter((p) => p.position !== 'GOALKEEPER').slice(0, 4);

  if (!gk || outfields.length < 4) {
    return {
      lineup: [],
      error: 'Roster tim harus memiliki minimal 1 GOALKEEPER dan 4 OUTFIELD aktif.',
    };
  }

  const activeFive = [gk, ...outfields];
  const goalsMap = new Map<string, number>();

  if (!allowUnassigned) {
    for (const s of matchedScorers) {
      goalsMap.set(s.playerId, (goalsMap.get(s.playerId) || 0) + s.goals);
    }
  }

  const lineup: RawPlayerMatchStat[] = activeFive.map((player) => {
    const isGk = player === gk;
    const goals = goalsMap.get(player.id) || 0;

    return {
      player_id: player.id,
      nickname_raw: player.nickname_raw,
      rating: null,
      goals,
      assists: 0,
      passes: 0,
      defense_raw: isGk ? opponentScore : 0,
      goalkeeper_saves: isGk ? opponentScore : null,
    };
  });

  return { lineup };
}
