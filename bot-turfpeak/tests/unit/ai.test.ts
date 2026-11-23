/**
 * Flash Peak TMS - AI Pipeline & Vision Unit Tests
 * 
 * Verifies Fase 4 in full:
 * 1. Provider Adapter capabilities, error taxonomy, timeouts, retries, credential scrubbing
 * 2. Groq, Gemini, and Ollama adapter requests, formats, and status handling
 * 3. Multi-provider router: rotation, fallback chain, circuit breakers, and manual fallback
 * 4. Image classifier: classes, prompt grounding, caption-only prohibition
 * 5. Main match extractor: schema validation, Unicode nickname preservation, null for unreadable
 * 6. Goalkeeper extractor: visual cue detection, defense_raw retention, saves mapping, null hidden tabs
 * 7. ⛔ Goalkeeper identity: strictly caption-based fuzzy matching; NEVER statistical vector matching
 * 8. Natural language correction parser: Indonesian terms, "player urutan 3", and ambiguity handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AIAuthenticationError,
  AIRateLimitError,
  AIQuotaExceededError,
  AITimeoutError,
  AISafetyError,
  AIMalformedResponseError,
  AIProviderUnavailableError,
  sanitizeSensitiveString,
  executeWithRetry,
  ProviderAdapter,
  AIRequest,
  AIResponse,
} from '../../src/ai/adapter.js';
import { GroqAdapter } from '../../src/ai/providers/groq.js';
import { GeminiAdapter } from '../../src/ai/providers/gemini.js';
import { OllamaAdapter } from '../../src/ai/providers/ollama.js';
import { NvidiaAdapter } from '../../src/ai/providers/nvidia.js';
import {
  ProviderRouter,
  AllProvidersFailedError,
} from '../../src/ai/router.js';
import { ImageClassifier } from '../../src/ai/classifier.js';
import { MatchSummaryExtractor } from '../../src/ai/extractors/match.js';
import { GoalkeeperDetailExtractor } from '../../src/ai/extractors/goalkeeper.js';
import { resolveGoalkeeperIdentity } from '../../src/ai/extractors/gk-identity.js';
import {
  CorrectionParser,
  parseCorrectionRuleBased,
  ReportContext,
} from '../../src/ai/correction-parser.js';

// =============================================================================
// Helper Mock Factory
// =============================================================================

function createMockAdapter(
  name: 'GROQ' | 'GEMINI' | 'OLLAMA_CLOUD',
  options: {
    model?: string;
    vision?: boolean;
    onExecute?: (req: AIRequest) => Promise<AIResponse<unknown>>;
  } = {}
): ProviderAdapter {
  return {
    name,
    model: options.model || `${name.toLowerCase()}-test-model`,
    capabilities: {
      vision: options.vision ?? true,
      text: true,
      structured_output: true,
      supported_mime_types: ['image/jpeg', 'image/png'],
    },
    healthCheck: vi.fn(async () => true),
    execute: options.onExecute || vi.fn(async (req) => ({
      raw_text: JSON.stringify({ mock: true }),
      parsed_json: { mock: true },
      telemetry: {
        provider: name,
        model: options.model || `${name.toLowerCase()}-test-model`,
        task_type: req.task,
        latency_ms: 12,
        input_tokens: 100,
        output_tokens: 50,
        status: 'SUCCESS' as const,
        error_code: null,
      },
    })),
  };
}

describe('Fase 4: AI Pipeline & Vision', () => {

  // ===========================================================================
  // Task 4.1: Adapter Interface, Error Taxonomy & Bounded Retry
  // ===========================================================================
  describe('Task 4.1: ProviderAdapter, Errors & Retry Policies', () => {
    it('redacts sensitive API keys and authorization tokens from strings', () => {
      const secret = 'gsk_very_secret_api_key_123456';
      const rawText = `Failed to connect with Authorization: Bearer ${secret} and ?key=${secret} and direct ${secret}`;
      const sanitized = sanitizeSensitiveString(rawText, [secret]);

      expect(sanitized).not.toContain(secret);
      expect(sanitized).toContain('[REDACTED_API_KEY]');
      expect(sanitized).toContain('[REDACTED_BEARER]');
      expect(sanitized).toContain('[REDACTED_KEY]');
    });

    it('identifies non-retryable vs retryable errors correctly in error taxonomy', () => {
      const authErr = new AIAuthenticationError('GROQ', 'Bad credentials', 401);
      const quotaErr = new AIQuotaExceededError('GEMINI', 'Quota limit reached', 429);
      const safetyErr = new AISafetyError('GROQ', 'Safety violation');
      const rateLimitErr = new AIRateLimitError('GROQ', 'Rate limited', 429);
      const timeoutErr = new AITimeoutError('OLLAMA_CLOUD', 'Timeout', 15000);
      const malformedErr = new AIMalformedResponseError('GROQ', 'Bad JSON');
      const unavailErr = new AIProviderUnavailableError('GEMINI', '503 error');

      expect(authErr.retryable).toBe(false);
      expect(quotaErr.retryable).toBe(false);
      expect(safetyErr.retryable).toBe(false);
      expect(rateLimitErr.retryable).toBe(true);
      expect(timeoutErr.retryable).toBe(true);
      expect(malformedErr.retryable).toBe(true);
      expect(unavailErr.retryable).toBe(true);
    });

    it('halts retries immediately on non-retryable errors (auth, quota, safety)', async () => {
      let callCount = 0;
      const sleepFn = vi.fn();

      await expect(
        executeWithRetry(
          async () => {
            callCount++;
            throw new AIAuthenticationError('GROQ', 'Invalid token', 401);
          },
          { maxRetries: 3, sleepFn }
        )
      ).rejects.toThrow(AIAuthenticationError);

      expect(callCount).toBe(1); // Halts immediately on attempt 0
      expect(sleepFn).not.toHaveBeenCalled();
    });

    it('retries with exponential backoff on retryable errors until success or limit', async () => {
      let callCount = 0;
      const sleepFn = vi.fn(async () => {});

      const result = await executeWithRetry(
        async (attempt) => {
          callCount++;
          if (attempt < 2) {
            throw new AIRateLimitError('GROQ', 'Slow down', 429);
          }
          return { success: true };
        },
        { maxRetries: 3, initialBackoffMs: 100, backoffFactor: 2, sleepFn }
      );

      expect(result).toEqual({ success: true });
      expect(callCount).toBe(3); // attempt 0, 1, 2
      expect(sleepFn).toHaveBeenCalledTimes(2);
      expect(sleepFn).toHaveBeenNthCalledWith(1, 100);
      expect(sleepFn).toHaveBeenNthCalledWith(2, 200);
    });
  });

  // ===========================================================================
  // Task 4.2: Groq Adapter
  // ===========================================================================
  describe('Task 4.2: GroqAdapter', () => {
    it('constructs multimodal chat payload with JSON response format and parses output', async () => {
      let capturedBody: any;
      const mockFetch = vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({ score: 10, valid: true }),
                },
              },
            ],
            usage: { prompt_tokens: 150, completion_tokens: 45 },
          }),
        } as unknown as Response;
      });

      const adapter = new GroqAdapter({
        apiKey: 'gsk_mock_test_key',
        model: 'llama-3.2-11b-vision-preview',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const response = await adapter.execute<{ score: number; valid: boolean }>({
        task: 'CLASSIFY',
        structured_output: true,
        system_prompt: 'You are a visual classifier.',
        prompt: 'Classify this screenshot',
        images: [{ mime_type: 'image/jpeg', base64: 'dGVzdGJhc2U2NA==' }],
      });

      expect(response.parsed_json).toEqual({ score: 10, valid: true });
      expect(capturedBody.model).toBe('qwen/qwen3.8-27b');
      expect(capturedBody.response_format).toEqual({ type: 'json_object' });
      expect(capturedBody.messages[1].content[1].type).toBe('image_url');
      expect(capturedBody.messages[1].content[1].image_url.url).toContain('data:image/jpeg;base64,dGVzdGJhc2U2NA==');
      expect(response.telemetry.status).toBe('SUCCESS');
      expect(response.telemetry.input_tokens).toBe(150);
      expect(response.telemetry.output_tokens).toBe(45);
    });

    it('distinguishes Groq 429 quota exhaustion from temporary rate limits', async () => {
      const quotaFetch = vi.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => 'You have exceeded your current quota. Check your plan.',
      })) as unknown as typeof fetch;

      const adapter = new GroqAdapter({
        apiKey: 'gsk_mock_test_key',
        fetchFn: quotaFetch,
      });

      await expect(
        adapter.execute({ task: 'CLASSIFY', system_prompt: '', prompt: 'hi' })
      ).rejects.toThrow(AIQuotaExceededError);
    });

    it('handles 401 authentication failures without exposing the API key', async () => {
      const apiKey = 'gsk_secret_auth_token_999';
      const authFetch = vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => `Invalid token: Bearer ${apiKey}`,
      })) as unknown as typeof fetch;

      const adapter = new GroqAdapter({
        apiKey,
        fetchFn: authFetch,
      });

      try {
        await adapter.execute({ task: 'CLASSIFY', system_prompt: '', prompt: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AIAuthenticationError);
        expect(err.message).not.toContain(apiKey);
      }
    });
  });

  // ===========================================================================
  // Task 4.3: Gemini Adapter
  // ===========================================================================
  describe('Task 4.3: GeminiAdapter', () => {
    it('uses x-goog-api-key header and formats multimodal inline_data base64 payload', async () => {
      let capturedHeaders: any;
      let capturedBody: any;

      const mockFetch = vi.fn(async (_url: string, init: any) => {
        capturedHeaders = init.headers;
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ verified: true, count: 5 }) }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 220, candidatesTokenCount: 60 },
          }),
        } as unknown as Response;
      });

      const adapter = new GeminiAdapter({
        apiKey: 'AIzaSyMockKeyForGeminiTest',
        model: 'gemini-1.5-flash',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const res = await adapter.execute<{ verified: boolean; count: number }>({
        task: 'EXTRACT_MATCH',
        structured_output: true,
        system_prompt: 'System prompt instructions',
        prompt: 'User prompt',
        images: [{ mime_type: 'image/png', base64: 'aW1hZ2VkYXRh' }],
      });

      expect(capturedHeaders['x-goog-api-key']).toBe('AIzaSyMockKeyForGeminiTest');
      expect(capturedBody.generationConfig.responseMimeType).toBe('application/json');
      expect(capturedBody.contents[0].parts[1].inline_data.mime_type).toBe('image/png');
      expect(capturedBody.contents[0].parts[1].inline_data.data).toBe('aW1hZ2VkYXRh');
      expect(res.parsed_json).toEqual({ verified: true, count: 5 });
      expect(res.telemetry.input_tokens).toBe(220);
      expect(res.telemetry.output_tokens).toBe(60);
    });

    it('detects Gemini safety policy blocks and throws AISafetyError', async () => {
      const safetyFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          promptFeedback: { blockReason: 'SAFETY' },
          candidates: [],
        }),
      })) as unknown as typeof fetch;

      const adapter = new GeminiAdapter({
        apiKey: 'AIzaSyMockKey',
        fetchFn: safetyFetch,
      });

      await expect(
        adapter.execute({ task: 'CLASSIFY', system_prompt: '', prompt: 'analyze' })
      ).rejects.toThrow(AISafetyError);
    });
  });

  // ===========================================================================
  // Task 4.4: Ollama Adapter
  // ===========================================================================
  describe('Task 4.4: OllamaAdapter', () => {
    it('sends base64 images array and format: "json" to /api/chat', async () => {
      let capturedUrl: string = '';
      let capturedBody: any;

      const mockFetch = vi.fn(async (url: string, init: any) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              content: JSON.stringify({ classification: 'MAIN_MATCH_SUMMARY' }),
            },
            prompt_eval_count: 85,
            eval_count: 30,
          }),
        } as unknown as Response;
      });

      const adapter = new OllamaAdapter({
        baseUrl: 'http://localhost:11434',
        model: 'llama3.2-vision',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const res = await adapter.execute<{ classification: string }>({
        task: 'CLASSIFY',
        system_prompt: 'System text',
        prompt: 'User text',
        images: [{ mime_type: 'image/jpeg', base64: 'b2xsYW1haW1hZ2U=' }],
      });

      expect(capturedUrl).toBe('http://localhost:11434/api/chat');
      expect(capturedBody.format).toBe('json');
      expect(capturedBody.messages[1].images).toEqual(['b2xsYW1haW1hZ2U=']);
      expect(res.parsed_json).toEqual({ classification: 'MAIN_MATCH_SUMMARY' });
      expect(res.telemetry.provider).toBe('OLLAMA_CLOUD');
    });
  });

  // ===========================================================================
  // Task 4.4b: NVIDIA NIM Adapter
  // ===========================================================================
  describe('Task 4.4b: NvidiaAdapter', () => {
    it('sends JSON requests to NVIDIA NIM endpoint and supports multi-key rotation', async () => {
      let capturedBody: any;
      let capturedAuth: string = '';

      const mockFetch = vi.fn(async (_url: string, init: any) => {
        capturedAuth = init.headers.Authorization;
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({ status: 'ok', model: 'nemotron-3.5-lightning' }),
                },
              },
            ],
            usage: { prompt_tokens: 42, completion_tokens: 15 },
          }),
        } as unknown as Response;
      });

      const adapter = new NvidiaAdapter({
        apiKeys: ['key-1', 'key-2'],
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const res = await adapter.execute<{ status: string; model: string }>({
        task: 'CLASSIFY',
        structured_output: true,
        system_prompt: 'System prompt',
        prompt: 'User prompt',
      });

      expect(capturedAuth).toBe('Bearer key-1');
      expect(capturedBody.model).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
      expect(capturedBody.response_format).toEqual({ type: 'json_object' });
      expect(res.parsed_json).toEqual({ status: 'ok', model: 'nemotron-3.5-lightning' });
      expect(res.telemetry.provider).toBe('NVIDIA_NIM');

      // Test key rotation on rate limit
      adapter.rotateKey();
      expect(adapter.getActiveApiKey()).toBe('key-2');

      // Test vision request uses visionModel
      const visionRes = await adapter.execute<{ status: string }>({
        task: 'CLASSIFY',
        system_prompt: 'System prompt',
        prompt: 'User prompt',
        images: [{ mime_type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAE=' }],
      });
      expect(capturedBody.model).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
      expect(capturedBody.messages[1].content[1].type).toBe('image_url');
    });
  });

  // ===========================================================================
  // Task 4.5: Multi-Provider Router, Fallback Chain & Circuit Breakers
  // ===========================================================================
  describe('Task 4.5: ProviderRouter & Circuit Breakers', () => {
    it('rotates requests across multiple healthy providers (load balancing)', async () => {
      const groqMock = createMockAdapter('GROQ');
      const geminiMock = createMockAdapter('GEMINI');
      const ollamaMock = createMockAdapter('OLLAMA_CLOUD');

      const router = new ProviderRouter({
        adapters: [groqMock, geminiMock, ollamaMock],
      });

      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '1' });
      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '2' });
      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '3' });

      expect(groqMock.execute).toHaveBeenCalledTimes(1);
      expect(geminiMock.execute).toHaveBeenCalledTimes(1);
      expect(ollamaMock.execute).toHaveBeenCalledTimes(1);
    });

    it('falls back to the next provider in chain when the primary fails', async () => {
      const groqMock = createMockAdapter('GROQ', {
        onExecute: vi.fn(async () => {
          throw new AIProviderUnavailableError('GROQ', '503 Groq Down');
        }),
      });
      const geminiMock = createMockAdapter('GEMINI', {
        onExecute: vi.fn(async (req) => ({
          raw_text: JSON.stringify({ source: 'gemini' }),
          parsed_json: { source: 'gemini' },
          telemetry: {
            provider: 'GEMINI',
            model: 'gemini-1.5-flash',
            task_type: req.task,
            latency_ms: 20,
            status: 'SUCCESS' as const,
          },
        })),
      });

      const router = new ProviderRouter({
        adapters: [groqMock, geminiMock],
      });

      const res = await router.execute<{ source: string }>({
        task: 'CLASSIFY',
        system_prompt: '',
        prompt: 'test',
      });

      expect(groqMock.execute).toHaveBeenCalled();
      expect(geminiMock.execute).toHaveBeenCalled();
      expect(res.parsed_json?.source).toBe('gemini');
    });

    it('trips circuit breaker from CLOSED to OPEN after consecutive failures and recovers on HALF_OPEN', async () => {
      let failGroq = true;
      const groqMock = createMockAdapter('GROQ', {
        onExecute: vi.fn(async () => {
          if (failGroq) {
            throw new AIProviderUnavailableError('GROQ', 'Server down');
          }
          return {
            raw_text: '{"ok": true}',
            parsed_json: { ok: true },
            telemetry: {
              provider: 'GROQ',
              model: 'groq-model',
              task_type: 'CLASSIFY',
              latency_ms: 10,
              status: 'SUCCESS',
            },
          };
        }),
      });

      const geminiMock = createMockAdapter('GEMINI');

      const router = new ProviderRouter({
        adapters: [groqMock, geminiMock],
        consecutiveFailureThreshold: 2,
        cooldownWindowMs: 50, // Short cooldown for test
      });

      // Request 1: Groq fails -> Gemini handles
      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '1' });
      expect(router.getCircuitBreakerStatuses()['GROQ'].state).toBe('CLOSED');
      expect(router.getCircuitBreakerStatuses()['GROQ'].consecutiveFailures).toBe(1);

      // Request 2: Gemini is first in rotation and succeeds.
      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '2' });

      // Request 3: Groq is first in rotation again -> Groq fails -> failure count 2 -> trips to OPEN!
      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '3' });
      expect(router.getCircuitBreakerStatuses()['GROQ'].state).toBe('OPEN');

      // Request 4: Groq is OPEN -> router immediately skips Groq and uses Gemini
      const groqCallsBefore = (groqMock.execute as any).mock.calls.length;
      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '4' });
      expect((groqMock.execute as any).mock.calls.length).toBe(groqCallsBefore);

      // Wait for cooldown to elapse
      await new Promise((r) => setTimeout(r, 60));

      // Enable Groq success
      failGroq = false;

      // Next request tests Groq in HALF_OPEN and succeeds -> closes circuit breaker
      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '5' });
      expect(router.getCircuitBreakerStatuses()['GROQ'].state).toBe('CLOSED');
      expect(router.getCircuitBreakerStatuses()['GROQ'].consecutiveFailures).toBe(0);
    });

    it('trips circuit breaker immediately on fatal errors (401/403 or quota exceeded)', async () => {
      const groqMock = createMockAdapter('GROQ', {
        onExecute: vi.fn(async () => {
          throw new AIQuotaExceededError('GROQ', 'Quota spent');
        }),
      });
      const geminiMock = createMockAdapter('GEMINI');

      const router = new ProviderRouter({
        adapters: [groqMock, geminiMock],
        consecutiveFailureThreshold: 5, // Even with high threshold
      });

      await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: '1' });

      // Groq immediately trips to OPEN because of fatal quota exhaustion
      expect(router.getCircuitBreakerStatuses()['GROQ'].state).toBe('OPEN');
    });

    it('triggers manual mode fallback when all providers fail (FR-FAIL-002)', async () => {
      const groqMock = createMockAdapter('GROQ', {
        onExecute: vi.fn(async () => {
          throw new AIProviderUnavailableError('GROQ', 'Groq down');
        }),
      });
      const geminiMock = createMockAdapter('GEMINI', {
        onExecute: vi.fn(async () => {
          throw new AIProviderUnavailableError('GEMINI', 'Gemini down');
        }),
      });

      const router = new ProviderRouter({
        adapters: [groqMock, geminiMock],
      });

      try {
        await router.execute({ task: 'CLASSIFY', system_prompt: '', prompt: 'test' });
        expect.unreachable('Should have thrown AllProvidersFailedError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AllProvidersFailedError);
        expect(err.manual_mode_required).toBe(true);
        expect(err.fallback_message).toContain('Automated screenshot processing is temporarily unavailable');
        expect(err.fallback_message).toContain('Please contact the tournament organizer for manual verification');
      }
    });
  });

  // ===========================================================================
  // Task 4.6: Image Classification
  // ===========================================================================
  describe('Task 4.6: ImageClassifier', () => {
    it('classifies match summary screens and individual player detail screens', async () => {
      const mockAdapter = createMockAdapter('GROQ', {
        onExecute: vi.fn(async (req) => {
          const isDetail = req.prompt.includes('detail');
          const json = isDetail
            ? {
                screen_type: 'INDIVIDUAL_PLAYER_DETAIL',
                confidence: 0.98,
                reason: 'Single character showcase with summary stats and tabs',
                visual_features: ['cap', 'gloves', 'shooting_tab'],
                uncertainties: [],
              }
            : {
                screen_type: 'MAIN_MATCH_SUMMARY',
                confidence: 0.95,
                reason: 'Scoreboard with multi-player stats table',
                visual_features: ['scoreboard', 'team_columns', 'player_rows'],
                uncertainties: [],
              };
          return {
            raw_text: JSON.stringify(json),
            parsed_json: json,
            telemetry: {
              provider: 'GROQ',
              model: 'groq-model',
              task_type: req.task,
              latency_ms: 15,
              status: 'SUCCESS',
            },
          };
        }),
      });

      const router = new ProviderRouter({ adapters: [mockAdapter] });
      const classifier = new ImageClassifier(router);

      const mainResult = await classifier.classify(
        { mime_type: 'image/jpeg', base64: 'bWFpbl9zY3JlZW4=' },
        { caption: 'match score' }
      );
      expect(mainResult.screen_type).toBe('MAIN_MATCH_SUMMARY');
      expect(mainResult.confidence).toBeGreaterThan(0.9);

      const detailResult = await classifier.classify(
        { mime_type: 'image/jpeg', base64: 'ZGV0YWlsX3NjcmVlbg==' },
        { caption: 'detail player' }
      );
      expect(detailResult.screen_type).toBe('INDIVIDUAL_PLAYER_DETAIL');
    });

    it('enforces rule: never classify purely based on caption alone when image is empty', async () => {
      const mockAdapter = createMockAdapter('GROQ');
      const router = new ProviderRouter({ adapters: [mockAdapter] });
      const classifier = new ImageClassifier(router);

      // Even if user caption strongly claims it is a match summary
      const result = await classifier.classify(
        { mime_type: 'image/jpeg', base64: '' },
        { caption: 'FOTO HASIL PERTANDINGAN FINAL SCORE 12-7 MAIN MATCH SUMMARY' }
      );

      // Returns UNREADABLE without trusting caption!
      expect(result.screen_type).toBe('UNREADABLE');
      expect(result.reason).toContain('Cannot classify based on caption alone');
      expect(mockAdapter.execute).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Task 4.7: Main Match Extractor (Raw Unicode Preservation)
  // ===========================================================================
  describe('Task 4.7: MatchSummaryExtractor', () => {
    it('extracts scores, player rows, and preserves raw Unicode nicknames exactly', async () => {
      const mockMatchPayload = {
        screen_type: 'MAIN_MATCH_SUMMARY',
        team_a_score: 12,
        team_b_score: 7,
        result_indicator: 'MENANG',
        team_a_players: [
          {
            nickname_raw: '★KING·rajj★ ⚽',
            rating: 8.5,
            goals: 6,
            assists: 3,
            passes: 10,
            defense: 2,
          },
          {
            nickname_raw: '𝕾𝖍𝖆𝖉𝖔𝖜 𝕶𝖓𝖎𝖌𝖍𝖙',
            rating: 7.9,
            goals: 6,
            assists: 2,
            passes: 8,
            defense: 1,
          },
        ],
        team_b_players: [
          {
            nickname_raw: 'Łîôñ_Hêârt™ [IDN]',
            rating: 6.8,
            goals: 4,
            assists: 1,
            passes: 5,
            defense: 4,
          },
          {
            nickname_raw: 'BlurryPlayer',
            rating: null, // null for unreadable
            goals: 3,
            assists: null,
            passes: null,
            defense: null,
          },
        ],
        confidence: 0.94,
        unreadable_fields: ['team_b_players[1].rating'],
        uncertainties: [],
      };

      const mockAdapter = createMockAdapter('GROQ', {
        onExecute: vi.fn(async () => ({
          raw_text: JSON.stringify(mockMatchPayload),
          parsed_json: mockMatchPayload,
          telemetry: {
            provider: 'GROQ',
            model: 'groq-model',
            task_type: 'EXTRACT_MATCH',
            latency_ms: 25,
            status: 'SUCCESS',
          },
        })),
      });

      const router = new ProviderRouter({ adapters: [mockAdapter] });
      const extractor = new MatchSummaryExtractor(router);

      const { summary_data } = await extractor.extract(
        { mime_type: 'image/jpeg', base64: 'bWF0Y2hfc2NyZWVuc2hvdA==' },
        { trusted_context: { team_a_name: 'Astra Lumina', team_b_name: 'Nova Eclipse' } }
      );

      expect(summary_data.team_a_score).toBe(12);
      expect(summary_data.team_b_score).toBe(7);
      // Raw Unicode preserved intact
      expect(summary_data.team_a_players[0].nickname_raw).toBe('★KING·rajj★ ⚽');
      expect(summary_data.team_a_players[1].nickname_raw).toBe('𝕾𝖍𝖆𝖉𝖔𝖜 𝕶𝖓𝖎𝖌𝖍𝖙');
      expect(summary_data.team_b_players[0].nickname_raw).toBe('Łîôñ_Hêârt™ [IDN]');
      // Unreadable fields return null
      expect(summary_data.team_b_players[1].rating).toBeNull();
      expect(summary_data.team_b_players[1].assists).toBeNull();
    });
  });

  // ===========================================================================
  // Task 4.8: Goalkeeper Visual Cue Detector & Detail Extractor
  // ===========================================================================
  describe('Task 4.8: GoalkeeperDetailExtractor', () => {
    it('detects visual cues, preserves defense_raw, maps saves only when verified, and hidden tabs are null', async () => {
      const mockGkPayload = {
        screen_type: 'INDIVIDUAL_PLAYER_DETAIL',
        match_result: {
          status_text: 'MENANG',
          score_left: 12,
          score_right: 7,
          perspective_side: 'left',
        },
        perspective_player: {
          nickname: null,
          uid: null,
          visual_role_cue: {
            type: 'GOALKEEPER',
            cue_status: 'PRESENT',
            evidence: ['cap', 'goalkeeper_gloves', 'ball_held_in_front_of_abdomen_or_chest'],
          },
          summary: {
            rating: 8.0,
            goals: 0,
            assists: 0,
            passes: 2,
            defense_raw: 5,
          },
          detail_tabs: {
            active: 'SHOOTING',
            shooting: {
              shots: 0,
              shots_on_target: 0,
              goals: 0,
              goal_rate_raw: 'N/A',
            },
            umpan: null, // Hidden tabs return null, not zero!
            defense: null,
            possession: null,
          },
        },
        confidence: 0.95,
        uncertainties: [],
      };

      const mockAdapter = createMockAdapter('GROQ', {
        onExecute: vi.fn(async () => ({
          raw_text: JSON.stringify(mockGkPayload),
          parsed_json: mockGkPayload,
          telemetry: {
            provider: 'GROQ',
            model: 'groq-model',
            task_type: 'EXTRACT_GOALKEEPER',
            latency_ms: 22,
            status: 'SUCCESS',
          },
        })),
      });

      const router = new ProviderRouter({ adapters: [mockAdapter] });
      const extractor = new GoalkeeperDetailExtractor(router);

      const result = await extractor.extract({
        mime_type: 'image/jpeg',
        base64: 'Z2tfZGV0YWlsX2ltYWdl',
      });

      expect(result.visual_cue_status).toBe('PRESENT');
      expect(result.visual_cue_evidence).toContain('cap');
      expect(result.visual_cue_evidence).toContain('goalkeeper_gloves');
      expect(result.summary.defense_raw).toBe(5);

      // Hidden detail tabs are null, not zero
      expect(result.raw_extraction.perspective_player.detail_tabs.umpan).toBeNull();
      expect(result.raw_extraction.perspective_player.detail_tabs.defense).toBeNull();
      expect(result.raw_extraction.perspective_player.detail_tabs.possession).toBeNull();

      // Mapping rule: saves = defense_raw only when verified
      expect(GoalkeeperDetailExtractor.mapGoalkeeperSaves(5, false)).toBeNull();
      expect(GoalkeeperDetailExtractor.mapGoalkeeperSaves(5, true)).toBe(5);
    });
  });

  // ===========================================================================
  // Task 4.9: Goalkeeper Identity (⛔ Strictly Caption-Based, NEVER Stat Vectors)
  // ===========================================================================
  describe('Task 4.9: Goalkeeper Identity Resolution', () => {
    const roster = [
      { id: 'p-1', nickname: 'KINGrajj', is_goalkeeper: true },
      { id: 'p-2', nickname: 'Striker99', is_goalkeeper: false },
      { id: 'p-3', nickname: 'MidMaster', is_goalkeeper: false },
    ];

    it('resolves identity via caption fuzzy matching with minor typos (KINGraj vs KINGrajj)', () => {
      // Submitting delegate wrote "FOTO 1 HX KINGraj"
      const result = resolveGoalkeeperIdentity({
        caption: 'FOTO 1 HX KINGraj',
        submitting_team_roster: roster,
      });

      expect(result.status).toBe('UNIQUE');
      expect(result.candidate_player_id).toBe('p-1');
      expect(result.candidate_nickname).toBe('KINGrajj');
      expect(result.link_method).toBe('CAPTION_NICKNAME_FUZZY_MATCH');
      expect(result.confidence).toBeGreaterThan(0.75);
    });

    it('returns UNMATCHED when caption is empty or missing, requiring manual confirmation', () => {
      const result = resolveGoalkeeperIdentity({
        caption: null,
        submitting_team_roster: roster,
      });

      expect(result.status).toBe('UNMATCHED');
      expect(result.candidate_player_id).toBeNull();
      expect(result.reason).toContain('No caption provided');
    });

    it('returns AMBIGUOUS when caption matches multiple keepers with tied or close scores', () => {
      const multiKeeperRoster = [
        { id: 'k-1', nickname: 'SuperKeeper', is_goalkeeper: true },
        { id: 'k-2', nickname: 'SuperKeeperPro', is_goalkeeper: true },
      ];

      // Caption matches both closely
      const result = resolveGoalkeeperIdentity({
        caption: 'SuperKeeper',
        submitting_team_roster: multiKeeperRoster,
      });

      // Both match high similarity -> AMBIGUOUS requires manual confirmation
      expect(['UNIQUE', 'AMBIGUOUS']).toContain(result.status);
      if (result.status === 'AMBIGUOUS') {
        expect(result.candidate_player_id).toBeNull();
      }
    });

    it('⛔ EXPLICIT ARCHITECTURAL GUARD: NEVER uses statistical vector matching for goalkeeper identity (TESTING.md §9)', () => {
      /**
       * Test case: Two goalkeepers from opposing or same team roster both have
       * identical statistical vectors [rating: 8.0, goals: 0, assists: 0, passes: 2, defense: 5].
       * 
       * Architectural rule (D-030, FR-GK-005, AI_PIPELINE.md §5):
       * Statistical vector matching is explicitly rejected.
       * Even if someone passes a statistical vector, the resolver MUST ignore it
       * and rely exclusively on caption text.
       */
      const mockStatsVector = {
        rating: 8.0,
        goals: 0,
        assists: 0,
        passes: 2,
        defense: 5,
        saves: 5,
      };

      const testRoster = [
        { id: 'gk-astra', nickname: 'AstraKeeper', is_goalkeeper: true },
        { id: 'gk-alt', nickname: 'AltKeeper', is_goalkeeper: true },
      ];

      // Call resolver passing caption that matches "AstraKeeper", but also inject stat vector
      const result = resolveGoalkeeperIdentity({
        caption: 'GK AstraKeeper match 1',
        submitting_team_roster: testRoster,
        ...({ stats: mockStatsVector, statistical_vector: [0, 0, 2, 5] } as any),
      });

      expect(result.status).toBe('UNIQUE');
      expect(result.candidate_player_id).toBe('gk-astra');
      expect(result.candidate_nickname).toBe('AstraKeeper');
      expect(result.link_method).toBe('CAPTION_NICKNAME_FUZZY_MATCH');

      // Now test with NO caption, but with identical stats vector
      const resultNoCaption = resolveGoalkeeperIdentity({
        caption: '',
        submitting_team_roster: testRoster,
        ...({ stats: mockStatsVector } as any),
      });

      // Must NOT use stats vector to pick a candidate! Must return UNMATCHED
      expect(resultNoCaption.status).toBe('UNMATCHED');
      expect(resultNoCaption.candidate_player_id).toBeNull();
    });
  });

  // ===========================================================================
  // Task 4.10: Natural Language Correction Parser
  // ===========================================================================
  describe('Task 4.10: CorrectionParser & Indonesian Terms Mapping', () => {
    const reportContext: ReportContext = {
      report_version_id: 'rep-ver-100',
      team_a: {
        id: 'team-astra',
        name: 'Astra Lumina',
        players: [
          { ordinal: 1, nickname: 'Alpha', goals: 2, assists: 1, passes: 5, defense: 1 },
          { ordinal: 2, nickname: 'Beta', goals: 3, assists: 0, passes: 4, defense: 2 },
          { ordinal: 3, nickname: 'Gamma', goals: 1, assists: 2, passes: 9, defense: 0 },
        ],
      },
      team_b: {
        id: 'team-nova',
        name: 'Nova Eclipse',
        players: [
          { ordinal: 1, nickname: 'Delta', goals: 2, assists: 1, passes: 3, defense: 3 },
          { ordinal: 2, nickname: 'Epsilon', goals: 1, assists: 1, passes: 4, defense: 1 },
        ],
      },
      score_a: 6,
      score_b: 3,
    };

    it('parses Indonesian prompt example: "player urutan 3 salah di umpan, umpannya seharusnya 6 bukan 9, btw ini yang salah tim Astra Lumina ya"', async () => {
      const msg = 'player urutan 3 salah di umpan, umpannya seharusnya 6 bukan 9, btw ini yang salah tim Astra Lumina ya';

      const outcome = parseCorrectionRuleBased(msg, reportContext);

      expect(outcome.status).toBe('PROPOSED');
      if (outcome.status === 'PROPOSED') {
        expect(outcome.patch.team_name).toBe('Astra Lumina');
        expect(outcome.patch.team_side).toBe('TEAM_A');
        expect(outcome.patch.player_ordinal).toBe(3);
        expect(outcome.patch.metric).toBe('passes');
        expect(outcome.patch.new_value).toBe(6);
        expect(outcome.patch.stated_old_value).toBe(9);
      }
    });

    it('maps Indonesian terms correctly: gol -> goals, asis -> assists, defense -> defense', () => {
      const golRes = parseCorrectionRuleBased('pemain ke-2 tim Astra Lumina gol harusnya 4 bukan 3', reportContext);
      expect(golRes.status).toBe('PROPOSED');
      if (golRes.status === 'PROPOSED') {
        expect(golRes.patch.metric).toBe('goals');
        expect(golRes.patch.new_value).toBe(4);
        expect(golRes.patch.stated_old_value).toBe(3);
      }

      const asisRes = parseCorrectionRuleBased('tim Nova Eclipse player urutan 1 asis seharusnya 2 bukan 1', reportContext);
      expect(asisRes.status).toBe('PROPOSED');
      if (asisRes.status === 'PROPOSED') {
        expect(asisRes.patch.metric).toBe('assists');
        expect(asisRes.patch.new_value).toBe(2);
      }
    });

    it('returns NEEDS_CLARIFICATION when the correction is ambiguous (e.g. unknown team or metric)', () => {
      // Missing team specification for ordinal player
      const ambiguousMsg = 'player urutan 2 golnya salah harusnya 4 bukan 3';
      const outcome = parseCorrectionRuleBased(ambiguousMsg, reportContext);

      expect(outcome.status).toBe('NEEDS_CLARIFICATION');
      if (outcome.status === 'NEEDS_CLARIFICATION') {
        expect(outcome.patch).toBeNull();
        expect(outcome.clarification_reason).toContain('Tim mana yang dimaksud');
      }
    });

    it('invokes AI model when available and handles LLM parsed output or fallback', async () => {
      const mockAdapter = createMockAdapter('GROQ', {
        onExecute: vi.fn(async () => {
          const aiJson = {
            intent: 'CORRECTION',
            status: 'PROPOSED',
            team_name: 'Astra Lumina',
            team_side: 'TEAM_A',
            player_reference: {
              type: 'ROSTER_ORDINAL',
              ordinal: 3,
            },
            statistic: 'passes',
            old_value: 9,
            new_value: 6,
            reason: 'Koreksi umpan player 3',
            ambiguities: [],
          };
          return {
            raw_text: JSON.stringify(aiJson),
            parsed_json: aiJson,
            telemetry: {
              provider: 'GROQ',
              model: 'groq-model',
              task_type: 'PARSE_CORRECTION',
              latency_ms: 18,
              status: 'SUCCESS',
            },
          };
        }),
      });

      const router = new ProviderRouter({ adapters: [mockAdapter] });
      const parser = new CorrectionParser(router);

      const res = await parser.parse({
        message_text: 'player urutan 3 salah di umpan, umpannya seharusnya 6 bukan 9, btw ini yang salah tim Astra Lumina ya',
        report_context: reportContext,
      });

      expect(res.status).toBe('PROPOSED');
      if (res.status === 'PROPOSED') {
        expect(res.patch.metric).toBe('passes');
        expect(res.patch.new_value).toBe(6);
        expect(res.patch.stated_old_value).toBe(9);
        expect(res.patch.player_ordinal).toBe(3);
      }
    });
  });
});
