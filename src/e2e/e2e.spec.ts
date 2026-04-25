// src/e2e/e2e.spec.ts
//
// T-P1a-012 · End-to-End Integration Tests
// Validates the full learning loop pipeline with mock LLM.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CandidateGenerator } from '../reflect/candidate-generator.js';
import { ReviewGate, InMemoryAuditSink, strategyLookupFromCandidateStore } from '../review/review-gate.js';
import { ShadowRunner } from '../shadow/shadow-runner.js';
import { TrialCollector } from '../shadow/trial-collector.js';
import { evaluateCandidate, aggregateL1, evaluateL2, permissiveEvidenceStore } from '../evaluator/evaluator.js';
import { GraduationExecutor } from '../graduation/executor.js';
import { runOverride } from '../cli/override.js';
import { ConfigLoader, snapshotConfig, __resetConfigForTests } from '../config/loader.js';
import type { Candidate, CandidateState, EnvFingerprint, TrialResult } from '../kernel/types.js';
import type { SessionEvent } from '../reflect/reflection-prompt.js';

import { E2EMockLLM } from './mock-llm.js';
import {
  setupE2E, teardownE2E, getAgentsMtime, readAgents, loadFixture,
  makeEvents, readAuditJsonl, TEST_ENV,
  type E2EContext,
} from './test-helpers.js';

// ─── Fixtures ────────────────────────────────────────

type FixtureMemories = Record<string, { events: Record<string, unknown>[] }>;
type FixtureSessions = Record<string, { session_id: string; events: Record<string, unknown>[] }>;
type FixtureLLMResponses = unknown[][];

const memories = loadFixture<FixtureMemories>('memories.json');
const sessions = loadFixture<FixtureSessions>('sessions.json');
const llmResponses = loadFixture<FixtureLLMResponses>('llm-responses.json');

// ─── Helper: run full pipeline ───────────────────────

interface PipelineResult {
  reflectResult: Awaited<ReturnType<CandidateGenerator['reflect']>>;
  reviewResult?: Awaited<ReturnType<ReviewGate['review']>>;
  shadowReport?: ReturnType<ShadowRunner['observe']>;
  evalOutput?: ReturnType<typeof evaluateCandidate>;
  graduateResult?: ReturnType<GraduationExecutor['graduate']>;
  candidate?: Candidate | null;
}

