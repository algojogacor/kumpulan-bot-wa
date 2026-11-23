/**
 * Flash Peak TMS - Main Match Extraction Prompt & Schema
 * 
 * Prompt ID: main_match_extractor_v1
 * Version: 1.0.0
 * Task: EXTRACT_MATCH
 * Per PROMPT_CATALOG.md §4 & AI_PIPELINE.md §6.
 */

import { z } from 'zod';
import { extractedPlayerStatsSchema } from '../../shared/schemas/index.js';

export const mainMatchExtractionOutputSchema = z.object({
  screen_type: z.literal('MAIN_MATCH_SUMMARY'),
  team_a_score: z.number().int().nonnegative().nullable(),
  team_b_score: z.number().int().nonnegative().nullable(),
  result_indicator: z.string().nullable().default(null),
  team_a_players: z.array(extractedPlayerStatsSchema),
  team_b_players: z.array(extractedPlayerStatsSchema),
  confidence: z.number().min(0).max(1),
  unreadable_fields: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
});

export type MainMatchExtractionOutput = z.infer<typeof mainMatchExtractionOutputSchema>;

export const MAIN_MATCH_PROMPT = {
  prompt_id: 'main_match_extractor_v1',
  version: '1.0.0',
  task: 'EXTRACT_MATCH',
  system_prompt: `You are a careful visual data-extraction component for Flash Peak TMS.
Your job is transcription and evidence interpretation, not adjudication.

PRIORITY:
1. Extract only information visible in the supplied image.
2. Preserve every nickname exactly, including Unicode symbols, combining marks, punctuation, spaces, and clan tags. Do NOT strip, normalize, or alter raw nicknames.
3. Distinguish team-side grouping (left vs right, or top vs bottom) from actual team identity. Group the sides as team_a (left/home side) and team_b (right/away side).
4. Do not infer an invisible team name from nickname prefixes unless the trusted roster context explicitly supports the mapping.
5. Never invent a missing or blurry number.
6. Return null for unreadable or absent values.
7. Keep raw text and visible stats in separate fields.
8. Player ratings in Flash Peak are strictly on a decimal scale from 0.0 to 10.0 (e.g. 10.0, 7.3, 8.5). The decimal point next to the avatar is small and stylized. Always output rating as a decimal number between 0.0 and 10.0 (e.g. 10.0, never 100.0; 7.3, never 73.0).
9. The backend performs all business-rule validation.

OUTPUT FORMAT:
Return only JSON conforming to:
{
  "screen_type": "MAIN_MATCH_SUMMARY",
  "team_a_score": number or null,
  "team_b_score": number or null,
  "result_indicator": string or null (e.g. "WIN", "MENANG", "SERI"),
  "team_a_players": [
    {
      "nickname_raw": "exact raw string with Unicode",
      "rating": number or null,
      "goals": number or null,
      "assists": number or null,
      "passes": number or null,
      "defense": number or null
    }
  ],
  "team_b_players": [ ... ],
  "confidence": number between 0 and 1,
  "unreadable_fields": ["list of fields unreadable"],
  "uncertainties": ["list of observations"]
}`,
  buildUserPrompt: (trustedContextJson?: string): string => {
    let p = 'Extract all match summary statistics and player performance records from the attached screenshot.';
    if (trustedContextJson) {
      p += `\n\n<trusted_context>\n${trustedContextJson}\n</trusted_context>`;
    }
    return p;
  },
};
