/**
 * Flash Peak TMS - Multi-Provider AI Router
 * 
 * Implements load balancing, rotation across Groq + Gemini + Ollama Cloud,
 * fallback chain, circuit breaker with cooldown windows, and manual fallback
 * when all providers fail (D-010, O-010, FR-FAIL-002, PROMPT_CATALOG.md §9).
 * 
 * Rules:
 * - Rotate across healthy providers.
 * - Circuit breaker trips on consecutive failures or immediately on fatal errors (401/403, quota).
 * - Halts retries immediately on auth, quota, or safety policy errors.
 * - If all providers fail: activate manual mode with authoritative fallback message.
 */

import {
  AIProviderName,
  ProviderAdapter,
  AIRequest,
  AIResponse,
  AIError,
  AIAuthenticationError,
  AIQuotaExceededError,
  AISafetyError,
  ProviderTelemetry,
  executeWithRetry,
} from './adapter.js';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  lastFailureTime: number;
  lastError?: string;
}

export interface RouterConfig {
  adapters: ProviderAdapter[];
  consecutiveFailureThreshold?: number; // default: 3
  cooldownWindowMs?: number; // default: 60,000ms
  maxRetriesPerProvider?: number; // default: 1
  prioritizeByTask?: boolean; // default: false
  onTelemetry?: (telemetry: ProviderTelemetry) => void | Promise<void>;
}

export class AllProvidersFailedError extends AIError {
  public readonly errors: Array<{ provider: AIProviderName; error: unknown }>;
  public readonly manual_mode_required = true;
  public readonly fallback_message: string;

