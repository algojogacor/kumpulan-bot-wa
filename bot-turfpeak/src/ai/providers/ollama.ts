/**
 * Flash Peak TMS - Ollama / Ollama Cloud Provider Adapter
 * 
 * Supports Ollama / Ollama Cloud vision models (e.g. llama3.2-vision)
 * via REST API (/api/chat) with format: "json" output.
 * 
 * Rules:
 * - Supports both local Ollama and Ollama Cloud (with Bearer token).
 * - Never log or expose API keys.
 * - Handles connection failures, timeouts, 401/403, and JSON parsing.
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

export interface OllamaAdapterConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class OllamaAdapter implements ProviderAdapter {
  public readonly name: AIProviderName = 'OLLAMA_CLOUD';
  public readonly model: string;
  public readonly capabilities: ProviderCapabilities = {
    vision: true,
    text: true,
    structured_output: true,
    max_image_dimensions: { width: 4096, height: 4096 },
    max_image_bytes: 20 * 1024 * 1024,
    supported_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
  };

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultTimeoutMs: number;
  private readonly customFetch: typeof fetch;

  constructor(config: OllamaAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
    this.apiKey = config.apiKey || process.env.OLLAMA_API_KEY;
    this.model = config.model || process.env.OLLAMA_MODEL || 'llama3.2-vision';
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 15000;
    this.customFetch = config.fetchFn ?? fetch;
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const res = await this.customFetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  public async execute<T = unknown>(request: AIRequest): Promise<AIResponse<T>> {
    const timeoutMs = request.timeout_ms ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Build chat messages
    const messages: Array<{ role: string; content: string; images?: string[] }> = [];

    if (request.system_prompt) {
      messages.push({
        role: 'system',
        content: request.system_prompt,
      });
    }

    const userMessage: { role: string; content: string; images?: string[] } = {
      role: 'user',
      content: request.prompt,
    };

    if (request.images && request.images.length > 0) {
      userMessage.images = request.images.map((img) => img.base64);
    }

    messages.push(userMessage);

    const payload = {
      model: this.model,
      messages,
      format: 'json',
      stream: false,
      options: {
        temperature: request.temperature ?? 0.1,
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const endpoint = `${this.baseUrl}/api/chat`;
    const startTime = Date.now();

    try {
      const res = await this.customFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const rawErrorBody = await res.text().catch(() => '');
        const sanitizedBody = sanitizeSensitiveString(rawErrorBody, [this.apiKey]);

        if (res.status === 401 || res.status === 403) {
          throw new AIAuthenticationError(this.name, `Ollama authentication failed (${res.status}): ${sanitizedBody}`, res.status);
        }

        if (res.status === 429) {
          const lowerBody = sanitizedBody.toLowerCase();
          if (lowerBody.includes('quota')) {
            throw new AIQuotaExceededError(this.name, `Ollama quota exhausted: ${sanitizedBody}`, res.status);
          }
          throw new AIRateLimitError(this.name, `Ollama rate limit: ${sanitizedBody}`, res.status);
        }

        throw new AIProviderUnavailableError(this.name, `Ollama returned status ${res.status}: ${sanitizedBody}`, res.status);
      }

      const resJson = await res.json() as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };

      const rawText = resJson.message?.content ?? '';
      if (!rawText) {
        throw new AIMalformedResponseError(this.name, 'Ollama returned empty response message');
      }

      let parsedJson: T | undefined;
      try {
        parsedJson = JSON.parse(rawText) as T;
      } catch {
        throw new AIMalformedResponseError(this.name, `Ollama JSON parsing failed: ${rawText.slice(0, 100)}`);
      }

      return {
        raw_text: rawText,
        parsed_json: parsedJson,
        telemetry: {
          provider: this.name,
          model: this.model,
          task_type: request.task,
          latency_ms: latencyMs,
          input_tokens: resJson.prompt_eval_count ?? null,
          output_tokens: resJson.eval_count ?? null,
          status: 'SUCCESS',
          error_code: null,
        },
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AITimeoutError(this.name, 'Ollama request timed out', timeoutMs);
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
