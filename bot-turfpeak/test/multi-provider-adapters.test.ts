import { describe, it, expect, vi } from 'vitest';
import { DeepSeekAdapter } from '../src/ai/providers/deepseek.js';
import { CohereAdapter } from '../src/ai/providers/cohere.js';
import { MistralAdapter } from '../src/ai/providers/mistral.js';
import { ProviderRouter } from '../src/ai/router.js';
import { AIQuotaExceededError } from '../src/ai/adapter.js';

describe('New Multi-Provider Adapters & Priority Routing Tests', () => {
  it('DeepSeekAdapter formats request and parses JSON correctly with deepseek-flash', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'ds-123',
        choices: [
          {
            message: {
              content: '{"score": "12 : 7", "winner": "HX"}',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })) as unknown as typeof fetch;

    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test-deepseek-key-123456',
      model: 'deepseek-flash',
      fetchFn: mockFetch,
    });

    const res = await adapter.execute<{ score: string; winner: string }>({
      task: 'EXTRACT_MATCH',
      structured_output: true,
      system_prompt: 'System',
      prompt: 'Extract match',
    });

    expect(res.parsed_json).toEqual({ score: '12 : 7', winner: 'HX' });
    expect(res.telemetry.model).toBe('deepseek-flash');
    expect(res.telemetry.provider).toBe('DEEPSEEK');
  });

  it('DeepSeekAdapter throws AIQuotaExceededError on 402 Insufficient Balance', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 402,
      text: async () => '{"message": "Insufficient Balance"}',
    })) as unknown as typeof fetch;

    const adapter = new DeepSeekAdapter({
      apiKey: 'sk-test-deepseek-key-123456',
      fetchFn: mockFetch,
    });

    await expect(
      adapter.execute({
        task: 'EXTRACT_MATCH',
        system_prompt: '',
        prompt: 'test',
      })
    ).rejects.toThrow(AIQuotaExceededError);
  });

  it('CohereAdapter parses message content with thinking block and text JSON', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'co-123',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me analyze the score...' },
            { type: 'text', text: '{"team_name": "AVOID PRIME", "goalkeeper": "AVO | Ciboyy"}' },
          ],
        },
        usage: { tokens: { input_tokens: 20, output_tokens: 15 } },
      }),
    })) as unknown as typeof fetch;

    const adapter = new CohereAdapter({
      apiKey: 'co-test-key-123456',
      model: 'command-a-reasoning-08-2025',
      fetchFn: mockFetch,
    });

    const res = await adapter.execute<{ team_name: string; goalkeeper: string }>({
      task: 'PARSE_ROSTER',
      structured_output: true,
      system_prompt: '',
      prompt: 'test',
    });

    expect(res.parsed_json).toEqual({ team_name: 'AVOID PRIME', goalkeeper: 'AVO | Ciboyy' });
    expect(res.telemetry.provider).toBe('COHERE');
  });

  it('MistralAdapter executes with codestral-latest and rotates key on 429', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => 'Rate limit exceeded',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"status": "ok"}' } }],
        }),
      };
    }) as unknown as typeof fetch;

    const adapter = new MistralAdapter({
      apiKeys: ['mistral-key-1-111111', 'mistral-key-2-222222'],
      fetchFn: mockFetch,
    });

    expect(adapter.getActiveApiKey()).toBe('mistral-key-1-111111');
    await expect(
      adapter.execute({ task: 'CLASSIFY', system_prompt: '', prompt: 'test' })
    ).rejects.toThrow();
    // After 429, key rotates
    expect(adapter.getActiveApiKey()).toBe('mistral-key-2-222222');
  });

  it('ProviderRouter with prioritizeByTask routes vision to DEEPSEEK first and text to GROQ first', async () => {
    const calls: string[] = [];

    const deepseekMock = {
      name: 'DEEPSEEK' as const,
      model: 'deepseek-flash',
      capabilities: { vision: true, text: true, structured_output: true, supported_mime_types: ['image/jpeg'] },
      healthCheck: async () => true,
      execute: async () => {
        calls.push('DEEPSEEK');
        return { raw_text: '{}', parsed_json: {}, telemetry: { provider: 'DEEPSEEK' as const, model: 'm', task_type: 'EXTRACT_MATCH' as const, latency_ms: 1, status: 'SUCCESS' as const } };
      },
    };

    const groqMock = {
      name: 'GROQ' as const,
      model: 'qwen/qwen3.8-27b',
      capabilities: { vision: true, text: true, structured_output: true, supported_mime_types: ['image/jpeg'] },
      healthCheck: async () => true,
      execute: async () => {
        calls.push('GROQ');
        return { raw_text: '{}', parsed_json: {}, telemetry: { provider: 'GROQ' as const, model: 'm', task_type: 'PARSE_ROSTER' as const, latency_ms: 1, status: 'SUCCESS' as const } };
      },
    };

    const router = new ProviderRouter({
      adapters: [deepseekMock, groqMock],
      prioritizeByTask: true,
    });

    // 1. Vision request (has images) -> Must go to DEEPSEEK first
    await router.execute({
      task: 'EXTRACT_MATCH',
      system_prompt: '',
      prompt: 'match',
      images: [{ mime_type: 'image/jpeg', base64: 'abc' }],
    });
    expect(calls[calls.length - 1]).toBe('DEEPSEEK');

    // 2. Text request (no images) -> Must go to GROQ first
    await router.execute({
      task: 'PARSE_ROSTER',
      system_prompt: '',
      prompt: 'roster',
    });
    expect(calls[calls.length - 1]).toBe('GROQ');
  });

  it('MistralAdapter vision default is the validated ministral-14b-latest, not the retired pixtral-12b-2409 (B-3)', () => {
    const adapter = new MistralAdapter({ apiKey: 'mistral-test-key-123456' });
    expect(adapter.visionModel).toBe('ministral-14b-latest');
    expect(adapter.visionModel).not.toBe('pixtral-12b-2409');
  });
});

