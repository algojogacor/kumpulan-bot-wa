/**
 * Flash Peak TMS - Natural Language Correction Prompt & Schema
 * 
 * Prompt ID: correction_parser_v1
 * Version: 1.0.0
 * Task: PARSE_CORRECTION
 * Per PROMPT_CATALOG.md §6.
 */

import { z } from 'zod';

export const correctionIntentSchema = z.enum(['CORRECTION', 'QUESTION', 'DISPUTE', 'UNRELATED']);

export const correctionStatisticMetricSchema = z.enum([
  'goals',
  'assists',
  'passes',
  'defense',
  'rating',
  'score',
]);

export const playerReferenceSchema = z.object({
  type: z.enum(['ROSTER_ORDINAL', 'NICKNAME', 'OTHER']),
  ordinal: z.number().int().positive().optional(),
  nickname: z.string().optional(),
});

export const correctionParserOutputSchema = z.object({
  intent: correctionIntentSchema,
  status: z.enum(['PROPOSED', 'NEEDS_CLARIFICATION', 'REJECTED']),
  team_name: z.string().nullable().optional(),
  team_side: z.enum(['TEAM_A', 'TEAM_B']).nullable().optional(),
  player_reference: playerReferenceSchema.nullable().optional(),
  statistic: correctionStatisticMetricSchema.nullable().optional(),
  old_value: z.union([z.number(), z.string()]).nullable().optional(),
  new_value: z.union([z.number(), z.string()]).nullable().optional(),
  reason: z.string().nullable().optional(),
  ambiguities: z.array(z.string()).default([]),
  clarification_question: z.string().nullable().optional(),
});

export type CorrectionParserOutput = z.infer<typeof correctionParserOutputSchema>;

export const CORRECTION_PARSER_PROMPT = {
  prompt_id: 'correction_parser_v1',
  version: '1.0.0',
  task: 'PARSE_CORRECTION',
  system_prompt: `You parse correction messages for an existing Flash Peak TMS report.
You do not modify records and you do not approve reports.

TASK:
Interpret whether the inbound message is a correction, a question, a dispute, or unrelated discussion.

For a correction, extract:
- team_name or team_side (TEAM_A or TEAM_B)
- player reference (ROSTER_ORDINAL e.g. "player urutan 3" -> 3, or NICKNAME)
- statistic: goals, assists, passes, defense, rating, or score
- stated old value, if mentioned
- proposed new value
- ambiguities list

INDONESIAN TERMS MAPPING:
- "gol" -> goals
- "asis", "assist", "asist" -> assists
- "umpan" -> passes
- "defense", "defens", "def" -> defense
- "skor", "score" -> score
- "rating", "rate" -> rating
- "player urutan N" or "pemain ke-N" -> ROSTER_ORDINAL with ordinal N

RULES:
- Resolve "player urutan N" only within an explicitly identified team and player list.
- If the target team, player, or metric is ambiguous or cannot be uniquely identified, set status to "NEEDS_CLARIFICATION" and specify clarification_question.
- Never invent missing team/player/metric.
- Return only a schema-conforming JSON object.`,
  buildUserPrompt: (messageText: string, reportContextJson?: string): string => {
    let p = `<correction_message>\n${messageText}\n</correction_message>`;
    if (reportContextJson) {
      p = `<report_context>\n${reportContextJson}\n</report_context>\n\n${p}`;
    }
    return p;
  },
};
