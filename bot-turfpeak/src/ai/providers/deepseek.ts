/**
 * Flash Peak TMS - DeepSeek Provider Adapter
 * 
 * Supports DeepSeek models with focus on deepseek-flash (multimodal vision + text)
 * and deepseek-chat/deepseek-reasoner with OpenAI-compatible chat completions API.
 * 
 * Rules:
 * - Never log or expose API keys.
 * - Handles 401/403 (fatal), 402 (insufficient balance), 429 (rate limit), timeouts.
 */

import {
  AIProviderName,
  ProviderAdapter,
  ProviderCapabilities,
  AIRequest,
  AIResponse,
  AIAuthenticationError,
  AIRateLimitError,
  AIQuotaExceededError,
  AITimeoutError,
  AIMalformedResponseError,
  AIProviderUnavailableError,
  sanitizeSensitiveString,
} from '../adapter.js';

export interface DeepSeekAdapterConfig {
  apiKey?: string;
  apiKeys?: string[];
  model?: string;
  textModel?: string;
  visionModel?: string;
  endpoint?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class DeepSeekAdapter implements ProviderAdapter {
  public readonly name: AIProviderName = 'DEEPSEEK';
  public readonly model: string;
  public readonly textModel: string;
  public readonly visionModel: string;
  public readonly capabilities: ProviderCapabilities = {
    vision: true,
    text: true,
    structured_output: true,
    max_image_dimensions: { width: 4096, height: 4096 },
    max_image_bytes: 20 * 1024 * 1024,
    supported_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
  };

  private readonly apiKeys: string[];
  private keyIndex = 0;
  private readonly endpoint: string;
  private readonly defaultTimeoutMs: number;
  private readonly customFetch: typeof fetch;

  constructor(config: DeepSeekAdapterConfig = {}) {
    let rawKeys: string[] = [];
    if (config.apiKeys && config.apiKeys.length > 0) {
      rawKeys = [...config.apiKeys];
      if (config.apiKey && !rawKeys.includes(config.apiKey.trim())) {
        rawKeys.unshift(config.apiKey.trim());
      }
    } else if (config.apiKey) {
      rawKeys = [config.apiKey.trim()];
    } else {
      if (process.env.DEEPSEEK_API_KEYS) {
        rawKeys = process.env.DEEPSEEK_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
      }
      if (process.env.DEEPSEEK_API_KEY && !rawKeys.includes(process.env.DEEPSEEK_API_KEY.trim())) {
        rawKeys.unshift(process.env.DEEPSEEK_API_KEY.trim());
      }
    }
    this.apiKeys = rawKeys.filter(Boolean);

    // Default to deepseek-flash as per organizer instruction
    this.visionModel = config.visionModel || process.env.DEEPSEEK_VISION_MODEL || 'deepseek-flash';
    this.textModel = config.textModel || process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-flash';
    this.model = config.model || process.env.DEEPSEEK_MODEL || 'deepseek-flash';
    this.endpoint = config.endpoint || process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions';
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 15000;
    this.customFetch = config.fetchFn ?? fetch;
  }

  public getActiveApiKey(): string {
    if (this.apiKeys.length === 0) return '';
    return this.apiKeys[this.keyIndex % this.apiKeys.length];
  }

  public rotateKey(): string {
    if (this.apiKeys.length <= 1) return this.getActiveApiKey();
    this.keyIndex = (this.keyIndex + 1) % this.apiKeys.length;
    return this.getActiveApiKey();
  }

  public async healthCheck(): Promise<boolean> {
    return this.apiKeys.length > 0;
  }

  public async execute<T = unknown>(request: AIRequest): Promise<AIResponse<T>> {
    const activeKey = this.getActiveApiKey();
    if (!activeKey) {
      throw new AIAuthenticationError(this.name, 'DEEPSEEK_API_KEY is not configured');
    }

    const timeoutMs = request.timeout_ms ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const isVision = Boolean(request.images && request.images.length > 0);
    const modelToUse = isVision ? this.visionModel : (this.textModel || this.model);

    const messages: Array<{ role: string; content: unknown }> = [];

    if (request.system_prompt) {
      messages.push({ role: 'system', content: request.system_prompt });
    }

    if (isVision && request.images) {
      const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: request.prompt },
      ];

      for (const img of request.images) {
        const mime = img.mime_type || 'image/jpeg';
        const url = img.base64.startsWith('data:')
          ? img.base64
          : `data:${mime};base64,${img.base64}`;
        userContent.push({
          type: 'image_url',
          image_url: { url },
        });
      }

      messages.push({
        role: 'user',
        content: userContent,
      });
    } else {
      messages.push({ role: 'user', content: request.prompt });
    }

    const payload: {
      model: string;
      messages: typeof messages;
      temperature: number;
      max_tokens?: number;
      response_format?: { type: 'json_object' };
    } = {
      model: modelToUse,
      messages,
      temperature: request.temperature ?? 0.1,
    };

    if (isVision) {
      payload.max_tokens = 1500;
    } else if (request.structured_output) {
      payload.response_format = { type: 'json_object' };
    }

    const startTime = Date.now();

    try {
      const res = await this.customFetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const rawErrorBody = await res.text().catch(() => '');
        const sanitizedBody = sanitizeSensitiveString(rawErrorBody, this.apiKeys);

        if (res.status === 401 || res.status === 403) {
          throw new AIAuthenticationError(this.name, `DeepSeek authentication failed (${res.status}): ${sanitizedBody}`, res.status);
        }

        if (res.status === 402 || sanitizedBody.includes('Insufficient Balance')) {
          throw new AIQuotaExceededError(this.name, `DeepSeek insufficient balance (402): ${sanitizedBody}`, res.status);
        }

        if (res.status === 429) {
          this.rotateKey();
          throw new AIRateLimitError(this.name, `DeepSeek rate limit reached (429): ${sanitizedBody}`, res.status);
        }

        if (res.status >= 500) {
          throw new AIProviderUnavailableError(this.name, `DeepSeek service unavailable (${res.status}): ${sanitizedBody}`, res.status);
        }

        throw new AIMalformedResponseError(this.name, `DeepSeek unexpected error (${res.status}): ${sanitizedBody}`);
      }

      const data = (await res.json()) as {
        id?: string;
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
          };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const choice = data.choices?.[0];
      if (!choice || (!choice.message?.content && !choice.message?.reasoning_content)) {
        throw new AIMalformedResponseError(this.name, 'DeepSeek returned empty choices or null message content');
      }

      const content = choice.message?.content || choice.message?.reasoning_content || '';
      const sanitizedContent = sanitizeSensitiveString(content, this.apiKeys);

      let parsedPayload: T | undefined;
      if (request.structured_output) {
        try {
          let cleaned = sanitizedContent.trim();
          if (cleaned.startsWith('```json')) {
            cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
          } else if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
          }
          parsedPayload = JSON.parse(cleaned) as T;
        } catch (parseErr) {
          throw new AIMalformedResponseError(
            this.name,
            `Failed to parse DeepSeek JSON response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Raw content: ${sanitizedContent.slice(0, 200)}`
          );
        }
      }

      return {
        raw_text: content,
        parsed_json: parsedPayload,
        telemetry: {
          provider: this.name,
          model: modelToUse,
          task_type: request.task,
          latency_ms: latencyMs,
          input_tokens: data.usage?.prompt_tokens ?? null,
          output_tokens: data.usage?.completion_tokens ?? null,
          status: 'SUCCESS',
        },
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AITimeoutError(this.name, `DeepSeek request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
