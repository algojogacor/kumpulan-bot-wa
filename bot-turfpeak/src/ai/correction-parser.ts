/**
 * Flash Peak TMS - Natural Language Correction Parser
 * 
 * Parses Indonesian and English natural-language correction messages into
 * typed StructuredCorrectionPatch objects (PROMPT_CATALOG.md §6).
 * 
 * Indonesian terms mapping:
 * - gol -> goals
 * - asis / assist / asist -> assists
 * - umpan / umpannya -> passes
 * - defense / defens / def -> defense
 * - skor / score -> score
 * - rating / rate -> rating
 * - player urutan N / pemain ke-N -> ROSTER_ORDINAL N
 * 
 * Ambiguous inputs return NEEDS_CLARIFICATION.
 */

import { ProviderRouter } from './router.js';
import {
  CORRECTION_PARSER_PROMPT,
  CorrectionParserOutput,
  correctionParserOutputSchema,
} from './prompts/correction.js';
import { StructuredCorrectionPatch } from '../shared/types/index.js';

export interface ReportPlayerContext {
  ordinal: number; // 1-based index
  nickname: string;
  rating?: number | null;
  goals?: number | null;
  assists?: number | null;
  passes?: number | null;
  defense?: number | null;
}

export interface ReportContext {
  report_version_id: string;
  team_a: {
    id: string;
    name: string;
    players: ReportPlayerContext[];
  };
  team_b: {
    id: string;
    name: string;
    players: ReportPlayerContext[];
  };
  score_a?: number | null;
  score_b?: number | null;
}

export interface ParseCorrectionParams {
  message_text: string;
  report_context: ReportContext;
  correlation_id?: string;
  useAi?: boolean; // Default true, falls back to deterministic rule parser
}

export type CorrectionParseOutcome =
  | {
      status: 'PROPOSED';
      patch: StructuredCorrectionPatch;
      raw_ai_output?: CorrectionParserOutput;
    }
  | {
      status: 'NEEDS_CLARIFICATION';
      clarification_reason: string;
      patch: null;
      raw_ai_output?: CorrectionParserOutput;
    };

/**
 * Deterministic Indonesian heuristic extractor for rule-based parsing and AI output reconciliation.
 */
export function parseCorrectionRuleBased(
  text: string,
  context: ReportContext
): CorrectionParseOutcome {
  const lower = text.toLowerCase();

  // 1. Map metric
  let metric: 'goals' | 'assists' | 'passes' | 'defense' | 'rating' | 'score' | null = null;
  if (lower.includes('umpan') || lower.includes('pass')) {
    metric = 'passes';
  } else if (lower.includes('gol') || lower.includes('goal')) {
    metric = 'goals';
  } else if (lower.includes('asis') || lower.includes('assist')) {
    metric = 'assists';
  } else if (lower.includes('defens') || lower.includes('defense') || lower.includes('def')) {
    metric = 'defense';
  } else if (lower.includes('skor') || lower.includes('score')) {
    metric = 'score';
  } else if (lower.includes('rating') || lower.includes('rate')) {
    metric = 'rating';
  }

  if (!metric) {
    return {
      status: 'NEEDS_CLARIFICATION',
      clarification_reason: 'Statistik yang ingin dikoreksi tidak dapat diidentifikasi (misal: gol, assist, umpan, defense, skor).',
      patch: null,
    };
  }

  // 2. Identify Team
  let teamSide: 'TEAM_A' | 'TEAM_B' | undefined;
  let matchedTeamName: string | undefined;

  const teamAName = context.team_a.name.toLowerCase();
  const teamBName = context.team_b.name.toLowerCase();

  if (lower.includes(teamAName)) {
    teamSide = 'TEAM_A';
    matchedTeamName = context.team_a.name;
  } else if (lower.includes(teamBName)) {
    teamSide = 'TEAM_B';
    matchedTeamName = context.team_b.name;
  } else if (lower.includes('tim a') || lower.includes('tim_a')) {
    teamSide = 'TEAM_A';
    matchedTeamName = context.team_a.name;
  } else if (lower.includes('tim b') || lower.includes('tim_b')) {
    teamSide = 'TEAM_B';
    matchedTeamName = context.team_b.name;
  }

  // 3. Identify Player (Ordinal or Nickname)
  let playerOrdinal: number | undefined;
  let playerNickname: string | undefined;

  const ordinalMatch = lower.match(/(?:player|pemain|urutan|ke[- ]?)(\d+)/i) ||
                       lower.match(/(?:urutan\s*)(\d+)/i);

  if (ordinalMatch) {
    playerOrdinal = parseInt(ordinalMatch[1], 10);
  } else {
    // Check if any player nickname from either team is directly mentioned
    const allPlayers = [
      ...context.team_a.players.map((p) => ({ ...p, side: 'TEAM_A' as const })),
      ...context.team_b.players.map((p) => ({ ...p, side: 'TEAM_B' as const })),
    ];

    for (const p of allPlayers) {
      if (lower.includes(p.nickname.toLowerCase())) {
        playerNickname = p.nickname;
        playerOrdinal = p.ordinal;
        if (!teamSide) {
          teamSide = p.side;
          matchedTeamName = p.side === 'TEAM_A' ? context.team_a.name : context.team_b.name;
        }
        break;
      }
    }
  }

  // If metric is player-level but neither team nor player is clear
  if (metric !== 'score') {
    if (!teamSide) {
      return {
        status: 'NEEDS_CLARIFICATION',
        clarification_reason: `Tim mana yang dimaksud untuk koreksi ini (${context.team_a.name} atau ${context.team_b.name})?`,
        patch: null,
      };
    }

    if (playerOrdinal === undefined && !playerNickname) {
      return {
        status: 'NEEDS_CLARIFICATION',
        clarification_reason: 'Pemain mana yang dimaksud (sebutkan urutan pemain 1-N atau nickname)?',
        patch: null,
      };
    }
  }

  // 4. Extract values (e.g. "seharusnya 6 bukan 9", "harusnya 6 bukan 9", "6 bukan 9", "menjadi 6")
  let newValue: number | string | undefined;
  let oldValue: number | string | null = null;

  const valueMatch = lower.match(/(?:seharusnya|harusnya|jd|menjadi|ubah ke)?\s*(\d+(?:\.\d+)?)\s*(?:bukan|dr|dari)\s*(\d+(?:\.\d+)?)/i);
  if (valueMatch) {
    newValue = parseFloat(valueMatch[1]);
    oldValue = parseFloat(valueMatch[2]);
  } else {
    const singleValueMatch = lower.match(/(?:seharusnya|harusnya|jd|menjadi|ke)\s*(\d+(?:\.\d+)?)/i);
    if (singleValueMatch) {
      newValue = parseFloat(singleValueMatch[1]);
    }
  }

  if (newValue === undefined) {
    return {
      status: 'NEEDS_CLARIFICATION',
      clarification_reason: 'Nilai baru koreksi tidak dapat ditentukan secara pasti (contoh: "seharusnya 6 bukan 9").',
      patch: null,
    };
  }

  const patch: StructuredCorrectionPatch = {
    target_report_version_id: context.report_version_id,
    team_side: teamSide,
    team_name: matchedTeamName,
    player_ordinal: playerOrdinal,
    player_nickname: playerNickname,
    metric,
    stated_old_value: oldValue,
    new_value: newValue,
    reason: text,
    ambiguity_flags: [],
  };

  return {
    status: 'PROPOSED',
    patch,
  };
}

