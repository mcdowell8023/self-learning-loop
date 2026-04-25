export interface LLMCompleteOptions {
    /** 模型 ID（如 "openai" / "claude-opus-4.7"），实现方自行映射 */
    model?: string;
    /** 采样温度 */
    temperature?: number;
    /** 最大输出 token */
    maxTokens?: number;
    /** 超时（毫秒） */
    timeoutMs?: number;
    /** 请求 JSON 输出（实现方可用于设置 response_format） */
    json?: boolean;
}
/**
 * LLM 客户端抽象。
 *
 * 约定：
 *   - complete 返回原始文本（可能包含 markdown code fence），由调用方解析
 *   - 实现抛错即视为调用失败，Generator 会捕获并返回空候选列表
 */
export interface LLMClient {
    complete(prompt: string, opts?: LLMCompleteOptions): Promise<string>;
}
/**
 * 可编程 Mock 客户端，按调用顺序返回预置响应，或根据 prompt 子串匹配返回。
 * Phase 1a 单测默认使用。
 */
export declare class MockLLMClient implements LLMClient {
    private readonly scripted;
    private cursor;
    private readonly matchers;
    /** 记录调用历史（测试断言用） */
    calls: Array<{
        prompt: string;
        opts?: LLMCompleteOptions;
    }>;
    constructor(scripted?: string[]);
    /** 注册按 prompt 匹配的响应；优先级高于 scripted 队列 */
    on(match: RegExp, response: string): this;
    complete(prompt: string, opts?: LLMCompleteOptions): Promise<string>;
}
/**
 * 专门抛错的 mock，用于测试失败路径。
 */
export declare class FailingLLMClient implements LLMClient {
    private readonly error;
    constructor(error?: Error);
    complete(): Promise<string>;
}
