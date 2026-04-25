// src/reflect/llm-client.ts
//
// LLM 客户端接口（T-P1a-005）
//
// Phase 1a 不真调外部 LLM API；Candidate Generator 在测试中用 MockLLMClient
// 返回固定 JSON。生产代码预留 OpenAI 兼容 / Pollinations 两套实现占位。
//
// 设计原则：
//   - 接口最小化：仅一个 complete(prompt, opts) 方法
//   - 依赖注入：Generator 构造时注入，测试用 mock
//   - 超时/重试交给实现方，接口不做强制约束
// ---------------------------------------------------------------------------
// MockLLMClient（测试专用）
// ---------------------------------------------------------------------------
/**
 * 可编程 Mock 客户端，按调用顺序返回预置响应，或根据 prompt 子串匹配返回。
 * Phase 1a 单测默认使用。
 */
export class MockLLMClient {
    scripted;
    cursor = 0;
    matchers = [];
    /** 记录调用历史（测试断言用） */
    calls = [];
    constructor(scripted = []) {
        this.scripted = scripted;
    }
    /** 注册按 prompt 匹配的响应；优先级高于 scripted 队列 */
    on(match, response) {
        this.matchers.push({ match, response });
        return this;
    }
    async complete(prompt, opts) {
        this.calls.push({ prompt, opts });
        for (const m of this.matchers) {
            if (m.match.test(prompt))
                return m.response;
        }
        if (this.cursor < this.scripted.length) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            return this.scripted[this.cursor++];
        }
        // 默认：返回空数组（无候选）
        return '[]';
    }
}
/**
 * 专门抛错的 mock，用于测试失败路径。
 */
export class FailingLLMClient {
    error;
    constructor(error = new Error('LLM unavailable')) {
        this.error = error;
    }
    async complete() {
        throw this.error;
    }
}
