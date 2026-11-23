/**
 * Flash Peak TMS - Goalkeeper Detail Extraction Prompt & Schema
 * 
 * Prompt ID: goalkeeper_detail_extractor_v1
 * Version: 1.0.0
 * Task: EXTRACT_GOALKEEPER
 * Per PROMPT_CATALOG.md §5 & AI_PIPELINE.md §3, §4.
 */

import { z } from 'zod';

export const goalkeeperVisualCueStatusSchema = z.enum(['PRESENT', 'ABSENT', 'UNCERTAIN']);

export const goalkeeperDetailExtractionOutputSchema = z.object({
  screen_type: z.literal('INDIVIDUAL_PLAYER_DETAIL'),
  match_result: z.object({
    status_text: z.string().nullable(),
    score_left: z.number().int().nonnegative().nullable(),
    score_right: z.number().int().nonnegative().nullable(),
    perspective_side: z.string().nullable().default(null),
  }),
  perspective_player: z.object({
    nickname: z.string().nullable().default(null),
    uid: z.string().nullable().default(null),
    visual_role_cue: z.object({
      type: z.literal('GOALKEEPER'),
      cue_status: goalkeeperVisualCueStatusSchema,
      evidence: z.array(z.string()),
    }),
    summary: z.object({
      rating: z.number().nullable(),
      goals: z.number().int().nonnegative().nullable(),
      assists: z.number().int().nonnegative().nullable(),
      passes: z.number().int().nonnegative().nullable(),
      defense_raw: z.number().int().nonnegative().nullable(),
    }),
    detail_tabs: z.object({
      active: z.string().nullable(),
      shooting: z
        .object({
          shots: z.number().int().nonnegative().nullable(),
          shots_on_target: z.number().int().nonnegative().nullable(),
          goals: z.number().int().nonnegative().nullable(),
          goal_rate_raw: z.string().nullable(),
        })
        .nullable(),
      umpan: z.null().default(null),
      defense: z.null().default(null),
      possession: z.null().default(null),
    }),
  }),
  confidence: z.number().min(0).max(1),
  uncertainties: z.array(z.string()).default([]),
});

export type GoalkeeperDetailExtractionOutput = z.infer<typeof goalkeeperDetailExtractionOutputSchema>;

export const GOALKEEPER_DETAIL_PROMPT = {
  prompt_id: 'goalkeeper_detail_extractor_v1',
  version: '1.0.0',
  task: 'EXTRACT_GOALKEEPER',
  system_prompt: `You are the goalkeeper-detail evidence extractor for Flash Peak TMS.

SCREEN KNOWLEDGE:
The supplied screen is an Individual Player Detail screen:
- It shows one individual character, not a multi-player table.
- It has a match result header (e.g. MENANG/KALAH) and score (score_left, score_right).
- The left side displays the character showcase and a summary of 5 metrics:
  RATING, GOL, ASSIST, UMPAN, DEFENSE.
- The right side displays tabs:
  SHOOTING, UMPAN, DEFENSE, POSSESSION.
- In standard evidence, SHOOTING is active. The other tabs (UMPAN, DEFENSE, POSSESSION) are inactive/hidden.
- The goalkeeper character avatar is visually identified by three specific cues:
  1. Cap (e.g. reversed cap)
  2. Goalkeeper gloves
  3. Ball held in front of the abdomen or chest
- Note: This screen does NOT display a player nickname or UID. Do not hallucinate or invent one.

EXTRACTION RULES:
1. Detect visual cues:
   - If cap, gloves, and ball held in front of abdomen/chest are visible -> cue_status: "PRESENT".
   - If definitely not present -> cue_status: "ABSENT".
   - If partially obscured or uncertain -> cue_status: "UNCERTAIN".
2. Extract summary metrics:
   - Preserve summary DEFENSE value exactly as defense_raw.
   - Hidden detail tabs (UMPAN, DEFENSE, POSSESSION) MUST be null, NEVER zero.
3. If a value is unreadable or absent, return null. Never invent values.

OUTPUT FORMAT:
Return only JSON conforming to:
{
  "screen_type": "INDIVIDUAL_PLAYER_DETAIL",
  "match_result": {
    "status_text": "MENANG",
    "score_left": 12,
    "score_right": 7,
    "perspective_side": "left"
  },
  "perspective_player": {
    "nickname": null,
    "uid": null,
    "visual_role_cue": {
      "type": "GOALKEEPER",
      "cue_status": "PRESENT" | "ABSENT" | "UNCERTAIN",
      "evidence": ["cap", "gloves", "ball_held_in_front_of_abdomen_or_chest"]
    },
    "summary": {
      "rating": 8.0,
      "goals": 0,
      "assists": 0,
      "passes": 2,
      "defense_raw": 4
    },
    "detail_tabs": {
      "active": "SHOOTING",
      "shooting": {
        "shots": 0,
        "shots_on_target": 0,
        "goals": 0,
        "goal_rate_raw": "N/A"
      },
      "umpan": null,
      "defense": null,
      "possession": null
    }
  },
  "confidence": 0.95,
  "uncertainties": []
}`,
  buildUserPrompt: (): string => {
    return 'Extract the individual goalkeeper detail metrics and evaluate visual goalkeeper cues from the attached screenshot.';
  },
};
