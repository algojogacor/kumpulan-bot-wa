/**
 * Flash Peak TMS - Image Evidence Classifier
 * 
 * Classifies screenshot evidence into:
 * - MAIN_MATCH_SUMMARY
 * - INDIVIDUAL_PLAYER_DETAIL
 * - UNKNOWN_OR_UNRELATED
 * - UNREADABLE
 * 
 * Per PROMPT_CATALOG.md §3 & AI_PIPELINE.md §2.
 * 
 * Rule: Never classify purely based on caption alone.
 */

import { ProviderRouter } from './router.js';
import {
  IMAGE_CLASSIFIER_PROMPT,
  ImageClassifierOutput,
  imageClassifierOutputSchema,
} from './prompts/classifier.js';

export interface ClassifyImageOptions {
  caption?: string | null;
  correlation_id?: string;
}

export class ImageClassifier {
  constructor(private readonly router: ProviderRouter) {}

  /**
   * Classifies an inbound screenshot image.
   * 
   * Enforces: Never classify purely based on caption alone.
   * If image data is empty or invalid, returns UNREADABLE.
   */
  public async classify(
    image: { mime_type: string; base64: string },
    options: ClassifyImageOptions = {}
  ): Promise<ImageClassifierOutput> {
    // Input guard: image cannot be empty or invalid
    if (!image.base64 || image.base64.trim().length === 0) {
      return {
        screen_type: 'UNREADABLE',
        confidence: 1.0,
        reason: 'Image payload is empty or missing binary data. Cannot classify based on caption alone.',
        visual_features: [],
        uncertainties: ['Image payload empty'],
      };
    }

    const userPrompt = IMAGE_CLASSIFIER_PROMPT.buildUserPrompt(options.caption);

    const response = await this.router.execute<unknown>({
      task: 'CLASSIFY',
      structured_output: true,
      system_prompt: IMAGE_CLASSIFIER_PROMPT.system_prompt,
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

    const parsed = imageClassifierOutputSchema.parse(response.parsed_json);
    return parsed;
  }
}
