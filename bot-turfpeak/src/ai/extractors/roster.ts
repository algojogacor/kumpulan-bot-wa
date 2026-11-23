/**
 * Flash Peak TMS - AI Roster Extractor
 * 
 * Extracts esports tournament team roster information from natural language messages.
 * Uses ProviderRouter with task 'PARSE_ROSTER'.
 * Preserves clan tags (e.g. "AVO | Zenyth") without splitting on pipes '|'.
 */

import { ProviderRouter } from '../router.js';
import {
  ROSTER_EXTRACTION_PROMPT,
  RosterExtractionOutput,
  rosterExtractionOutputSchema,
} from '../prompts/roster.js';

export interface RosterExtractorOptions {
  correlation_id?: string;
  timeout_ms?: number;
}

export class RosterExtractor {
  constructor(private readonly router: ProviderRouter) {}

  /**
   * Extracts team name, goalkeeper, starters, and substitutes from a raw roster message.
   */
  public async extract(
    text: string,
    options: RosterExtractorOptions = {}
  ): Promise<RosterExtractionOutput> {
    const raw = text.trim();
    if (!raw) {
      return {
        team_name: null,
        gk_name: null,
        starter_list: [],
        sub_list: [],
        confidence: 0,
        uncertainties: ['Empty message payload'],
      };
    }

    const userPrompt = ROSTER_EXTRACTION_PROMPT.buildUserPrompt(raw);

    const response = await this.router.execute<unknown>({
      task: 'PARSE_ROSTER',
      structured_output: true,
      system_prompt: ROSTER_EXTRACTION_PROMPT.system_prompt,
      prompt: userPrompt,
      correlation_id: options.correlation_id,
      temperature: 0.1,
      timeout_ms: options.timeout_ms ?? 15000,
    });

    const parsed = rosterExtractionOutputSchema.parse(response.parsed_json);
    return parsed;
  }
}
