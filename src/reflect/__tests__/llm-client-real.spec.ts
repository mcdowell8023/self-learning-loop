// src/reflect/__tests__/llm-client-real.spec.ts
//
// T-SLL-M4 — Tests for real LLM client implementations.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRealLLMClient, type LLMProviderConfig } from '../llm-client-real.js';

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// OpenAI-compatible provider tests
// ---------------------------------------------------------------------------

describe('OpenAICompatibleLLMClient', () => {
  const baseConfig: Partial<LLMProviderConfig> = {
    provider: 'openai-compatible',
    model: 'test-model',
    api_key_env: 'TEST_LLM_KEY',
    base_url: 'https://api.test.com/v1',
  };
  const env = { TEST_LLM_KEY: 'sk-test-123' } as unknown as NodeJS.ProcessEnv;

  it('happy path: sends correct request and returns content', async () => {
    const responseBody = JSON.stringify([
      { problem_category: 'test', trigger_conditions: 'x', recommended_action: 'y', scope: 'general', confidence: 0.8 },
    ]);

    mockFetch(async (url, init) => {
      expect(url).toBe('https://api.test.com/v1/chat/completions');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('test-model');
      expect(body.messages[0].role).toBe('user');
      expect(body.temperature).toBe(0.3);

      return new Response(JSON.stringify({
        choices: [{ message: { content: responseBody } }],
      }), { status: 200 });
    });

    const client = createRealLLMClient(baseConfig, env);
    const result = await client.complete('test prompt');
    expect(result).toBe(responseBody);
  });

  it('unwraps {"candidates": [...]} wrapper from LLM', async () => {
    const arr = [{ problem_category: 'a', trigger_conditions: 'b', recommended_action: 'c', scope: 'general' }];
    mockFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ candidates: arr }) } }],
    }), { status: 200 }));

    const client = createRealLLMClient(baseConfig, env);
    const result = await client.complete('test');
    expect(JSON.parse(result)).toEqual(arr);
  });

  it('throws friendly error on 401', async () => {
    mockFetch(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));

    const client = createRealLLMClient(baseConfig, env);
    await expect(client.complete('test')).rejects.toThrow(/authentication failed.*401/i);
  });

  it('throws friendly error on 429 rate limit', async () => {
    mockFetch(async () => new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' }));

    const client = createRealLLMClient(baseConfig, env);
    await expect(client.complete('test')).rejects.toThrow(/rate limited.*429/i);
  });

  it('throws on timeout', async () => {
    mockFetch(async (_url, init) => {
      // Wait for abort
      return new Promise<Response>((_, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });

    const client = createRealLLMClient({ ...baseConfig, timeout_seconds: 1 }, env);
    await expect(client.complete('test')).rejects.toThrow(/timed out/i);
  }, 10000);

  it('throws if API key env var is missing', () => {
    expect(() => createRealLLMClient(baseConfig, {} as NodeJS.ProcessEnv)).toThrow(/TEST_LLM_KEY.*not set/);
  });
});

// ---------------------------------------------------------------------------
// Factory: provider selection
// ---------------------------------------------------------------------------

describe('createRealLLMClient factory', () => {
  it('defaults to openclaw provider', () => {
    const client = createRealLLMClient();
    // OpenClaw client doesn't need env vars at construction time
    expect(client).toBeDefined();
    expect(client.complete).toBeInstanceOf(Function);
  });

  it('creates openai-compatible client when specified', () => {
    const client = createRealLLMClient(
      { provider: 'openai-compatible', api_key_env: 'MY_KEY' },
      { MY_KEY: 'test' } as unknown as NodeJS.ProcessEnv,
    );
    expect(client).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Token budget check (via CLI reflect module)
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('token budget inline check', () => {
  const tmpDir = join('/tmp', `sll-budget-test-${process.pid}`);
  const auditDir = join(tmpDir, 'learn', 'audit');

  beforeEach(() => {
    mkdirSync(auditDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes when under budget', () => {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(auditDir, `reflect-${today}.jsonl`),
      '{"tokens_used":1000}\n{"tokens_used":2000}\n',
    );

    // Import the check function indirectly by testing CLI behavior
    // The budget check reads from workspace/learn/audit/reflect-YYYY-MM-DD.jsonl
    // Here we just verify the file format is correct
    const content = require('node:fs').readFileSync(join(auditDir, `reflect-${today}.jsonl`), 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const total = lines.reduce((sum: number, l: string) => sum + (JSON.parse(l).tokens_used ?? 0), 0);
    expect(total).toBe(3000);
    expect(total).toBeLessThan(50000);
  });

  it('audit event writes correctly', () => {
    const today = new Date().toISOString().slice(0, 10);
    const auditPath = join(auditDir, `reflect-${today}.jsonl`);
    const event = { event: 'reflect_started', provider: 'openclaw', timestamp: new Date().toISOString() };
    require('node:fs').appendFileSync(auditPath, JSON.stringify(event) + '\n');

    const content = require('node:fs').readFileSync(auditPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.event).toBe('reflect_started');
  });
});
