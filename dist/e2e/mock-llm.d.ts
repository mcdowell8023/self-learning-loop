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
export declare class E2EMockLLM implements LLMClient {
    readonly calls: MockLLMCall[];
    private queue;
    private matchers;
    private failAfter;
    private failError;
    /** Enqueue scripted responses (consumed FIFO). */
    enqueue(...responses: string[]): this;
    /** Add pattern-matched response (checked before queue). */
    onMatch(pattern: RegExp, response: string): this;
    /** After N successful calls, throw. */
    failAfterCalls(n: number, error?: Error): this;
    get callCount(): number;
    complete(prompt: string, opts?: LLMCompleteOptions): Promise<string>;
    /** Assert call count. */
    assertCallCount(expected: number): void;
    /** Get prompts passed to LLM. */
    getPrompts(): string[];
}
