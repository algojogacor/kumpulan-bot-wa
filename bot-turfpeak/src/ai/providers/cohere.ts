/**
 * Flash Peak TMS - Cohere Provider Adapter
 * 
 * Supports Cohere v2 API (https://api.cohere.com/v2/chat) with multi-key rotation,
 * command-a-reasoning-08-2025 for deep reasoning, and JSON response format.
 * 
 * Rules:
 * - Never log or expose API keys.
 * - Handles 401/403 (fatal), 429 (monthly quota vs rate limit), timeouts.
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

export interface CohereAdapterConfig {
  apiKey?: string;
  apiKeys?: string[];
  model?: string;
  textModel?: string;
  visionModel?: string;
  endpoint?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class CohereAdapter implements ProviderAdapter {
  public readonly name: AIProviderName = 'COHERE';
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

  constructor(config: CohereAdapterConfig = {}) {
    let rawKeys: string[] = [];
    if (config.apiKeys && config.apiKeys.length > 0) {
      rawKeys = [...config.apiKeys];
      if (config.apiKey && !rawKeys.includes(config.apiKey.trim())) {
        rawKeys.unshift(config.apiKey.trim());
      }
    } else if (config.apiKey) {
      rawKeys = [config.apiKey.trim()];
    } else {
      if (process.env.COHERE_API_KEYS) {
        rawKeys = process.env.COHERE_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
      }
      if (process.env.COHERE_API_KEY && !rawKeys.includes(process.env.COHERE_API_KEY.trim())) {
        rawKeys.unshift(process.env.COHERE_API_KEY.trim());
      }
    }
    this.apiKeys = rawKeys.filter(Boolean);

    this.textModel = config.textModel || process.env.COHERE_TEXT_MODEL || 'command-a-reasoning-08-2025';
    this.visionModel = config.visionModel || process.env.COHERE_VISION_MODEL || 'c4ai-aya-vision-32b';
    this.model = config.model || process.env.COHERE_MODEL || this.textModel;
    this.endpoint = config.endpoint || process.env.COHERE_ENDPOINT || 'https://api.cohere.com/v2/chat';
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 20000;
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
      throw new AIAuthenticationError(this.name, 'COHERE_API_KEY is not configured');
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
      response_format?: { type: 'json_object' };
    } = {
      model: modelToUse,
      messages,
      temperature: request.temperature ?? 0.1,
    };
    if (request.structured_output) {
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
          throw new AIAuthenticationError(this.name, `Cohere authentication failed (${res.status}): ${sanitizedBody}`, res.status);
        }

        if (res.status === 429) {
          this.rotateKey();
          if (sanitizedBody.includes('Trial key') || sanitizedBody.includes('monthly')) {
            throw new AIQuotaExceededError(this.name, `Cohere trial quota exceeded (429): ${sanitizedBody}`, res.status);
          }
          throw new AIRateLimitError(this.name, `Cohere rate limit reached (429): ${sanitizedBody}`, res.status);
        }

        if (res.status >= 500) {
          throw new AIProviderUnavailableError(this.name, `Cohere service unavailable (${res.status}): ${sanitizedBody}`, res.status);
        }

        throw new AIMalformedResponseError(this.name, `Cohere unexpected error (${res.status}): ${sanitizedBody}`);
      }

      const data = (await res.json()) as {
        id?: string;
        message?: {
          role?: string;
          content?: Array<{
            type?: string;
            text?: string;
            thinking?: string;
          }>;
        };
        usage?: {
          tokens?: {
            input_tokens?: number;
            output_tokens?: number;
          };
        };
      };

      const contentBlocks = data.message?.content;
      if (!contentBlocks || contentBlocks.length === 0) {
        throw new AIMalformedResponseError(this.name, 'Cohere returned empty message content');
      }

      const textBlock = contentBlocks.find((c) => c.type === 'text');
      const content = textBlock?.text || contentBlocks[0].text || '';
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
            `Failed to parse Cohere JSON response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Raw content: ${sanitizedContent.slice(0, 200)}`
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
          input_tokens: data.usage?.tokens?.input_tokens ?? null,
          output_tokens: data.usage?.tokens?.output_tokens ?? null,
          status: 'SUCCESS',
        },
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AITimeoutError(this.name, `Cohere request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
