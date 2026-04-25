// src/e2e/mock-llm.ts
//
// E2E Mock LLM — stub + replay modes, call tracking, seedable.
/**
 * E2E Mock LLM with:
 *  - Scripted responses (FIFO queue)
 *  - Pattern-matched responses
 *  - Call tracking (prompt + count)
 *  - Seed support (deterministic via queue order)
 *  - Failure injection
 */
export class E2EMockLLM {
    calls = [];
    queue = [];
    matchers = [];
    failAfter = Infinity;
    failError = new Error('mock LLM failure');
    /** Enqueue scripted responses (consumed FIFO). */
    enqueue(...responses) {
        this.queue.push(...responses);
        return this;
    }
    /** Add pattern-matched response (checked before queue). */
    onMatch(pattern, response) {
        this.matchers.push({ pattern, response });
        return this;
    }
    /** After N successful calls, throw. */
    failAfterCalls(n, error) {
        this.failAfter = n;
        if (error)
            this.failError = error;
        return this;
    }
    get callCount() {
        return this.calls.length;
    }
    async complete(prompt, opts) {
        this.calls.push({ prompt, opts, timestamp: Date.now() });
        if (this.calls.length > this.failAfter) {
            throw this.failError;
        }
        for (const m of this.matchers) {
            if (m.pattern.test(prompt))
                return m.response;
        }
        if (this.queue.length > 0) {
            return this.queue.shift();
        }
        return '[]'; // default: no candidates
    }
    /** Assert call count. */
    assertCallCount(expected) {
        if (this.calls.length !== expected) {
            throw new Error(`Expected ${expected} LLM calls, got ${this.calls.length}`);
        }
    }
    /** Get prompts passed to LLM. */
    getPrompts() {
        return this.calls.map(c => c.prompt);
    }
}
