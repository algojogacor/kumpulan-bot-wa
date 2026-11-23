/**
 * Flash Peak TMS - Goalkeeper Detail Screen Extractor
 * 
 * Detects visual goalkeeper cues (cap, gloves, ball held in front of abdomen/chest).
 * Extracts individual summary metrics, preserving defense_raw.
 * Maps goalkeeper_saves = defense_raw only after classification and player linking (FR-GK-003).
 * Hidden detail tabs (UMPAN, DEFENSE, POSSESSION) return null, not zero (AI_PIPELINE.md §4).
 * 
 * Per PROMPT_CATALOG.md §5, AI_PIPELINE.md §3, §4.
 */

import { ProviderRouter } from '../router.js';
import {
  GOALKEEPER_DETAIL_PROMPT,
  GoalkeeperDetailExtractionOutput,
  goalkeeperDetailExtractionOutputSchema,
} from '../prompts/goalkeeper.js';

export interface GoalkeeperExtractorOptions {
  correlation_id?: string;
}

export interface GoalkeeperMetricsResult {
  raw_extraction: GoalkeeperDetailExtractionOutput;
  visual_cue_status: 'PRESENT' | 'ABSENT' | 'UNCERTAIN';
  visual_cue_evidence: string[];
  summary: {
    rating: number | null;
    goals: number | null;
    assists: number | null;
    passes: number | null;
    defense_raw: number | null;
  };
  score_left: number | null;
  score_right: number | null;
  screen_result_text: string | null;
}

export class GoalkeeperDetailExtractor {
  constructor(private readonly router: ProviderRouter) {}

  /**
   * Extracts metrics and detects visual goalkeeper cues from an INDIVIDUAL_PLAYER_DETAIL image.
   */
  public async extract(
    image: { mime_type: string; base64: string },
    options: GoalkeeperExtractorOptions = {}
  ): Promise<GoalkeeperMetricsResult> {
    if (!image.base64 || image.base64.trim().length === 0) {
      throw new Error('Image base64 payload is empty');
    }

    const userPrompt = GOALKEEPER_DETAIL_PROMPT.buildUserPrompt();

    const response = await this.router.execute<unknown>({
      task: 'EXTRACT_GOALKEEPER',
      structured_output: true,
      system_prompt: GOALKEEPER_DETAIL_PROMPT.system_prompt,
      prompt: userPrompt,
      images: [
        {
          mime_type: image.mime_type,
          base64: image.base64,
        },
      ],
      correlation_id: options.correlation_id,
      temperature: 0.1,
    });

    const parsed = goalkeeperDetailExtractionOutputSchema.parse(response.parsed_json);

    return {
      raw_extraction: parsed,
      visual_cue_status: parsed.perspective_player.visual_role_cue.cue_status,
      visual_cue_evidence: parsed.perspective_player.visual_role_cue.evidence,
      summary: {
        rating: parsed.perspective_player.summary.rating,
        goals: parsed.perspective_player.summary.goals,
        assists: parsed.perspective_player.summary.assists,
        passes: parsed.perspective_player.summary.passes,
        defense_raw: parsed.perspective_player.summary.defense_raw,
      },
      score_left: parsed.match_result.score_left,
      score_right: parsed.match_result.score_right,
      screen_result_text: parsed.match_result.status_text,
    };
  }

  /**
   * Authoritative mapping rule:
   * Maps summary DEFENSE to goalkeeper_saves ONLY after the image is verified
   * as a goalkeeper detail screen and linked to a verified goalkeeper (FR-GK-003).
   */
  public static mapGoalkeeperSaves(defense_raw: number | null, isVerifiedKeeper: boolean): number | null {
    if (!isVerifiedKeeper || defense_raw === null || defense_raw === undefined) {
      return null;
    }
    return defense_raw;
  }
}
