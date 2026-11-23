/**
 * Flash Peak TMS - Goalkeeper Identity Resolver (Caption-based Fuzzy Match)
 * 
 * ⛔ CRITICAL ARCHITECTURAL RULE:
 * Goalkeeper identity is resolved SOLELY via caption-based fuzzy matching against
 * the submitting team's roster (FR-GK-005, D-030, AI_PIPELINE.md §5).
 * 
 * Under NO circumstances may the system fall back to or utilize statistical vector
 * matching (comparing rating/goals/assists/passes/defense). That approach was
 * explicitly rejected because goalkeeper statistical vectors cluster too tightly
 * (most goalkeepers score 0 goals / 0 assists) to disambiguate reliably.
 * 
 * If the caption is missing, ambiguous, or unmatched -> return AMBIGUOUS or UNMATCHED
 * and prompt for human manual confirmation.
 */

import { distance } from 'fastest-levenshtein';

export interface RosterPlayerCandidate {
  id: string; // player UUID
  nickname: string;
  is_goalkeeper?: boolean;
}

export interface GoalkeeperIdentityParams {
  caption?: string | null;
  submitting_team_roster: RosterPlayerCandidate[];
}

export interface ScoredCandidate {
  player_id: string;
  nickname: string;
  similarity: number;
  distance: number;
}

export interface GoalkeeperIdentityResolution {
  status: 'UNIQUE' | 'AMBIGUOUS' | 'UNMATCHED';
  candidate_player_id: string | null;
  candidate_nickname: string | null;
  link_method: 'CAPTION_NICKNAME_FUZZY_MATCH';
  confidence: number;
  matched_score?: number;
  reason: string;
  candidates: ScoredCandidate[];
}

/**
 * Calculates normalized string similarity between 0 and 1.
 * 1.0 = identical, 0.0 = completely different.
 */
function calculateSimilarity(str1: string, str2: string): { similarity: number; dist: number } {
  const s1 = str1.trim().toLowerCase();
  const s2 = str2.trim().toLowerCase();

  if (s1 === s2) {
    return { similarity: 1.0, dist: 0 };
  }

  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) {
    return { similarity: 1.0, dist: 0 };
  }

  const dist = distance(s1, s2);
  const similarity = Math.max(0, 1 - dist / maxLen);
  return { similarity, dist };
}

/**
 * Extracts candidate tokens and sliding windows from caption text.
 * E.g. "FOTO 1 HX KINGrajj" -> ["foto", "1", "hx", "kingrajj", "hx kingrajj"]
 */
function extractCaptionCandidatePhrases(caption: string): string[] {
  const cleaned = caption.replace(/[\r\n\t]/g, ' ').trim();
  const rawTokens = cleaned.split(/\s+/).filter(Boolean);

  const phrases = new Set<string>();

  // Individual tokens
  for (const t of rawTokens) {
    // Strip common punctuation around token
    const stripped = t.replace(/^[^a-zA-Z0-9_\u0080-\uFFFF]+|[^a-zA-Z0-9_\u0080-\uFFFF]+$/g, '');
    if (stripped.length >= 2) {
      phrases.add(stripped);
    }
  }

  // 2-word combinations (for nicknames with clan tags or spaces like "HX KINGraj")
  for (let i = 0; i < rawTokens.length - 1; i++) {
    const combined = `${rawTokens[i]} ${rawTokens[i + 1]}`.replace(
      /^[^a-zA-Z0-9_\u0080-\uFFFF]+|[^a-zA-Z0-9_\u0080-\uFFFF]+$/g,
      ''
    );
    if (combined.length >= 3) {
      phrases.add(combined);
    }
  }

  // Full cleaned caption as well
  phrases.add(cleaned);

  return Array.from(phrases);
}

/**
 * Resolves goalkeeper identity using caption-based fuzzy string matching.
 * 
 * Rules:
 * - Submitting team roster ONLY.
 * - Prioritizes registered goalkeepers if marked on roster.
 * - Tolerate minor typos/abbreviations (e.g. "KINGraj" matches "KINGrajj").
 * - Returns UNIQUE if a single clear match exists.
 * - Returns AMBIGUOUS if multiple candidates tie or match closely.
 * - Returns UNMATCHED if caption is missing, empty, or below similarity threshold.
 * - NEVER uses statistical cross-matching!
 */
