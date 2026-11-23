/**
 * Flash Peak TMS - Google Gemini Provider Adapter
 * 
 * Supports Gemini multimodal models (e.g. gemini-1.5-flash, gemini-2.0-flash-exp)
 * with strict JSON response mode (responseMimeType: "application/json").
 * 
 * Rules:
 * - Uses x-goog-api-key header to prevent API key exposure in query strings/logs.
 * - Never log or expose API keys.
 * - Handles 400/403 (invalid key / auth), 429 (quota / rate limit), safety blocks, and timeouts.
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
  AISafetyError,
  AIMalformedResponseError,
  AIProviderUnavailableError,
  sanitizeSensitiveString,
} from '../adapter.js';

export interface GeminiAdapterConfig {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class GeminiAdapter implements ProviderAdapter {
  public readonly name: AIProviderName = 'GEMINI';
  public readonly model: string;
  public readonly capabilities: ProviderCapabilities = {
    vision: true,
    text: true,
    structured_output: true,
    max_image_dimensions: { width: 4096, height: 4096 },
    max_image_bytes: 20 * 1024 * 1024,
    supported_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
  };

  private readonly apiKey: string;
  private readonly endpoint?: string;
  private readonly defaultTimeoutMs: number;
  private readonly customFetch: typeof fetch;

  constructor(config: GeminiAdapterConfig = {}) {
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
    this.model = config.model || process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
    this.endpoint = config.endpoint || process.env.GEMINI_ENDPOINT;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 15000;
    this.customFetch = config.fetchFn ?? fetch;
  }

  public async healthCheck(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    return true;
  }

  public async execute<T = unknown>(request: AIRequest): Promise<AIResponse<T>> {
    if (!this.apiKey) {
      throw new AIAuthenticationError(this.name, 'GEMINI_API_KEY is not configured');
    }

    const timeoutMs = request.timeout_ms ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Build Gemini request payload
    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];

    parts.push({ text: request.prompt });

    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        parts.push({
          inline_data: {
            mime_type: img.mime_type || 'image/jpeg',
            data: img.base64,
          },
        });
      }
    }

    const payload: {
      contents: Array<{ role: string; parts: typeof parts }>;
      systemInstruction?: { parts: Array<{ text: string }> };
      generationConfig: {
        responseMimeType?: string;
        temperature: number;
      };
    } = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: request.temperature ?? 0.1,
      },
    };
    if (request.structured_output) {
      payload.generationConfig.responseMimeType = 'application/json';
    }

    if (request.system_prompt) {
      payload.systemInstruction = {
        parts: [{ text: request.system_prompt }],
      };
    }

    const url = this.endpoint
      ? this.endpoint
      : `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    const startTime = Date.now();

    try {
      const res = await this.customFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const rawErrorBody = await res.text().catch(() => '');
        const sanitizedBody = sanitizeSensitiveString(rawErrorBody, [this.apiKey]);

        if (res.status === 400 || res.status === 403) {
          if (sanitizedBody.includes('API_KEY_INVALID') || sanitizedBody.includes('PERMISSION_DENIED') || res.status === 403) {
            throw new AIAuthenticationError(this.name, `Gemini authentication failed (${res.status}): ${sanitizedBody}`, res.status);
          }
          if (sanitizedBody.includes('SAFETY') || sanitizedBody.includes('BLOCKED')) {
            throw new AISafetyError(this.name, `Gemini content blocked by safety policy: ${sanitizedBody}`);
          }
        }

        if (res.status === 429) {
          const lowerBody = sanitizedBody.toLowerCase();
          if (lowerBody.includes('quota') || lowerBody.includes('resource_exhausted')) {
            throw new AIQuotaExceededError(this.name, `Gemini quota exhausted: ${sanitizedBody}`, res.status);
          }
          throw new AIRateLimitError(this.name, `Gemini rate limit: ${sanitizedBody}`, res.status);
        }

        throw new AIProviderUnavailableError(this.name, `Gemini returned status ${res.status}: ${sanitizedBody}`, res.status);
      }

      const resJson = await res.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        promptFeedback?: { blockReason?: string };
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };

      if (resJson.promptFeedback?.blockReason) {
        throw new AISafetyError(this.name, `Gemini prompt blocked: ${resJson.promptFeedback.blockReason}`);
      }

      const candidate = resJson.candidates?.[0];
      if (candidate?.finishReason === 'SAFETY') {
        throw new AISafetyError(this.name, 'Gemini candidate blocked by safety filter');
      }

      const rawText = candidate?.content?.parts?.[0]?.text ?? '';
      if (!rawText) {
        throw new AIMalformedResponseError(this.name, 'Gemini returned empty candidate content');
      }

      let parsedJson: T | undefined;
      if (request.structured_output) {
        try {
          parsedJson = JSON.parse(rawText) as T;
        } catch {
          throw new AIMalformedResponseError(this.name, `Gemini JSON parsing failed: ${rawText.slice(0, 100)}`);
        }
      }

      return {
        raw_text: rawText,
        parsed_json: parsedJson,
        telemetry: {
          provider: this.name,
          model: this.model,
          task_type: request.task,
          latency_ms: latencyMs,
          input_tokens: resJson.usageMetadata?.promptTokenCount ?? null,
          output_tokens: resJson.usageMetadata?.candidatesTokenCount ?? null,
          status: 'SUCCESS',
          error_code: null,
        },
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AITimeoutError(this.name, 'Gemini request timed out', timeoutMs);
      }
      if (err instanceof Error) {
        err.message = sanitizeSensitiveString(err.message, [this.apiKey]);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
