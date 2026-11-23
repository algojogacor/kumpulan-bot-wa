/**
 * Flash Peak TMS - NVIDIA NIM Provider Adapter
 * 
 * Supports NVIDIA NIM OpenAI-compatible models (e.g. nvidia/nemotron-3.5-super-vl-120b-a12b
 * for vision OCR and nvidia/nemotron-3.5-lightning-30b-a3b for fast text)
 * with multi-key rotation, reasoning extraction, and JSON response format.
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

export interface NvidiaAdapterConfig {
  apiKey?: string;
  apiKeys?: string[];
  model?: string;
  textModel?: string;
  visionModel?: string;
  endpoint?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class NvidiaAdapter implements ProviderAdapter {
  public readonly name: AIProviderName = 'NVIDIA_NIM';
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

  constructor(config: NvidiaAdapterConfig = {}) {
    let rawKeys: string[] = [];
    if (config.apiKeys && config.apiKeys.length > 0) {
      rawKeys = [...config.apiKeys];
      if (config.apiKey && !rawKeys.includes(config.apiKey.trim())) {
        rawKeys.unshift(config.apiKey.trim());
      }
    } else if (config.apiKey) {
      rawKeys = [config.apiKey.trim()];
    } else {
      if (process.env.NVIDIA_API_KEYS) {
        rawKeys = process.env.NVIDIA_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
      }
      if (process.env.NVIDIA_API_KEY && !rawKeys.includes(process.env.NVIDIA_API_KEY.trim())) {
        rawKeys.unshift(process.env.NVIDIA_API_KEY.trim());
      }
    }
    this.apiKeys = rawKeys.filter(Boolean);

    this.visionModel = config.visionModel || process.env.NVIDIA_VISION_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b';
    this.textModel = config.textModel || process.env.NVIDIA_TEXT_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
    this.model = config.model || process.env.NVIDIA_MODEL || this.textModel;
    this.endpoint = config.endpoint || process.env.NVIDIA_ENDPOINT || 'https://integrate.api.nvidia.com/v1/chat/completions';
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
      throw new AIAuthenticationError(this.name, 'NVIDIA_API_KEY is not configured');
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
      payload.max_tokens = 1000;
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
          throw new AIAuthenticationError(this.name, `NVIDIA NIM authentication failed (${res.status}): ${sanitizedBody}`, res.status);
        }

        if (res.status === 429) {
          this.rotateKey();
          const lower = sanitizedBody.toLowerCase();
          if (lower.includes('quota') || lower.includes('insufficient_quota')) {
            throw new AIQuotaExceededError(this.name, `NVIDIA NIM quota exhausted: ${sanitizedBody}`, res.status);
          }
          throw new AIRateLimitError(this.name, `NVIDIA NIM rate limit: ${sanitizedBody}`, res.status);
        }

        throw new AIProviderUnavailableError(this.name, `NVIDIA NIM returned status ${res.status}: ${sanitizedBody}`, res.status);
      }

      const resJson = await res.json() as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = resJson.choices?.[0];
      if (!choice || !choice.message) {
        throw new AIMalformedResponseError(this.name, 'NVIDIA NIM response contained no choice');
      }

      const rawContent = choice.message.content || choice.message.reasoning_content || '';
      if (!rawContent) {
        throw new AIMalformedResponseError(this.name, 'NVIDIA NIM response message content is empty');
      }

      let parsedJson: T | undefined;
      if (request.structured_output) {
        try {
          const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
          parsedJson = JSON.parse(cleaned) as T;
        } catch {
          // Try regex extraction of JSON object if wrapped in thinking/reasoning
          const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsedJson = JSON.parse(jsonMatch[0]) as T;
            } catch {
              throw new AIMalformedResponseError(
                this.name,
                `Failed to parse JSON response from NVIDIA NIM: ${rawContent.slice(0, 100)}`
              );
            }
          } else {
            throw new AIMalformedResponseError(
              this.name,
              `Failed to parse JSON response from NVIDIA NIM: ${rawContent.slice(0, 100)}`
            );
          }
        }
      }

      return {
        raw_text: rawContent,
        parsed_json: parsedJson,
        telemetry: {
          provider: this.name,
          model: modelToUse,
          task_type: request.task,
          latency_ms: latencyMs,
          input_tokens: resJson.usage?.prompt_tokens ?? null,
          output_tokens: resJson.usage?.completion_tokens ?? null,
          status: 'SUCCESS',
          error_code: null,
        },
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AITimeoutError(this.name, 'NVIDIA NIM request timed out', timeoutMs);
      }
      if (err instanceof Error) {
        err.message = sanitizeSensitiveString(err.message, this.apiKeys);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
