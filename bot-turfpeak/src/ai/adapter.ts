/**
 * Flash Peak TMS - AI Provider Adapter Interface & Error Taxonomy
 * 
 * Defines common adapter contracts, capability declarations, error hierarchy,
 * bounded retry with backoff, latency/quota telemetry, and credential scrubbing.
 * 
 * Rules:
 * - Never log or expose API keys (AI_PIPELINE.md §8).
 * - Bounded retry halts immediately on 401/403, quota exhaustion, or safety policy.
 * - Default timeout: 15,000ms (15s).
 */

import {
  AIProviderName,
  AITaskType,
  AIRequestStatus,
} from '../shared/types/index.js';

export type { AIProviderName, AITaskType, AIRequestStatus };

// =============================================================================
// Capabilities & Telemetry Contracts
// =============================================================================

export interface ProviderCapabilities {
  vision: boolean;
  text: boolean;
  structured_output: boolean;
  max_image_dimensions?: { width: number; height: number };
  max_image_bytes?: number;
  supported_mime_types: string[];
}

export interface ProviderTelemetry {
  provider: AIProviderName;
  model: string;
  task_type: AITaskType;
  latency_ms: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  status: AIRequestStatus;
  error_code?: string | null;
}

// =============================================================================
// AI Error Taxonomy
// =============================================================================

export class AIError extends Error {
  public readonly provider: AIProviderName;
  public readonly statusCode?: number;
  public readonly retryable: boolean;
  public readonly code: string;

  constructor(options: {
    message: string;
    provider: AIProviderName;
    statusCode?: number;
    retryable?: boolean;
    code?: string;
  }) {
    super(options.message);
    this.name = this.constructor.name;
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.code = options.code ?? 'AI_ERROR';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AIAuthenticationError extends AIError {
  constructor(provider: AIProviderName, message = 'Invalid or missing API credentials', statusCode = 401) {
    super({
      message,
      provider,
      statusCode,
      retryable: false,
      code: 'AUTH_FAILED',
    });
  }
}

export class AIRateLimitError extends AIError {
  constructor(provider: AIProviderName, message = 'Rate limit reached, please retry later', statusCode = 429) {
    super({
      message,
      provider,
      statusCode,
      retryable: true,
      code: 'RATE_LIMITED',
    });
  }
}

export class AIQuotaExceededError extends AIError {
  constructor(provider: AIProviderName, message = 'Provider quota exhausted', statusCode = 429) {
    super({
      message,
      provider,
      statusCode,
      retryable: false, // Halts retries per AI_PIPELINE.md §8
      code: 'QUOTA_EXCEEDED',
    });
  }
}

export class AITimeoutError extends AIError {
  constructor(provider: AIProviderName, message = 'AI request timed out after deadline', timeoutMs = 15000) {
    super({
      message: `${message} (${timeoutMs}ms)`,
      provider,
      statusCode: 408,
      retryable: true,
      code: 'TIMEOUT',
    });
  }
}

export class AISafetyError extends AIError {
  constructor(provider: AIProviderName, message = 'Content blocked by provider safety policy') {
    super({
      message,
      provider,
      statusCode: 400,
      retryable: false, // Halts retries per AI_PIPELINE.md §8
      code: 'SAFETY_VIOLATION',
    });
  }
}

export class AIMalformedResponseError extends AIError {
  constructor(provider: AIProviderName, message = 'Failed to parse JSON response from AI provider') {
    super({
      message,
      provider,
      statusCode: 502,
      retryable: true,
      code: 'MALFORMED_RESPONSE',
    });
  }
}

export class AIProviderUnavailableError extends AIError {
  constructor(provider: AIProviderName, message = 'AI provider service is unavailable', statusCode = 503) {
    super({
      message,
      provider,
      statusCode,
      retryable: true,
      code: 'PROVIDER_UNAVAILABLE',
    });
  }
}

// =============================================================================
// Security: Redaction Utility
// =============================================================================

/**
 * Redacts sensitive API keys and secrets from strings, headers, and URLs.
 */
export function sanitizeSensitiveString(raw: string, sensitiveTokens: (string | undefined)[]): string {
  let sanitized = raw;

  // Redact standard Authorization bearer headers and query params like key=...
  sanitized = sanitized.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{6,}/gi, '$1[REDACTED_BEARER]');
  sanitized = sanitized.replace(/([?&]key=)[A-Za-z0-9_\-\.]{6,}/gi, '$1[REDACTED_KEY]');

  for (const token of sensitiveTokens) {
    if (token && token.length >= 4) {
      sanitized = sanitized.split(token).join('[REDACTED_API_KEY]');
    }
  }

  return sanitized;
}

// =============================================================================
// Request & Response Contracts
// =============================================================================

export interface AIImageInput {
  mime_type: string;
  base64: string;
  name?: string;
}

export interface AIRequest {
  task: AITaskType;
  system_prompt: string;
  prompt: string;
  images?: AIImageInput[];
  temperature?: number;
  timeout_ms?: number; // default: 15,000ms
  structured_output?: boolean; // default false (free-form text); true → force JSON output mode + parse
  correlation_id?: string;
}

export interface AIResponse<T = unknown> {
  raw_text: string;
  parsed_json?: T;
  telemetry: ProviderTelemetry;
}

// =============================================================================
// Common Provider Adapter Interface
// =============================================================================

export interface ProviderAdapter {
  readonly name: AIProviderName;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  healthCheck(): Promise<boolean>;
  execute<T = unknown>(request: AIRequest): Promise<AIResponse<T>>;
}

// =============================================================================
// Bounded Retry Execution Helper
// =============================================================================

export interface RetryOptions {
  maxRetries?: number; // default: 2 (total 3 attempts)
  initialBackoffMs?: number; // default: 200ms
  backoffFactor?: number; // default: 2.0
  sleepFn?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function executeWithRetry<T>(
  action: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const initialBackoffMs = options.initialBackoffMs ?? 200;
  const backoffFactor = options.backoffFactor ?? 2.0;
  const sleep = options.sleepFn ?? defaultSleep;

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    try {
      return await action(attempt);
    } catch (err: unknown) {
      lastError = err;

      // Halt immediately if error is explicitly non-retryable
      if (err instanceof AIError && !err.retryable) {
        throw err;
      }

      if (attempt >= maxRetries) {
        break;
      }

      const backoffMs = Math.round(initialBackoffMs * Math.pow(backoffFactor, attempt));
      await sleep(backoffMs);
      attempt++;
    }
  }

  throw lastError;
}
