/**
 * Flash Peak TMS - Tournament Awards Calculator (Task 6.2)
 * 
 * Computes individual awards per COMPETITION_RULES §10 and Decision D-013 / O-013:
 * 1. Simple ranking by defining metric — no composite or weighted formulas.
 *    - Golden Boot: highest total goals.
 *    - Top Assist: highest total assists.
 *    - Best Defender: highest total defense_raw (outfield players only).
 *    - Best Winning Goalkeeper: highest goalkeeper_saves from award-eligible records (is_award_eligible = 1).
 * 2. Ties: All tied players on the highest metric value are returned as co-winners (array),
 *    unless an organizer override is explicitly provided.
 * 3. Award eligibility (FR-GK-008): Only won-game goalkeeper records are award-eligible.
 * 4. Derived strictly from approved/locked games (FR-CALC-007).
 */

import type { Client } from '@libsql/client';
import type { UUID } from '../shared/types/index.js';
import { aggregatePlayerStats, type AggregatedPlayerStats } from './aggregator.js';

export type AwardKey =
  | 'GOLDEN_BOOT'
  | 'TOP_ASSIST'
  | 'BEST_DEFENDER'
  | 'BEST_WINNING_GOALKEEPER';

export interface AwardWinner {
  playerId: UUID;
  nicknameRaw: string;
  teamId: UUID;
  teamName: string;
  metricValue: number;
  gamesPlayed: number;
}

export interface AwardDetail {
  awardKey: AwardKey;
  title: string;
  definingMetric: string;
  winners: AwardWinner[];
  isTie: boolean;
  isOverride: boolean;
  notes?: string;
}

export interface TournamentAwardsSummary {
  tournamentId: UUID;
  goldenBoot: AwardDetail;
  topAssist: AwardDetail;
  bestDefender: AwardDetail;
  bestWinningGoalkeeper: AwardDetail;
  computedAt: string;
}

export interface AwardsCalculationOptions {
  /**
   * Optional organizer overrides for specific awards.
   * Maps AwardKey to an array of designated winner player IDs.
   */
  overrides?: Partial<Record<AwardKey, UUID[]>>;
  /**
   * If true, requires metric value > 0 for a winner to be declared. Default true.
   */
  requirePositiveMetric?: boolean;
}

/**
 * Calculates official individual awards for a tournament.
 */
export async function calculateTournamentAwards(
  db: Client,
  tournamentId: UUID,
  options: AwardsCalculationOptions = {}
): Promise<TournamentAwardsSummary> {
  const requirePositive = options.requirePositiveMetric ?? true;
  const now = new Date().toISOString();

  // 1. Fetch aggregated stats for all players in the tournament
  const allStats = await aggregatePlayerStats(db, tournamentId);

  // 2. Compute Golden Boot (Highest total goals)
  const goldenBoot = computeSingleAward({
    awardKey: 'GOLDEN_BOOT',
    title: 'Golden Boot',
    definingMetric: 'total_goals',
    candidates: allStats,
    metricExtractor: (p) => p.totalGoals,
    overridePlayerIds: options.overrides?.GOLDEN_BOOT,
    requirePositive,
  });

  // 3. Compute Top Assist (Highest total assists)
  const topAssist = computeSingleAward({
    awardKey: 'TOP_ASSIST',
    title: 'Top Assist',
    definingMetric: 'total_assists',
    candidates: allStats,
    metricExtractor: (p) => p.totalAssists,
    overridePlayerIds: options.overrides?.TOP_ASSIST,
    requirePositive,
  });

  // 4. Compute Best Defender (Highest total defense_raw for outfield players)
  const outfieldPlayers = allStats.filter((p) => p.position === 'OUTFIELD');
  const bestDefender = computeSingleAward({
    awardKey: 'BEST_DEFENDER',
    title: 'Best Defender',
    definingMetric: 'total_defense_raw',
    candidates: outfieldPlayers,
    metricExtractor: (p) => p.totalDefenseRaw,
    overridePlayerIds: options.overrides?.BEST_DEFENDER,
    requirePositive,
  });

  // 5. Compute Best Winning Goalkeeper (Highest award-eligible goalkeeper saves)
  const goalkeepers = allStats.filter((p) => p.position === 'GOALKEEPER' || p.awardEligibleSaves > 0);
  const bestWinningGoalkeeper = computeSingleAward({
    awardKey: 'BEST_WINNING_GOALKEEPER',
    title: 'Best Winning Goalkeeper',
    definingMetric: 'award_eligible_saves',
    candidates: goalkeepers,
    metricExtractor: (p) => p.awardEligibleSaves,
    overridePlayerIds: options.overrides?.BEST_WINNING_GOALKEEPER,
    requirePositive,
    notes: 'Calculated exclusively from won-game saves (award_eligible = 1)',
  });

  return {
    tournamentId,
    goldenBoot,
    topAssist,
    bestDefender,
    bestWinningGoalkeeper,
    computedAt: now,
  };
}

interface ComputeSingleAwardParams {
  awardKey: AwardKey;
  title: string;
  definingMetric: string;
  candidates: AggregatedPlayerStats[];
  metricExtractor: (p: AggregatedPlayerStats) => number;
  overridePlayerIds?: UUID[];
  requirePositive: boolean;
  notes?: string;
}

function computeSingleAward({
  awardKey,
  title,
  definingMetric,
  candidates,
  metricExtractor,
  overridePlayerIds,
  requirePositive,
  notes,
}: ComputeSingleAwardParams): AwardDetail {
  // If organizer specified an explicit override for this award
  if (overridePlayerIds && overridePlayerIds.length > 0) {
    const overrideWinners: AwardWinner[] = [];
    for (const pid of overridePlayerIds) {
      const match = candidates.find((c) => c.playerId === pid);
      if (match) {
        overrideWinners.push({
          playerId: match.playerId,
          nicknameRaw: match.nicknameRaw,
          teamId: match.teamId,
          teamName: match.teamName,
          metricValue: metricExtractor(match),
          gamesPlayed: match.gamesPlayed,
        });
      }
    }

    if (overrideWinners.length > 0) {
      return {
        awardKey,
        title,
        definingMetric,
        winners: overrideWinners,
        isTie: overrideWinners.length > 1,
        isOverride: true,
        notes: notes ? `${notes} (Organizer Override Applied)` : 'Organizer Override Applied',
      };
    }
  }

  // Filter candidates by requirePositive rule
  const eligible = candidates.filter((p) => {
    const val = metricExtractor(p);
    return requirePositive ? val > 0 : val >= 0;
  });

  if (eligible.length === 0) {
    return {
      awardKey,
      title,
      definingMetric,
      winners: [],
      isTie: false,
      isOverride: false,
      notes: 'No eligible candidates with qualifying stats',
    };
  }

  // Find maximum metric value
  let maxVal = -Infinity;
  for (const c of eligible) {
    const val = metricExtractor(c);
    if (val > maxVal) {
      maxVal = val;
    }
  }

  // Extract all players who reached the maximum value (co-winners on tie per D-013/O-013)
  const topPlayers = eligible.filter((c) => metricExtractor(c) === maxVal);
  const winners: AwardWinner[] = topPlayers.map((p) => ({
    playerId: p.playerId,
    nicknameRaw: p.nicknameRaw,
    teamId: p.teamId,
    teamName: p.teamName,
    metricValue: maxVal,
    gamesPlayed: p.gamesPlayed,
  }));

  return {
    awardKey,
    title,
    definingMetric,
    winners,
    isTie: winners.length > 1,
    isOverride: false,
    notes,
  };
}
