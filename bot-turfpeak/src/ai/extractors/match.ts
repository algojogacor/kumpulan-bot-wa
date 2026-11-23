/**
 * Flash Peak TMS - Main Match Summary Extractor
 * 
 * Extracts scores, team sides, player performance rows, and raw Unicode nicknames.
 * Returns null for unreadable values, never hallucinates.
 * 
 * Per PROMPT_CATALOG.md §4, AI_PIPELINE.md §6.
 */

import { ProviderRouter } from '../router.js';
import {
  MAIN_MATCH_PROMPT,
  MainMatchExtractionOutput,
  mainMatchExtractionOutputSchema,
} from '../prompts/match.js';
import { ExtractedMatchSummaryData } from '../../shared/types/index.js';

export interface TrustedMatchContext {
  fixture_id?: string;
  team_a_name?: string;
  team_b_name?: string;
  expected_roster?: Array<{ nickname: string; team_id?: string }>;
}

export interface MatchExtractorOptions {
  trusted_context?: TrustedMatchContext;
  correlation_id?: string;
}

export class MatchSummaryExtractor {
  constructor(private readonly router: ProviderRouter) {}

  /**
   * Extracts match summary data from a MAIN_MATCH_SUMMARY screenshot.
   */
  public async extract(
    image: { mime_type: string; base64: string },
    options: MatchExtractorOptions = {}
  ): Promise<{
    raw_extraction: MainMatchExtractionOutput;
    summary_data: ExtractedMatchSummaryData;
  }> {
    if (!image.base64 || image.base64.trim().length === 0) {
      throw new Error('Image base64 payload is empty');
    }

    const contextJson = options.trusted_context
      ? JSON.stringify(options.trusted_context, null, 2)
      : undefined;

    const userPrompt = MAIN_MATCH_PROMPT.buildUserPrompt(contextJson);

    const response = await this.router.execute<unknown>({
      task: 'EXTRACT_MATCH',
      structured_output: true,
      system_prompt: MAIN_MATCH_PROMPT.system_prompt,
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

    const parsed = mainMatchExtractionOutputSchema.parse(response.parsed_json);

    // Build normalized ExtractedMatchSummaryData conforming to shared schema
    const summaryData: ExtractedMatchSummaryData = {
      team_a_score: parsed.team_a_score,
      team_b_score: parsed.team_b_score,
      team_a_players: parsed.team_a_players.map((p) => ({
        nickname_raw: p.nickname_raw, // Raw Unicode preserved unchanged!
        rating: p.rating,
        goals: p.goals,
        assists: p.assists,
        passes: p.passes,
        defense: p.defense,
      })),
      team_b_players: parsed.team_b_players.map((p) => ({
        nickname_raw: p.nickname_raw, // Raw Unicode preserved unchanged!
        rating: p.rating,
        goals: p.goals,
        assists: p.assists,
        passes: p.passes,
        defense: p.defense,
      })),
      confidence: parsed.confidence,
      unreadable_fields: parsed.unreadable_fields,
    };

    return {
      raw_extraction: parsed,
      summary_data: summaryData,
    };
  }
}