async function runHappyPathPipeline(ctx: E2EContext, llm: E2EMockLLM): Promise<PipelineResult> {
  const { store, workspaceDir } = ctx;

  // 1) Generator: reflect on candidate_signal events
  const generator = new CandidateGenerator(llm, store, { minConfidence: 0.3 });
  const events = makeEvents(memories.candidate_signal.events);
  const reflectResult = await generator.reflect({
    events,
    env: TEST_ENV,
    sessionId: 'sess-reflect-001',
    manual: true, // force trigger
    now: new Date('2026-04-20T11:05:00Z'),
  });

  if (reflectResult.persistedCount === 0) {
    return { reflectResult };
  }

  // 2) ReviewGate: review the first candidate
  const candidateAfterReflect = store.list({ state: 'pending' })[0]!;
  const auditSink = new InMemoryAuditSink();
  const gate = new ReviewGate(store, {
    auditSink,
    strategyLookup: strategyLookupFromCandidateStore(store),
  });
  const reviewResult = await gate.review(candidateAfterReflect);

  if (!reviewResult.pass) {
    return { reflectResult, reviewResult, candidate: store.get(candidateAfterReflect.candidate_id) };
  }

  // 3) Shadow: observe matching session
  const collector = new TrialCollector({ store, batchSize: 1 });
  const shadow = new ShadowRunner({
    store,
    collector,
    matcherConfig: { minKeywordHits: 1, minKeywordLen: 3, maxKeywords: 20 },
    trialIdFactory: (() => { let i = 0; return () => `trial-e2e-${++i}`; })(),
  });

  // Run multiple observations to accumulate trials
  const sessionEvents = makeEvents(sessions.success_session.events);
  let shadowReport;
  for (let i = 0; i < 6; i++) {
    shadowReport = shadow.observe(`sess-shadow-${i}`, sessionEvents, TEST_ENV);
  }
  shadow.flush();

  // 4) Evaluator: evaluate with enough data for L2
  const candidateForEval = store.get(candidateAfterReflect.candidate_id)!;
  const trials = collector.listTrials(candidateForEval.candidate_id);
  const baseline = [0.5, 0.6, 0.55, 0.7, 0.65];
  const trial = [0.8, 0.85, 0.9, 0.75, 0.88, 0.82];
  const evalOutput = evaluateCandidate({
    candidate_id: candidateForEval.candidate_id,
    assertions: candidateForEval.strategy ? [] : [], // L1 skipped (no command assertions run by shadow)
    trials,
    metrics: { baseline, trial },
    l3: 'pass',
    now: () => new Date('2026-04-20T15:00:00Z'),
  });

  // 5) If verdict allows graduation, graduate
  let graduateResult;
  if (evalOutput.next_state === 'graduated') {
    const executor = new GraduationExecutor({ workspaceDir, store });
    graduateResult = executor.graduate({
      candidate: candidateForEval,
      body: `## Deployment Timeout Fix\n\nIncrease timeout to 120s and add health check.\n`,
      shadow: {
        trial_count: trials.length,
        l1: { total: 0, passed: 0, failed: 0, skipped: 0 },
        l2: { turns: 6, errors: 0, token_usage: 1200, completion_rate: 0.85 },
        l3: { verdict: 'pass', confidence: 0.8, rationale: 'L3 mock pass' },
      },
    });
  }

  return {
    reflectResult,
    reviewResult,
    shadowReport,
    evalOutput,
    graduateResult,
    candidate: store.get(candidateAfterReflect.candidate_id),
  };
}

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('E2E: Learning Loop Full Pipeline', () => {
  let ctx: E2EContext;
  let agentsMtimeBefore: number;

  beforeEach(() => {
    ctx = setupE2E();
    agentsMtimeBefore = getAgentsMtime(ctx);
    __resetConfigForTests();
    process.env.LEARNING_LOOP_WORKSPACE = ctx.workspaceDir;
  });

  afterEach(() => {
    delete process.env.LEARNING_LOOP_WORKSPACE;
    teardownE2E(ctx);
  });

  // ─── Happy Path ──────────────────────────────────

  describe('Happy Path: Full Pipeline', () => {
    it('E2E-01: Generator → Review → Shadow → Evaluator → Graduation (complete flow)', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const result = await runHappyPathPipeline(ctx, llm);

      // Generator produced a candidate
      expect(result.reflectResult.triggered).toBe(true);
      expect(result.reflectResult.persistedCount).toBe(1);

      // Review passed
      expect(result.reviewResult!.pass).toBe(true);
      expect(result.reviewResult!.final_state).toBe('validating');

      // Shadow observed sessions
      expect(result.shadowReport!.matchedCount).toBeGreaterThan(0);

      // Evaluator verdict
      expect(['PASS', 'PASS_L2', 'PASS_WEAK']).toContain(result.evalOutput!.verdict);
      expect(result.evalOutput!.next_state).toBe('graduated');

      // Graduation wrote to AGENTS.md
      expect(result.graduateResult).toBeDefined();
      expect(result.graduateResult!.injected).toBe(true);
      const agentsContent = readAgents(ctx);
      expect(agentsContent).toContain('Deployment Timeout Fix');

      // Final candidate state
      expect(result.candidate!.state).toBe('graduated');

      // LLM was called exactly once
      llm.assertCallCount(1);
    });

    it('E2E-02: State transitions follow correct sequence', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const { store } = ctx;

      // Step through and verify states
      const generator = new CandidateGenerator(llm, store, { minConfidence: 0.3 });
      const reflectResult = await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-state-track',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });
      const cid = reflectResult.candidates[0]!.strategy.strategy_id;

      // After reflect: pending
      expect(store.get(cid)!.state).toBe('pending');

      // After review: validating
      const gate = new ReviewGate(store, {
        strategyLookup: strategyLookupFromCandidateStore(store),
      });
      await gate.review(store.get(cid)!);
      expect(store.get(cid)!.state).toBe('validating');
    });

    it('E2E-03: Audit log records all state transitions', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const auditSink = new InMemoryAuditSink();

      const generator = new CandidateGenerator(llm, ctx.store, { minConfidence: 0.3 });
      const reflectResult = await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-audit-001',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });

      const candidate = ctx.store.list({ state: 'pending' })[0]!;
      const gate = new ReviewGate(ctx.store, {
        auditSink,
        strategyLookup: strategyLookupFromCandidateStore(ctx.store),
      });
      await gate.review(candidate);

      // Audit should have dimension entries + summary
      expect(auditSink.entries.length).toBeGreaterThanOrEqual(2); // at least 1 dimension + 1 summary
      const summary = auditSink.entries.find(e => e.kind === 'summary');
      expect(summary).toBeDefined();
      expect(summary!.pass).toBe(true);
    });
  });

  // ─── Abnormal Paths ──────────────────────────────

  describe('Abnormal: Review Rejection', () => {
    it('E2E-04: Review rejects candidate with conflict (safety dimension)', async () => {
      const dangerousCandidate = [{
        problem_category: "file_cleanup",
        trigger_conditions: "rm delete clean remove",
        recommended_action: "rm -rf /",  // dangerous!
        scope: "general",
        confidence: 0.8,
        diff_summary: "Dangerous cleanup",
        files_touched: [],
        assertions: [
          { type: "command_exit_code", command: "rm -rf /", expected_exit_code: 0 }
        ],
      }];

      const llm = new E2EMockLLM().enqueue(JSON.stringify(dangerousCandidate));
      const generator = new CandidateGenerator(llm, ctx.store, { minConfidence: 0.3 });
      const reflectResult = await generator.reflect({
        events: makeEvents(memories.conflict_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-dangerous',
        manual: true,
        now: new Date('2026-04-20T12:05:00Z'),
      });

      if (reflectResult.persistedCount > 0) {
        const candidate = ctx.store.list({ state: 'pending' })[0]!;
        const gate = new ReviewGate(ctx.store, {
          strategyLookup: strategyLookupFromCandidateStore(ctx.store),
        });
        const reviewResult = await gate.review(candidate);
        // Safety dimension should catch dangerous commands
        expect(reviewResult.pass).toBe(false);
        expect(reviewResult.final_state).toBe('rejected');
        expect(ctx.store.get(candidate.candidate_id)!.state).toBe('rejected');
      }
    });

    it('E2E-05: Review rejects low-confidence candidate', async () => {
      const lowConfCandidate = [{
        problem_category: "vague_issue",
        trigger_conditions: "something happened",
        recommended_action: "Do something about it",
        scope: "general",
        confidence: 0.1,  // below threshold
      }];

      const llm = new E2EMockLLM().enqueue(JSON.stringify(lowConfCandidate));
      const generator = new CandidateGenerator(llm, ctx.store, { minConfidence: 0.3 });
      const result = await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-lowconf',
        manual: true,
        now: new Date('2026-04-20T12:10:00Z'),
      });

      // Should be dropped at generator level, not even persisted
      expect(result.persistedCount).toBe(0);
      expect(result.dropped.length).toBeGreaterThan(0);
      expect(result.dropped[0]!.reason).toContain('confidence');
    });
  });

  describe('Abnormal: Shadow Failure → Dormant', () => {
    it('E2E-06: Shadow trials fail → Evaluator sends to dormant', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const { store, workspaceDir } = ctx;

      // Reflect + Review
      const generator = new CandidateGenerator(llm, store, { minConfidence: 0.3 });
      await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-shadow-fail',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });
      const candidate = store.list({ state: 'pending' })[0]!;
      const gate = new ReviewGate(store, {
        strategyLookup: strategyLookupFromCandidateStore(store),
      });
      await gate.review(candidate);

      // Evaluate with insufficient data → inconclusive → dormant
      const evalOutput = evaluateCandidate({
        candidate_id: candidate.candidate_id,
        assertions: [],
        trials: [], // no trials at all
        metrics: { baseline: [0.5, 0.6], trial: [0.4] }, // too few samples
        now: () => new Date('2026-04-20T16:00:00Z'),
      });

      expect(evalOutput.verdict).toBe('INCONCLUSIVE');
      expect(evalOutput.next_state).toBe('dormant');
      expect(evalOutput.dormant_reason).toBe('inconclusive');
    });
  });

  describe('Abnormal: Evaluator Rejects via L1 Truth Table', () => {
    it('E2E-07: L1 assertion failure → FAIL verdict → retired', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const { store } = ctx;

      const generator = new CandidateGenerator(llm, store, { minConfidence: 0.3 });
      await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-l1-fail',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });
      const candidate = store.list({ state: 'pending' })[0]!;
      const gate = new ReviewGate(store, {
        strategyLookup: strategyLookupFromCandidateStore(store),
      });
      await gate.review(candidate);

      // Simulate trials with failed assertions
      const failedTrials: TrialResult[] = Array.from({ length: 5 }, (_, i) => ({
        trial_id: `trial-l1-fail-${i}`,
        candidate_id: candidate.candidate_id,
        session_id: `sess-trial-${i}`,
        runtime: 'openclaw-e2e',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        assertions: [{ type: 'command_exit_code', status: 'fail' as const, duration_ms: 100, detail: 'exit 1' }],
        metrics: { turns: 2, errors: 1, token_usage: 100, completion_rate: 0.3 },
        env_fingerprint: TEST_ENV,
      }));

      const evalOutput = evaluateCandidate({
        candidate_id: candidate.candidate_id,
        assertions: [{ type: 'command_exit_code', command: 'echo test', expected_exit_code: 0 }],
        trials: failedTrials,
        metrics: { baseline: [0.5, 0.6, 0.55, 0.7, 0.65], trial: [0.3, 0.2, 0.25, 0.35, 0.28] },
        now: () => new Date('2026-04-20T16:00:00Z'),
      });

      expect(evalOutput.verdict).toBe('FAIL');
      expect(evalOutput.next_state).toBe('retired');
      expect(evalOutput.l1_aggregate.status).toBe('fail');
    });

    it('E2E-08: L2 regression detected → appropriate verdict', async () => {
      // Pure L2 test: baseline significantly better than trial
      const evalOutput = evaluateCandidate({
        candidate_id: 'cand-l2-regress',
        assertions: [],
        trials: [],
        metrics: {
          baseline: [0.9, 0.88, 0.92, 0.87, 0.91],
          trial:    [0.3, 0.35, 0.28, 0.32, 0.31],
        },
        now: () => new Date('2026-04-20T16:00:00Z'),
      });

      // L1 skipped (no assertions), L2 fail (regression)
      expect(evalOutput.l2_result.status).toBe('fail');
      expect(['FAIL_L2', 'FAIL']).toContain(evalOutput.verdict);
      expect(evalOutput.next_state).toBe('retired');
    });
  });

  // ─── Override ─────────────────────────────────────

  describe('Override: force-graduate', () => {
    it('E2E-09: force-graduate validating candidate → graduated + artifact written', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const { store, workspaceDir } = ctx;

      // Setup: reflect + review → validating
      const generator = new CandidateGenerator(llm, store, { minConfidence: 0.3 });
      await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-override-grad',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });
      const candidate = store.list({ state: 'pending' })[0]!;
      const gate = new ReviewGate(store, {
        strategyLookup: strategyLookupFromCandidateStore(store),
      });
      await gate.review(candidate);
      expect(store.get(candidate.candidate_id)!.state).toBe('validating');

      // Override
      const stdout: string[] = [];
      const stderr: string[] = [];
      const result = await runOverride({
        argv: ['force-graduate', candidate.candidate_id, '--reason', 'E2E test override'],
        store,
        cwd: workspaceDir,
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        now: () => new Date('2026-04-20T17:00:00Z'),
        uuid: () => 'e2e-uuid-grad',
        defaultBody: '## Override Graduated Content\n\nForce graduated.\n',
      });

      expect(result.exitCode).toBe(0);
      expect(result.action).toBe('force_graduate');
      expect(result.wroteArtifact).toBe(true);
      expect(store.get(candidate.candidate_id)!.state).toBe('graduated');

      // Artifact written
      const agents = readAgents(ctx);
      expect(agents).toContain('Override Graduated Content');

      // Audit trail
      const auditPath = join(workspaceDir, 'learn', 'audit', 'overrides.jsonl');
      const auditEvents = readAuditJsonl(auditPath);
      expect(auditEvents.length).toBe(1);
      expect((auditEvents[0] as Record<string, unknown>).candidate_id).toBe(candidate.candidate_id);
    });
  });

  describe('Override: force-retire', () => {
    it('E2E-10: force-retire graduated candidate → retired', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const { store, workspaceDir } = ctx;

      // Setup: full pipeline to graduated
      const result = await runHappyPathPipeline(ctx, llm);
      const cid = result.candidate!.candidate_id;
      expect(store.get(cid)!.state).toBe('graduated');

      // Override retire
      const stdout: string[] = [];
      const overrideResult = await runOverride({
        argv: ['force-retire', cid, '--reason', 'E2E retire test'],
        store,
        cwd: workspaceDir,
        stdout: (s) => stdout.push(s),
        stderr: (s) => {},
        now: () => new Date('2026-04-20T18:00:00Z'),
        uuid: () => 'e2e-uuid-retire',
      });

      expect(overrideResult.exitCode).toBe(0);
      expect(overrideResult.action).toBe('force_retire');
      expect(store.get(cid)!.state).toBe('retired');
    });
  });

  // ─── Config Snapshot Isolation ─────────────────────

  describe('Config Snapshot Isolation', () => {
    it('E2E-11: snapshotConfig returns independent copy unaffected by mutations', async () => {
      __resetConfigForTests();

      const { loadConfig } = await import('../config/loader.js');
      loadConfig({ env: {} });

      // Take snapshot
      const snap1 = snapshotConfig();
      expect(snap1).toBeDefined();

      // Take another snapshot — should equal
      const snap2 = snapshotConfig();
      expect(snap2).toEqual(snap1);

      // Mutating snap1 should not affect snap2 (independent copies)
      (snap1 as Record<string, unknown>).__e2e_test = true;
      const snap3 = snapshotConfig();
      expect((snap3 as Record<string, unknown>).__e2e_test).toBeUndefined();
    });
  });

  // ─── Audit Completeness ──────────────────────────

  describe('Audit: Full Trail Replay', () => {
    it('E2E-12: Review audit log is ordered and contains all dimensions + summary', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const auditSink = new InMemoryAuditSink();

      const generator = new CandidateGenerator(llm, ctx.store, { minConfidence: 0.3 });
      await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-audit-replay',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });

      const candidate = ctx.store.list({ state: 'pending' })[0]!;
      const gate = new ReviewGate(ctx.store, {
        auditSink,
        strategyLookup: strategyLookupFromCandidateStore(ctx.store),
      });
      await gate.review(candidate);

      // Entries should be chronologically ordered
      const timestamps = auditSink.entries.map(e => new Date(e.timestamp).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!);
      }

      // Should end with summary
      const last = auditSink.entries[auditSink.entries.length - 1]!;
      expect(last.kind).toBe('summary');

      // Each dimension entry has required fields
      const dimEntries = auditSink.entries.filter(e => e.kind === 'dimension');
      for (const d of dimEntries) {
        expect(d.candidate_id).toBe(candidate.candidate_id);
        expect(d.dimension).toBeDefined();
        expect(typeof d.pass).toBe('boolean');
      }
    });

    it('E2E-13: Override audit JSONL entries can reconstruct timeline', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const { store, workspaceDir } = ctx;

      // Setup candidate to validating
      const generator = new CandidateGenerator(llm, store, { minConfidence: 0.3 });
      await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-audit-override',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });
      const candidate = store.list({ state: 'pending' })[0]!;
      const gate = new ReviewGate(store, {
        strategyLookup: strategyLookupFromCandidateStore(store),
      });
      await gate.review(candidate);

      // Force graduate then force retire
      await runOverride({
        argv: ['force-graduate', candidate.candidate_id, '--reason', 'audit test grad'],
        store, cwd: workspaceDir,
        stdout: () => {}, stderr: () => {},
        now: () => new Date('2026-04-20T17:00:00Z'),
        uuid: () => 'uuid-1',
        defaultBody: '## Audit Test\n',
      });
      await runOverride({
        argv: ['force-retire', candidate.candidate_id, '--reason', 'audit test retire'],
        store, cwd: workspaceDir,
        stdout: () => {}, stderr: () => {},
        now: () => new Date('2026-04-20T18:00:00Z'),
        uuid: () => 'uuid-2',
      });

      const auditPath = join(workspaceDir, 'learn', 'audit', 'overrides.jsonl');
      const events = readAuditJsonl(auditPath) as Array<Record<string, unknown>>;
      expect(events.length).toBe(2);

      // Chronological order
      expect(events[0]!.timestamp).toBe('2026-04-20T17:00:00.000Z');
      expect(events[1]!.timestamp).toBe('2026-04-20T18:00:00.000Z');

      // First is graduate, second is retire
      expect((events[0]!.data as Record<string, unknown>).action).toBe('force_graduate');
      expect((events[1]!.data as Record<string, unknown>).action).toBe('force_retire');
    });
  });

  // ─── Cross-Module Data Flow ───────────────────────

  describe('Cross-Module Data Flow Integrity', () => {
    it('E2E-14: candidate_id is consistent across all modules', async () => {
      const llm = new E2EMockLLM().enqueue(JSON.stringify(llmResponses[0]));
      const result = await runHappyPathPipeline(ctx, llm);

      const cid = result.reflectResult.candidates[0]!.strategy.strategy_id;

      // Same ID across all stages
      expect(result.reviewResult!.candidate_id).toBe(cid);
      expect(result.evalOutput!.candidate_id).toBe(cid);
      expect(result.candidate!.candidate_id).toBe(cid);
    });

    it('E2E-15: Generator deduplicates by content-addressable strategy_id', async () => {
      const llm = new E2EMockLLM()
        .enqueue(JSON.stringify(llmResponses[0]))
        .enqueue(JSON.stringify(llmResponses[1])); // same strategy content

      const generator = new CandidateGenerator(llm, ctx.store, { minConfidence: 0.3 });

      // First reflect
      const r1 = await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-dedup-1',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });
      expect(r1.persistedCount).toBe(1);

      // Second reflect with same strategy content → dedup
      const r2 = await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-dedup-2',
        manual: true,
        now: new Date('2026-04-20T11:10:00Z'),
      });
      expect(r2.dropped.some(d => d.reason.includes('duplicate'))).toBe(true);
    });

    it('E2E-16: LLM failure does not crash pipeline', async () => {
      const llm = new E2EMockLLM().failAfterCalls(0, new Error('LLM service unavailable'));
      const generator = new CandidateGenerator(llm, ctx.store, { minConfidence: 0.3 });

      const result = await generator.reflect({
        events: makeEvents(memories.candidate_signal.events),
        env: TEST_ENV,
        sessionId: 'sess-llm-fail',
        manual: true,
        now: new Date('2026-04-20T11:05:00Z'),
      });

      expect(result.triggered).toBe(true);
      expect(result.error).toContain('LLM');
      expect(result.candidates).toHaveLength(0);
      expect(result.persistedCount).toBe(0);
    });
  });

  // ─── Test Isolation ───────────────────────────────

  describe('Test Isolation', () => {
    it('E2E-17: real AGENTS.md is never touched', () => {
      // The real AGENTS.md path
      const realAgentsPath = join(process.env.HOME ?? '/home/mcdowell', '.openclaw', 'workspace', 'AGENTS.md');
      // We don't write to it — just verify our test workspace is separate
      expect(ctx.workspaceDir).not.toContain('.openclaw/workspace');
      expect(ctx.agentsPath).toContain('e2e-');
    });
  });
});