  constructor(errors: Array<{ provider: AIProviderName; error: unknown }>) {
    const fallbackMsg =
      'Automated screenshot processing is temporarily unavailable. ' +
      'The report has not been confirmed or changed. ' +
      'Please contact the tournament organizer for manual verification.';
    super({
      message: `All AI providers failed. Manual mode required. Details: ${errors
        .map((e) => `${e.provider}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
        .join('; ')}`,
      provider: errors[0]?.provider ?? 'GROQ',
      statusCode: 503,
      retryable: false,
      code: 'MANUAL_MODE_REQUIRED',
    });
    this.errors = errors;
    this.fallback_message = fallbackMsg;
  }
}

export class ProviderRouter {
  private readonly adapters: ProviderAdapter[];
  private readonly failureThreshold: number;
  private readonly cooldownWindowMs: number;
  private readonly maxRetriesPerProvider: number;
  private readonly onTelemetry?: (telemetry: ProviderTelemetry) => void | Promise<void>;

  private breakerStatuses: Map<AIProviderName, CircuitBreakerStatus> = new Map();
  private rotationIndex = 0;
  private readonly prioritizeByTask: boolean;

  constructor(config: RouterConfig) {
    if (!config.adapters || config.adapters.length === 0) {
      throw new Error('ProviderRouter requires at least one ProviderAdapter');
    }
    this.adapters = [...config.adapters];
    this.failureThreshold = config.consecutiveFailureThreshold ?? 3;
    this.cooldownWindowMs = config.cooldownWindowMs ?? 60000;
    this.maxRetriesPerProvider = config.maxRetriesPerProvider ?? 1;
    this.prioritizeByTask = config.prioritizeByTask ?? false;
    this.onTelemetry = config.onTelemetry;

    for (const adapter of this.adapters) {
      this.breakerStatuses.set(adapter.name, {
        state: 'CLOSED',
        consecutiveFailures: 0,
        lastFailureTime: 0,
      });
    }
  }

  /**
   * Returns current status of all circuit breakers.
   */
  public getCircuitBreakerStatuses(): Record<string, CircuitBreakerStatus> {
    const result: Record<string, CircuitBreakerStatus> = {};
    for (const [name, status] of this.breakerStatuses.entries()) {
      result[name] = { ...status };
    }
    return result;
  }

  /**
   * Resets all circuit breakers to CLOSED.
   */
  public resetCircuitBreakers(): void {
    for (const [name] of this.breakerStatuses.entries()) {
      this.breakerStatuses.set(name, {
        state: 'CLOSED',
        consecutiveFailures: 0,
        lastFailureTime: 0,
      });
    }
  }

  /**
   * Checks if an adapter is currently available to accept requests.
   */
  private isAdapterAvailable(name: AIProviderName, now: number): boolean {
    const status = this.breakerStatuses.get(name);
    if (!status) return false;

    if (status.state === 'CLOSED') {
      return true;
    }

    if (status.state === 'OPEN') {
      if (now - status.lastFailureTime >= this.cooldownWindowMs) {
        status.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }

    if (status.state === 'HALF_OPEN') {
      return true;
    }

    return false;
  }

  /**
   * Records success for an adapter, closing circuit breaker if previously OPEN or HALF_OPEN.
   */
  private recordSuccess(name: AIProviderName): void {
    const status = this.breakerStatuses.get(name);
    if (status) {
      status.state = 'CLOSED';
      status.consecutiveFailures = 0;
      status.lastError = undefined;
    }
  }

  /**
   * Records failure for an adapter, updating failure count and potentially tripping circuit breaker.
   */
  private recordFailure(name: AIProviderName, error: unknown): void {
    const status = this.breakerStatuses.get(name);
    if (!status) return;

    status.consecutiveFailures++;
    status.lastFailureTime = Date.now();
    status.lastError = error instanceof Error ? error.message : String(error);

    // Fatal non-retryable errors immediately trip circuit breaker to OPEN
    const isFatal =
      error instanceof AIAuthenticationError ||
      error instanceof AIQuotaExceededError ||
      error instanceof AISafetyError;

    if (isFatal || status.consecutiveFailures >= this.failureThreshold || status.state === 'HALF_OPEN') {
      status.state = 'OPEN';
    }
  }

  /**
   * Obtains the list of adapters ordered for the next request based on task priority or rotation.
   */
  private getOrderedAdapters(isVision = false): ProviderAdapter[] {
    const now = Date.now();

    if (this.prioritizeByTask) {
      const priorityOrder: AIProviderName[] = isVision
        ? ['DEEPSEEK', 'GROQ', 'GEMINI', 'NVIDIA_NIM', 'COHERE', 'OLLAMA_CLOUD']
        : ['MISTRAL', 'GROQ', 'NVIDIA_NIM', 'COHERE', 'GEMINI', 'DEEPSEEK', 'OLLAMA_CLOUD'];

      const sorted = [...this.adapters].sort((a, b) => {
        let idxA = priorityOrder.indexOf(a.name);
        let idxB = priorityOrder.indexOf(b.name);
        if (idxA === -1) idxA = 999;
        if (idxB === -1) idxB = 999;
        return idxA - idxB;
      });

      const available = sorted.filter((a) => this.isAdapterAvailable(a.name, now));
      const unavailable = sorted.filter((a) => !this.isAdapterAvailable(a.name, now));
      return [...available, ...unavailable];
    }

    const count = this.adapters.length;
    const startIndex = this.rotationIndex % count;
    this.rotationIndex = (this.rotationIndex + 1) % count;

    // Build rotated list starting from startIndex
    const rotated: ProviderAdapter[] = [];
    for (let i = 0; i < count; i++) {
      const idx = (startIndex + i) % count;
      rotated.push(this.adapters[idx]);
    }

    // Separate into available vs tripped
    const available = rotated.filter((a) => this.isAdapterAvailable(a.name, now));
    const unavailable = rotated.filter((a) => !this.isAdapterAvailable(a.name, now));

    return [...available, ...unavailable];
  }

  /**
   * Executes an AI request across the rotating provider pool with fallback chain.
   */
  public async execute<T = unknown>(request: AIRequest): Promise<AIResponse<T>> {
    const isVision = Boolean(request.images && request.images.length > 0);
    const ordered = this.getOrderedAdapters(isVision);
    const errors: Array<{ provider: AIProviderName; error: unknown }> = [];
    const now = Date.now();

    for (const adapter of ordered) {
      // If adapter circuit breaker is OPEN and cooldown has not expired, skip it
      if (!this.isAdapterAvailable(adapter.name, now)) {
        continue;
      }

      // Check capabilities for task
      if (request.images && request.images.length > 0 && !adapter.capabilities.vision) {
        continue;
      }

      try {
        const response = await executeWithRetry(
          () => adapter.execute<T>(request),
          {
            maxRetries: this.maxRetriesPerProvider,
            initialBackoffMs: 200,
          }
        );

        this.recordSuccess(adapter.name);

        if (this.onTelemetry) {
          try {
            await this.onTelemetry(response.telemetry);
          } catch {
            // Ignore telemetry recording failures
          }
        }

        return response;
      } catch (err: unknown) {
        this.recordFailure(adapter.name, err);
        errors.push({ provider: adapter.name, error: err });

        if (this.onTelemetry) {
          try {
            await this.onTelemetry({
              provider: adapter.name,
              model: adapter.model,
              task_type: request.task,
              latency_ms: 0,
              input_tokens: null,
              output_tokens: null,
              status: 'ERROR',
              error_code: err instanceof AIError ? err.code : 'UNKNOWN_ERROR',
            });
          } catch {
            // Ignore telemetry recording failures
          }
        }

        // Check if error is fatal to retrying this specific provider (auth, quota, safety)
        // Router will proceed to next provider in fallback chain
      }
    }

    // All available providers failed
    throw new AllProvidersFailedError(errors);
  }
}
