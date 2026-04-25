// src/e2e/mock-llm.ts
//
// E2E Mock LLM — stub + replay modes, call tracking, seedable.

import type { LLMClient, LLMCompleteOptions } from '../reflect/llm-client.js';

export interface MockLLMCall {
  prompt: string;
  opts?: LLMCompleteOptions;
  timestamp: number;
}

/**
 * E2E Mock LLM with:
 *  - Scripted responses (FIFO queue)
 *  - Pattern-matched responses
 *  - Call tracking (prompt + count)
 *  - Seed support (deterministic via queue order)
 *  - Failure injection
 */
export class E2EMockLLM implements LLMClient {
  readonly calls: MockLLMCall[] = [];
  private queue: string[] = [];
  private matchers: Array<{ pattern: RegExp; response: string }> = [];
  private failAfter = Infinity;
  private failError = new Error('mock LLM failure');

  /** Enqueue scripted responses (consumed FIFO). */
  enqueue(...responses: string[]): this {
    this.queue.push(...responses);
    return this;
  }

  /** Add pattern-matched response (checked before queue). */
  onMatch(pattern: RegExp, response: string): this {
    this.matchers.push({ pattern, response });
    return this;
  }

  /** After N successful calls, throw. */
  failAfterCalls(n: number, error?: Error): this {
    this.failAfter = n;
    if (error) this.failError = error;
    return this;
  }

  get callCount(): number {
    return this.calls.length;
  }

  async complete(prompt: string, opts?: LLMCompleteOptions): Promise<string> {
    this.calls.push({ prompt, opts, timestamp: Date.now() });

    if (this.calls.length > this.failAfter) {
      throw this.failError;
    }

    for (const m of this.matchers) {
      if (m.pattern.test(prompt)) return m.response;
    }

    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }

    return '[]'; // default: no candidates
  }

  /** Assert call count. */
  assertCallCount(expected: number): void {
    if (this.calls.length !== expected) {
      throw new Error(`Expected ${expected} LLM calls, got ${this.calls.length}`);
    }
  }

  /** Get prompts passed to LLM. */
  getPrompts(): string[] {
    return this.calls.map(c => c.prompt);
  }
}