export function resolveGoalkeeperIdentity(
  params: GoalkeeperIdentityParams
): GoalkeeperIdentityResolution {
  // Defensive verification: ensure NO statistical vector arguments are processed
  const rawParams = params as unknown as Record<string, unknown>;
  if (
    'stats' in rawParams ||
    'statistical_vector' in rawParams ||
    'goals' in rawParams ||
    'defense_vector' in rawParams
  ) {
    // Note: Statistical matching was explicitly rejected in architecture
    // We ignore any statistical arguments completely
  }

  const caption = params.caption?.trim();
  if (!caption) {
    return {
      status: 'UNMATCHED',
      candidate_player_id: null,
      candidate_nickname: null,
      link_method: 'CAPTION_NICKNAME_FUZZY_MATCH',
      confidence: 0,
      reason: 'No caption provided with detail screenshot. Manual confirmation required.',
      candidates: [],
    };
  }

  const roster = params.submitting_team_roster || [];
  if (roster.length === 0) {
    return {
      status: 'UNMATCHED',
      candidate_player_id: null,
      candidate_nickname: null,
      link_method: 'CAPTION_NICKNAME_FUZZY_MATCH',
      confidence: 0,
      reason: 'Submitting team roster is empty.',
      candidates: [],
    };
  }

  // Prefer designated goalkeepers if flagged; otherwise check all roster players
  const registeredKeepers = roster.filter((p) => p.is_goalkeeper === true);
  const targetPool = registeredKeepers.length > 0 ? registeredKeepers : roster;

  const captionPhrases = extractCaptionCandidatePhrases(caption);
  const scoredCandidates: ScoredCandidate[] = [];

  for (const player of targetPool) {
    let bestSimilarity = 0;
    let bestDist = Infinity;

    for (const phrase of captionPhrases) {
      const { similarity, dist } = calculateSimilarity(phrase, player.nickname);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestDist = dist;
      }

      // Check substring containment (e.g. "HX KINGrajj" contains "KINGrajj")
      const lowerPhrase = phrase.toLowerCase();
      const lowerNick = player.nickname.toLowerCase();
      if (lowerPhrase.includes(lowerNick) || lowerNick.includes(lowerPhrase)) {
        const subSim = Math.min(lowerPhrase.length, lowerNick.length) / Math.max(lowerPhrase.length, lowerNick.length);
        if (subSim > bestSimilarity) {
          bestSimilarity = subSim;
          bestDist = Math.abs(lowerPhrase.length - lowerNick.length);
        }
      }
    }

    scoredCandidates.push({
      player_id: player.id,
      nickname: player.nickname,
      similarity: bestSimilarity,
      distance: bestDist,
    });
  }

  // Sort descending by similarity, ascending by distance
  scoredCandidates.sort((a, b) => b.similarity - a.similarity || a.distance - b.distance);

  // Calibrated similarity thresholds:
  // - High confidence match: similarity >= 0.75 or distance <= 2 for names >= 5 chars
  // - Minimum threshold: similarity >= 0.65
  const MATCH_THRESHOLD = 0.65;
  const eligible = scoredCandidates.filter((c) => c.similarity >= MATCH_THRESHOLD);

  if (eligible.length === 0) {
    return {
      status: 'UNMATCHED',
      candidate_player_id: null,
      candidate_nickname: null,
      link_method: 'CAPTION_NICKNAME_FUZZY_MATCH',
      confidence: scoredCandidates[0]?.similarity ?? 0,
      reason: `Caption "${caption}" did not match any registered roster player above threshold (${MATCH_THRESHOLD}).`,
      candidates: scoredCandidates,
    };
  }

  const best = eligible[0];
  const runnerUp = eligible[1];

  // Check ambiguity between top candidates
  if (runnerUp) {
    const similarityDiff = best.similarity - runnerUp.similarity;
    // If top two are tied or too close (diff < 0.15) -> ambiguous!
    if (similarityDiff < 0.15) {
      return {
        status: 'AMBIGUOUS',
        candidate_player_id: null,
        candidate_nickname: null,
        link_method: 'CAPTION_NICKNAME_FUZZY_MATCH',
        confidence: best.similarity,
        matched_score: best.similarity,
        reason: `Caption "${caption}" matches multiple roster candidates (${best.nickname} vs ${runnerUp.nickname}) with close scores. Manual confirmation required.`,
        candidates: eligible,
      };
    }
  }

  // Clear unique winner
  return {
    status: 'UNIQUE',
    candidate_player_id: best.player_id,
    candidate_nickname: best.nickname,
    link_method: 'CAPTION_NICKNAME_FUZZY_MATCH',
    confidence: best.similarity,
    matched_score: best.similarity,
    reason: `Successfully resolved goalkeeper identity to "${best.nickname}" via caption fuzzy match (similarity: ${(best.similarity * 100).toFixed(1)}%).`,
    candidates: [best],
  };
}
