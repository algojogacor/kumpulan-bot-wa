/**
 * Flash Peak TMS - Omak Peak trusted context shape (AI-native expansion, D-037)
 *
 * Read-only context supplied to the Omak Peak chat prompt. Built from DB state
 * at request time by src/application/omak-peak.ts (buildOmakPeakContext).
 * Everything here MUST be safe to surface to any group participant — never
 * include credentials, internal file paths, or system internals.
 */

import type { FlashPeakGameKnowledge } from './flashpeak-game-knowledge.js';

export interface OmakPeakContext {
  tournament?: {
    name: string;
    status: string;
    current_round_code?: string | null;
    current_round_label?: string | null;
    wib_now?: string;
    cutoff_time?: string;
    time_remaining_to_cutoff?: string;
    matchday_policy?: string;
    kickoff_time?: string;
    confirmation_deadline?: string;
    grace_period_minutes?: number;
    report_window_minutes?: number;
    points_win?: number;
    points_draw?: number;
    points_loss?: number;
  };
  /**
   * Fixtures scheduled across tournament rounds — bounded to a reasonable
   * count to keep prompt size manageable. Includes stage/group/round, host team,
   * active round indicator, and status so Omak Peak can answer "siapa lawan tim X",
   * "kapan main", "jadwal ronde 2", etc. accurately without technical jargon.
   */
  today_fixtures: Array<{
    fixture_id: string;
    stage: string;
    group_code: string | null;
    round_code: string | null;
    round_label?: string | null;
    team_a_name: string;
    team_b_name: string;
    host_team_name?: string;
    is_current_round?: boolean;
    scheduled_at: string | null;
    status: string;
    score?: string | null;
    is_walkover?: boolean;
  }>;
  /**
   * Compact standings per group (top rows). Bounded per group so the prompt
   * doesn't bloat for large tournaments.
   */
  standings_by_group: Array<{
    group_code: string;
    rows: Array<{
      team_name: string;
      played: number;
      wins: number;
      draws: number;
      losses: number;
      goals_for: number;
      goals_against: number;
      points: number;
    }>;
  }>;
  /**
   * Top goal scorers across all completed matches in the tournament.
   */
  top_scorers?: Array<{
    rank: number;
    nickname: string;
    team_name: string;
    goals: number;
    matches: number;
  }>;
  /**
   * Top assist providers across all completed matches in the tournament.
   */
  top_assists?: Array<{
    rank: number;
    nickname: string;
    team_name: string;
    assists: number;
    matches: number;
  }>;
  /**
   * Top outfield defenders by defensive contributions.
   */
  top_defenders?: Array<{
    rank: number;
    nickname: string;
    team_name: string;
    defense: number;
    matches: number;
  }>;
  /**
   * Current status of tournament awards.
   */
  awards_status?: {
    goalkeeper_award_suspended: boolean;
    active_awards: string[];
    notes: string;
  };
  /**
   * Teams + their delegate's WhatsApp address. Per the tournament's open-communication
   * norm (D-037), delegate contacts are shareable so participants can coordinate matches
   * (room host, scheduling). Limited to teams in the active tournament.
   *
   * delegate_whatsapp_is_lid flags addresses that are WhatsApp internal LIDs
   * (`@lid`) rather than dialable phone-number JIDs: production identities are
   * LID-typed, and a raw LID is NOT actionable as a contact for the recipient.
   * The Omak Peak prompt uses this flag to avoid presenting such an address
   * as a usable "contact" (it directs askers to tag the delegate in the group
   * instead — see D-037 contact-sharing guidance in omak-peak.ts).
   */
  teams_and_delegates: Array<{
    team_name: string;
    team_code: string | null;
    delegate_display_name: string | null;
    delegate_whatsapp: string | null;
    delegate_whatsapp_is_lid: boolean;
    group_code: string | null;
  }>;
  /**
   * Official registered rosters for all teams in the active tournament.
   * Enables Omak Peak to answer roster queries ("!ai roster X", "siapa pemain tim Y",
   * "siapa kiper tim Z", player checks) accurately and with complete certainty.
   */
  team_rosters?: Array<{
    team_name: string;
    group_code: string | null;
    players: Array<{
      nickname: string;
      position: 'GOALKEEPER' | 'OUTFIELD';
      roster_type: 'STARTER' | 'SUBSTITUTE';
    }>;
  }>;
  /**
   * Leaderboard for community trivia quiz (!quiz) — pure engagement/fun,
   * separate from official tournament standings.
   */
  quiz_leaderboard?: Array<{
    rank: number;
    participant_name: string;
    score: number;
  }>;
  /**
   * The living FAQ (!qna). Omak Peak should prefer these for repeated questions.
   */
  qna_entries: Array<{
    question: string;
    answer: string;
    category: string | null;
  }>;
  /**
   * Compact rules summary, derived from COMPETITION_RULES.md at build time.
   * Keeps the prompt grounded in actual published rules without dumping the
   * full document (which would bloat tokens).
   */
  rules_summary: string;
  /**
   * Rolling conversation memory — recent !ai Q&A turns in THIS group chat
   * within the TTL window (default 15 minutes). Injected by OmakPeakService
   * (not by buildOmakPeakContext, since memory is in-process state, not DB).
   * Lets the model treat follow-ups like "coba tebak terserah" as a
   * continuation of a prior "siapa juara" turn instead of a fresh cold start.
   * Older turns first; bounded to a small N (default 6).
   */
  recent_ai_turns?: Array<{
    sender_label: string;
    question: string;
    answer: string;
    ts: string; // ISO 8601
  }>;
  /**
   * Comprehensive Flash Peak game knowledge (characters, skills, attributes,
   * combat/tackle formulas, pitch rules, and tactical matchup playbook).
   */
  game_knowledge?: FlashPeakGameKnowledge;
}
