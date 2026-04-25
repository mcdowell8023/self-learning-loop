// src/reflect/llm-client-real.ts
//
// T-SLL-M4 — Real LLM Client implementations.
//
// Two providers:
//   1. openclaw     — shells out to `openclaw spawn` (zero-config for OpenClaw users)
//   2. openai-compat — direct OpenAI-compatible HTTP calls (Pollinations / any provider)
//
// Design:
//   - Implements LLMClient interface from llm-client.ts
//   - Token budget check is NOT here (caller's responsibility in CLI layer)
//   - Timeout via AbortController
//   - Friendly error messages, never panics

import { execFile } from 'node:child_process';
import type { LLMClient, LLMCompleteOptions } from './llm-client.js';

// ---------------------------------------------------------------------------
// Provider config (mirrors config.yaml reflect.llm)
// ---------------------------------------------------------------------------

export interface LLMProviderConfig {
  provider: 'openclaw' | 'openai-compatible';
  model: string;
  api_key_env: string;
  base_url: string;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
}

export const DEFAULT_LLM_CONFIG: LLMProviderConfig = {
  provider: 'openclaw',
  model: 'github-copilot/claude-haiku-4.5',
  api_key_env: 'COPILOT_API_KEY',
  base_url: 'https://gen.pollinations.ai/v1',
  temperature: 0.3,
  max_tokens: 2000,
  timeout_seconds: 60,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRealLLMClient(
  config: Partial<LLMProviderConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): LLMClient {
  const cfg = { ...DEFAULT_LLM_CONFIG, ...config };
  if (cfg.provider === 'openclaw') {
    return new OpenClawLLMClient(cfg);
  }
  return new OpenAICompatibleLLMClient(cfg, env);
}

// ---------------------------------------------------------------------------
// OpenClaw provider — exec `openclaw spawn`
// ---------------------------------------------------------------------------

class OpenClawLLMClient implements LLMClient {
  constructor(private readonly config: LLMProviderConfig) {}

  async complete(prompt: string, opts?: LLMCompleteOptions): Promise<string> {
    const model = opts?.model ?? this.config.model;
    const timeoutMs = opts?.timeoutMs ?? this.config.timeout_seconds * 1000;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`OpenClaw LLM timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const child = execFile(
        'openclaw',
        [
          'spawn',
          '--model', model,
          '--task', prompt,
          '--wait',
          '--quiet',
        ],
        { maxBuffer: 1024 * 1024, timeout: timeoutMs + 5000 },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          if (error) {
            reject(new Error(`OpenClaw spawn failed: ${error.message}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ''}`));
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider — direct HTTP fetch
// ---------------------------------------------------------------------------

class OpenAICompatibleLLMClient implements LLMClient {
  private readonly apiKey: string;

  constructor(
    private readonly config: LLMProviderConfig,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const key = env[config.api_key_env];
    if (!key) {
      throw new Error(
        `LLM API key not found: environment variable "${config.api_key_env}" is not set.\n` +
        `Set it in your shell or in config.yaml reflect.llm.api_key_env.`,
      );
    }
    this.apiKey = key;
  }

  async complete(prompt: string, opts?: LLMCompleteOptions): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? this.config.timeout_seconds * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const model = opts?.model ?? this.config.model;
    const temperature = opts?.temperature ?? this.config.temperature;
    const maxTokens = opts?.maxTokens ?? this.config.max_tokens;
    const baseUrl = this.config.base_url.replace(/\/+$/, '');

    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: maxTokens,
          ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      if (resp.status === 401) {
        throw new Error(`LLM authentication failed (401). Check your API key in "${this.config.api_key_env}".`);
      }
      if (resp.status === 429) {
        throw new Error('LLM rate limited (429). Try again later or increase your quota.');
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`LLM API error: ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const raw = data.choices?.[0]?.message?.content ?? '[]';

      // Unwrap {"candidates": [...]} pattern some models produce
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
          for (const v of Object.values(parsed)) {
            if (Array.isArray(v)) return JSON.stringify(v);
          }
        }
      } catch { /* let caller handle */ }

      return raw;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`LLM request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