export class CorrectionParser {
  constructor(private readonly router?: ProviderRouter) {}

  /**
   * Parses natural language correction message.
   * Leverages multi-provider LLM routing when available, with deterministic fallback.
   */
  public async parse(params: ParseCorrectionParams): Promise<CorrectionParseOutcome> {
    const { message_text, report_context, router = this.router } = {
      ...params,
      router: this.router,
    };

    // If router is present and useAi is not false, call AI model
    if (router && params.useAi !== false) {
      try {
        const reportContextJson = JSON.stringify(report_context, null, 2);
        const userPrompt = CORRECTION_PARSER_PROMPT.buildUserPrompt(message_text, reportContextJson);

        const response = await router.execute<unknown>({
          task: 'PARSE_CORRECTION',
          structured_output: true,
          system_prompt: CORRECTION_PARSER_PROMPT.system_prompt,
          prompt: userPrompt,
          correlation_id: params.correlation_id,
          temperature: 0.1,
        });

        const parsed = correctionParserOutputSchema.parse(response.parsed_json);

        if (parsed.status === 'NEEDS_CLARIFICATION' || parsed.intent !== 'CORRECTION') {
          return {
            status: 'NEEDS_CLARIFICATION',
            clarification_reason:
              parsed.clarification_question ||
              parsed.ambiguities.join('; ') ||
              'Pesan koreksi belum cukup spesifik untuk menentukan pemain atau nilai yang diperbaiki.',
            patch: null,
            raw_ai_output: parsed,
          };
        }

        if (!parsed.statistic || parsed.new_value === undefined || parsed.new_value === null) {
          return {
            status: 'NEEDS_CLARIFICATION',
            clarification_reason: 'Statistik atau nilai baru tidak lengkap dalam pesan koreksi.',
            patch: null,
            raw_ai_output: parsed,
          };
        }

        const patch: StructuredCorrectionPatch = {
          target_report_version_id: report_context.report_version_id,
          team_side: parsed.team_side || undefined,
          team_name: parsed.team_name || undefined,
          player_ordinal: parsed.player_reference?.ordinal,
          player_nickname: parsed.player_reference?.nickname,
          metric: parsed.statistic,
          stated_old_value: parsed.old_value ?? null,
          new_value: parsed.new_value,
          reason: parsed.reason || message_text,
          ambiguity_flags: parsed.ambiguities,
        };

        return {
          status: 'PROPOSED',
          patch,
          raw_ai_output: parsed,
        };
      } catch {
        // Fall back to rule-based parser if AI parsing encountered an error or invalid structure
      }
    }

    // Deterministic rule-based extraction
    return parseCorrectionRuleBased(message_text, report_context);
  }
}
