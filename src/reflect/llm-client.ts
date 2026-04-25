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

// ---------------------------------------------------------------------------
// MockLLMClient（测试专用）
// ---------------------------------------------------------------------------

/**
 * 可编程 Mock 客户端，按调用顺序返回预置响应，或根据 prompt 子串匹配返回。
 * Phase 1a 单测默认使用。
 */
export class MockLLMClient implements LLMClient {
  private readonly scripted: string[];
  private cursor = 0;
  private readonly matchers: Array<{ match: RegExp; response: string }> = [];

  /** 记录调用历史（测试断言用） */
  public calls: Array<{ prompt: string; opts?: LLMCompleteOptions }> = [];

  constructor(scripted: string[] = []) {
    this.scripted = scripted;
  }

  /** 注册按 prompt 匹配的响应；优先级高于 scripted 队列 */
  on(match: RegExp, response: string): this {
    this.matchers.push({ match, response });
    return this;
  }

  async complete(prompt: string, opts?: LLMCompleteOptions): Promise<string> {
    this.calls.push({ prompt, opts });

    for (const m of this.matchers) {
      if (m.match.test(prompt)) return m.response;
    }

    if (this.cursor < this.scripted.length) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.scripted[this.cursor++]!;
    }

    // 默认：返回空数组（无候选）
    return '[]';
  }
}

/**
 * 专门抛错的 mock，用于测试失败路径。
 */
export class FailingLLMClient implements LLMClient {
  constructor(private readonly error: Error = new Error('LLM unavailable')) {}
  async complete(): Promise<string> {
    throw this.error;
  }
}
