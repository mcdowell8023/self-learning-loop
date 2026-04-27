// src/reflect/candidate-generator.spec.ts
//
// T-P1a-005 单元测试
// - 触发条件 happy / miss
// - prompt 生成（占位符替换）
// - mock LLM → 候选入库
// - confidence / scope 过滤
// - 截断 0-3 条
// - LLM 失败不抛错

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CandidateStore,
  openCandidateStore,
} from '../store/candidate-store.js';
import type { EnvFingerprint } from '../kernel/types.js';

import {
  CandidateGenerator,
  DEFAULT_GENERATOR_CONFIG,
} from './candidate-generator.js';
import {
  FailingLLMClient,
  MockLLMClient,
} from './llm-client.js';
import {
  buildReflectPrompt,
  formatEvents,
  type SessionEvent,
} from './reflection-prompt.js';
import {
  DEFAULT_TRIGGER_CONFIG,
  evaluateTrigger,
} from './trigger.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  model: 'claude-opus-4.7',
  nodeVersion: '22.14.0',
};

function ts(offsetMin: number, base = new Date('2026-04-21T10:00:00Z')): Date {
  return new Date(base.getTime() + offsetMin * 60_000);
}

const ERROR_EVENT: SessionEvent = {
  type: 'error',
  timestamp: ts(1),
  content: 'Traceback: FileNotFoundError /tmp/foo',
  metadata: {},
};

const TOOL_CALL: SessionEvent = {
  type: 'tool_call',
  timestamp: ts(2),
  content: 'exec ls /nope',
  metadata: { tool_name: 'exec' },
};

const TOOL_FAIL: SessionEvent = {
  type: 'tool_result',
  timestamp: ts(3),
  content: 'exit code 1: command failed: No such file',
  metadata: {},
};

const USER_CORRECTION: SessionEvent = {
  type: 'user_message',
  timestamp: ts(4),
  content: '不对，改改，这不是我想要的',
  metadata: {},
};

const CLEAN_EVENT: SessionEvent = {
  type: 'assistant_message',
  timestamp: ts(5),
  content: '任务完成',
  metadata: {},
};

const VALID_LLM_RESPONSE = JSON.stringify([
  {
    problem_category: 'file_cleanup',
    trigger_conditions: '子代理执行后 /tmp 残留临时文件',
    recommended_action: '每个子代理任务完成前执行 rm -f /tmp/${PREFIX}*',
    scope: 'general',
    diff_summary: '在 SKILL.md 添加 cleanup 步骤',
    files_touched: ['skills/video-summarizer/SKILL.md'],
    assertions: [
      {
        type: 'command_exit_code',
        description: '验证 /tmp 被清理',
        command: 'test ! -f /tmp/marker',
        expected_exit_code: 0,
      },
    ],
    confidence: 0.85,
    rationale: '重复出现的清理缺失',
  },
]);

// ---------------------------------------------------------------------------
// 测试上下文：每个 case 开一个独立 store（使用临时目录的 SQLite 文件）
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: CandidateStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'learning-loop-t005-'));
  store = openCandidateStore({ dbPath: join(tmpDir, 'cand.db') });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// 1. 触发器
// ===========================================================================

describe('evaluateTrigger', () => {
  it('happy: 错误事件命中', () => {
    const d = evaluateTrigger({ events: [ERROR_EVENT] });
    expect(d.shouldReflect).toBe(true);
    expect(d.reasons).toContain('error_event');
  });

  it('happy: 工具失败命中', () => {
    const d = evaluateTrigger({ events: [TOOL_CALL, TOOL_FAIL] });
    expect(d.shouldReflect).toBe(true);
    expect(d.reasons).toContain('tool_failure');
  });

  it('happy: 用户纠正命中', () => {
    const d = evaluateTrigger({ events: [USER_CORRECTION] });
    expect(d.shouldReflect).toBe(true);
    expect(d.reasons).toContain('user_correction');
  });

  it('happy: 重复 tool_call 命中（≥ 阈值）', () => {
    const events: SessionEvent[] = [
      { ...TOOL_CALL, timestamp: ts(1) },
      { ...TOOL_CALL, timestamp: ts(2) },
      { ...TOOL_CALL, timestamp: ts(3) },
    ];
    const d = evaluateTrigger({
      events,
      now: ts(4),
      // 把其他原因关掉，单独测重复
      config: { errorKeywords: [], toolFailureKeywords: [], correctionKeywords: [] },
    });
    expect(d.reasons).toContain('repeat_tool_call');
  });

  it('happy: 时间窗口兜底（距上次 ≥ 6h）', () => {
    const d = evaluateTrigger({
      events: [CLEAN_EVENT],
      lastReflectAt: new Date('2026-04-21T00:00:00Z'),
      now: new Date('2026-04-21T10:00:00Z'),
    });
    expect(d.reasons).toContain('time_window');
  });

  it('miss: 纯净事件 + 最近刚反思过 → 不触发', () => {
    const d = evaluateTrigger({
      events: [CLEAN_EVENT],
      lastReflectAt: new Date('2026-04-21T09:59:00Z'),
      now: new Date('2026-04-21T10:00:00Z'),
    });
    expect(d.shouldReflect).toBe(false);
    expect(d.reasons).toHaveLength(0);
  });

  it('miss: 空事件 + 有 lastReflectAt 未超窗 → 不触发', () => {
    const d = evaluateTrigger({
      events: [],
      lastReflectAt: ts(-10),
      now: ts(0),
    });
    expect(d.shouldReflect).toBe(false);
  });

  it('manual=true 强制触发', () => {
    const d = evaluateTrigger({ events: [], manual: true });
    expect(d.shouldReflect).toBe(true);
    expect(d.reasons).toEqual(['manual']);
  });
});

// ===========================================================================
// 2. Prompt 构建
// ===========================================================================

describe('buildReflectPrompt', () => {
  it('占位符全部被替换（无残留 {}）', () => {
    const p = buildReflectPrompt({
      events: [ERROR_EVENT, CLEAN_EVENT],
      env: ENV,
      existingStrategies: ['file_cleanup: 清理 /tmp'],
      problemCategories: ['file_cleanup', 'timeout_handling'],
    });
    expect(p).not.toMatch(/\{session_events\}/);
    expect(p).not.toMatch(/\{existing_strategies\}/);
    expect(p).not.toMatch(/\{problem_categories\}/);
    expect(p).not.toMatch(/\{runtime\}/);
    expect(p).toContain('openclaw');
    expect(p).toContain('linux / x64');
    expect(p).toContain('claude-opus-4.7');
    expect(p).toContain('file_cleanup: 清理 /tmp');
    expect(p).toContain('Traceback');
  });

  it('formatEvents 尊重 truncate 和 maxEvents', () => {
    const big = 'X'.repeat(2000);
    const events: SessionEvent[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'system',
      timestamp: ts(i),
      content: big,
      metadata: {},
    }));
    const out = formatEvents(events, { truncate: 100, maxEvents: 5 });
    // 只取 5 条
    expect((out.match(/### Event #/g) ?? []).length).toBe(5);
    // 每条被截断
    expect(out).toContain('…[+');
  });

  it('空事件数组有兜底占位', () => {
    const out = formatEvents([]);
    expect(out).toBe('(无事件)');
  });
});

// ===========================================================================
// 3. 端到端：触发 → LLM → 解析 → 入库
// ===========================================================================

describe('CandidateGenerator.reflect — end-to-end', () => {
  it('happy path: 产出 1 个候选并写入 Store (state=pending)', async () => {
    const llm = new MockLLMClient([VALID_LLM_RESPONSE]);
    const gen = new CandidateGenerator(llm, store);

    const result = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 'sess-001',
    });

    expect(result.triggered).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.persistedCount).toBe(1);
    expect(result.dropped).toHaveLength(0);

    // Store 中查到该 Candidate
    const all = store.list();
    expect(all).toHaveLength(1);
    const c = all[0]!;
    expect(c.state).toBe('pending');
    expect(c.strategy.problem_category).toBe('file_cleanup');
    expect(c.strategy.scope).toBe('general');
    expect(c.strategy.strategy_id).toMatch(/^sha256:/);
    expect(c.instances).toHaveLength(1);
    expect(c.instances[0]!.instance_id).toMatch(/^sha256:/);
    expect(c.instances[0]!.env_fingerprint.runtime).toBe('openclaw');
    expect(c.instances[0]!.source_sessions[0]!.session_id).toBe('sess-001');
    expect(c.strategy.instance_ids).toContain(c.instances[0]!.instance_id);
  });

  it('未触发：返回空，不调 LLM，不写库', async () => {
    const llm = new MockLLMClient([VALID_LLM_RESPONSE]);
    const gen = new CandidateGenerator(llm, store);

    const result = await gen.reflect({
      events: [CLEAN_EVENT],
      env: ENV,
      sessionId: 'sess-002',
      lastReflectAt: ts(-5), // 5 分钟前
      now: ts(0),
    });

    expect(result.triggered).toBe(false);
    expect(llm.calls).toHaveLength(0);
    expect(store.count()).toBe(0);
  });

  it('confidence < 0.3 的候选被丢弃', async () => {
    const low = JSON.stringify([
      {
        problem_category: 'x',
        trigger_conditions: 'y',
        recommended_action: 'z',
        scope: 'general',
        confidence: 0.1,
      },
    ]);
    const gen = new CandidateGenerator(new MockLLMClient([low]), store);
    const r = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 's',
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.reason).toMatch(/confidence/);
    expect(store.count()).toBe(0);
  });

  it('无 scope 的候选被丢弃', async () => {
    const noScope = JSON.stringify([
      {
        problem_category: 'x',
        trigger_conditions: 'y',
        recommended_action: 'z',
        confidence: 0.9,
      },
    ]);
    const gen = new CandidateGenerator(new MockLLMClient([noScope]), store);
    const r = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 's',
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/missing\/empty field: scope|invalid scope/);
  });

  it('非法 scope（不在白名单）被丢弃', async () => {
    const bad = JSON.stringify([
      {
        problem_category: 'x',
        trigger_conditions: 'y',
        recommended_action: 'z',
        scope: 'weird-scope',
        confidence: 0.9,
      },
    ]);
    const gen = new CandidateGenerator(new MockLLMClient([bad]), store);
    const r = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 's',
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/invalid scope/);
  });

  it('超过 3 条的候选被截断到 maxCandidatesPerReflect', async () => {
    const five = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        problem_category: `cat_${i}`,
        trigger_conditions: `trigger ${i}`,
        recommended_action: `action ${i}`,
        scope: 'general',
        confidence: 0.8,
      })),
    );
    const gen = new CandidateGenerator(new MockLLMClient([five]), store);
    const r = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 's',
    });
    expect(r.candidates).toHaveLength(3);
    expect(store.count()).toBe(3);
  });

  it('LLM 调用失败：不抛错，返回 error', async () => {
    const gen = new CandidateGenerator(new FailingLLMClient(), store);
    const r = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 's',
    });
    expect(r.triggered).toBe(true);
    expect(r.candidates).toHaveLength(0);
    expect(r.error).toMatch(/LLM call failed/);
    expect(store.count()).toBe(0);
  });

  it('LLM 返回无效 JSON：不抛错，返回 error', async () => {
    const gen = new CandidateGenerator(
      new MockLLMClient(['this is not json']),
      store,
    );
    const r = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 's',
    });
    expect(r.triggered).toBe(true);
    expect(r.candidates).toHaveLength(0);
    expect(r.error).toMatch(/JSON parse failed/);
  });

  it('LLM 返回非数组：不抛错，返回 error', async () => {
    const gen = new CandidateGenerator(
      new MockLLMClient(['{"foo": 1}']),
      store,
    );
    const r = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 's',
    });
    expect(r.error).toMatch(/not a JSON array/);
  });

  it('能剥离 markdown ```json 代码块', async () => {
    const wrapped = '```json\n' + VALID_LLM_RESPONSE + '\n```';
    const gen = new CandidateGenerator(new MockLLMClient([wrapped]), store);
    const r = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 's',
    });
    expect(r.persistedCount).toBe(1);
  });

  it('重复候选（相同 content-id）第二次写入时被识别为 duplicate', async () => {
    const gen = new CandidateGenerator(
      new MockLLMClient([VALID_LLM_RESPONSE, VALID_LLM_RESPONSE]),
      store,
    );

    const r1 = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 'a',
      manual: true,
    });
    expect(r1.persistedCount).toBe(1);

    const r2 = await gen.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 'b',
      manual: true,
    });
    // 同 content → 同 strategy_id → 被去重
    expect(r2.persistedCount).toBe(0);
    expect(r2.dropped[0]!.reason).toMatch(/duplicate_strategy_id/);
    expect(store.count()).toBe(1);
  });

  it('manual=true 即便没有错误事件也会触发并反思', async () => {
    const gen = new CandidateGenerator(
      new MockLLMClient([VALID_LLM_RESPONSE]),
      store,
    );
    const r = await gen.reflect({
      events: [CLEAN_EVENT],
      env: ENV,
      sessionId: 's',
      manual: true,
    });
    expect(r.triggered).toBe(true);
    expect(r.persistedCount).toBe(1);
  });

  it('生成的 strategy_id / instance_id 是 content-addressable（稳定）', async () => {
    const gen1 = new CandidateGenerator(
      new MockLLMClient([VALID_LLM_RESPONSE]),
      store,
    );
    const r1 = await gen1.reflect({
      events: [ERROR_EVENT],
      env: ENV,
      sessionId: 'first',
    });
    const sid1 = r1.candidates[0]!.strategy.strategy_id;
    const iid1 = r1.candidates[0]!.instance.instance_id;

    // 换另一个 store 再跑一次
    const tmp2 = mkdtempSync(join(tmpdir(), 'learning-loop-t005-'));
    const store2 = openCandidateStore({ dbPath: join(tmp2, 'c.db') });
    try {
      const gen2 = new CandidateGenerator(
        new MockLLMClient([VALID_LLM_RESPONSE]),
        store2,
      );
      const r2 = await gen2.reflect({
        events: [ERROR_EVENT],
        env: ENV,
        sessionId: 'second',
      });
      expect(r2.candidates[0]!.strategy.strategy_id).toBe(sid1);
      expect(r2.candidates[0]!.instance.instance_id).toBe(iid1);
    } finally {
      store2.close();
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 4. 默认配置合理性 smoke
// ===========================================================================

describe('defaults', () => {
  it('DEFAULT_GENERATOR_CONFIG 符合 §5.3.3', () => {
    expect(DEFAULT_GENERATOR_CONFIG.minConfidence).toBe(0.3);
    expect(DEFAULT_GENERATOR_CONFIG.maxCandidatesPerReflect).toBe(3);
  });
  it('DEFAULT_TRIGGER_CONFIG.timeWindowMs 为 6h', () => {
    expect(DEFAULT_TRIGGER_CONFIG.timeWindowMs).toBe(6 * 60 * 60 * 1000);
  });
});

// ===========================================================================
// 5. v1.1.0-alpha.4: summary / trigger_event / dropped_summary
// ===========================================================================

describe('alpha.4 rich metadata', () => {
  let tmpDir: string;
  let store: CandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cg-alpha4-'));
    store = openCandidateStore({
      dbPath: join(tmpDir, 'candidates.db'),
      candidatesDir: join(tmpDir, 'candidates'),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts summary field from LLM response', async () => {
    const response = JSON.stringify([{
      problem_category: 'test_summary',
      trigger_conditions: 'always',
      recommended_action: 'do stuff',
      scope: 'general',
      confidence: 0.8,
      summary: '当工具链报告测试通过但实际未验证时，不应做决策。',
      trigger_event: { id: 'evt_001', summary: 'pollinations 故障诊断' },
    }]);
    const llm = new MockLLMClient([response]);
    const gen = new CandidateGenerator(llm, store);
    const result = await gen.reflect({
      events: [{ type: 'error', timestamp: new Date(), content: 'fail', metadata: {} }],
      env: ENV, sessionId: 'sess-alpha4',
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.strategy.summary).toBe('当工具链报告测试通过但实际未验证时，不应做决策。');
    expect(result.candidates[0]!.strategy.trigger_event).toEqual({ id: 'evt_001', summary: 'pollinations 故障诊断' });
  });

  it('handles missing summary gracefully (undefined)', async () => {
    const response = JSON.stringify([{
      problem_category: 'no_summary',
      trigger_conditions: 'always',
      recommended_action: 'do stuff',
      scope: 'general',
      confidence: 0.8,
    }]);
    const llm = new MockLLMClient([response]);
    const gen = new CandidateGenerator(llm, store);
    const result = await gen.reflect({
      events: [{ type: 'error', timestamp: new Date(), content: 'fail', metadata: {} }],
      env: ENV, sessionId: 'sess-no-summary',
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.strategy.summary).toBeUndefined();
    expect(result.candidates[0]!.strategy.trigger_event).toBeUndefined();
  });

  it('classifies dropped reasons correctly', async () => {
    const response = JSON.stringify([
      { problem_category: 'x', trigger_conditions: 'y', recommended_action: 'z', scope: 'general', confidence: 0.1 },
      { problem_category: 'a', trigger_conditions: 'b', recommended_action: 'c', scope: 'INVALID_SCOPE', confidence: 0.8 },
    ]);
    const llm = new MockLLMClient([response]);
    const gen = new CandidateGenerator(llm, store);
    const result = await gen.reflect({
      events: [{ type: 'error', timestamp: new Date(), content: 'fail', metadata: {} }],
      env: ENV, sessionId: 'sess-dropped',
    });
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped[0]!.reason_code).toBe('low_confidence');
    expect(result.dropped[1]!.reason_code).toBe('schema_invalid');
  });

  it('parses {candidates: [...]} wrapper format', async () => {
    const response = JSON.stringify({ candidates: [{
      problem_category: 'wrapped',
      trigger_conditions: 'always',
      recommended_action: 'do',
      scope: 'general',
      confidence: 0.7,
      summary: '包装格式测试',
    }]});
    const llm = new MockLLMClient([response]);
    const gen = new CandidateGenerator(llm, store);
    const result = await gen.reflect({
      events: [{ type: 'error', timestamp: new Date(), content: 'fail', metadata: {} }],
      env: ENV, sessionId: 'sess-wrapped',
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.strategy.summary).toBe('包装格式测试');
  });
});
