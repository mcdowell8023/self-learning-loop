# E2E Testing Strategy — T-P1a-012

## Coverage Matrix

| # | Scenario | Modules Exercised | Assertion Type | Category |
|---|----------|-------------------|---------------|----------|
| E2E-01 | Happy path full pipeline | Gen→Review→Shadow→Eval→Grad | State flow + artifact write | Happy path |
| E2E-02 | State transition sequence | Gen→Review | State correctness | Happy path |
| E2E-03 | Audit log completeness | Gen→Review | Audit trail integrity | Audit |
| E2E-04 | Safety review rejection | Gen→Review | State=rejected | Abnormal |
| E2E-05 | Low confidence dropped | Gen | Dropped count + reason | Abnormal |
| E2E-06 | Insufficient trials → dormant | Gen→Review→Eval | Verdict=INCONCLUSIVE | Abnormal |
| E2E-07 | L1 assertion failure → retired | Gen→Review→Eval | Verdict=FAIL, L1=fail | Abnormal |
| E2E-08 | L2 regression → retired | Eval | L2=fail, verdict=FAIL_L2 | Abnormal |
| E2E-09 | force-graduate validating | Gen→Review→Override→Grad | State=graduated + artifact | Override |
| E2E-10 | force-retire graduated | Full pipeline→Override | State=retired | Override |
| E2E-11 | Config snapshot isolation | ConfigLoader | Independent copies | Config |
| E2E-12 | Review audit ordered | Gen→Review | Timestamps monotonic | Audit |
| E2E-13 | Override audit JSONL replay | Gen→Review→Override×2 | Timeline reconstruction | Audit |
| E2E-14 | candidate_id consistency | Full pipeline | Same ID across modules | Cross-module |
| E2E-15 | Content-addressable dedup | Gen×2 | Duplicate detection | Cross-module |
| E2E-16 | LLM failure graceful | Gen | No crash, error field set | Abnormal |
| E2E-17 | Test isolation | N/A | Workspace path validation | Safety |

## Minimum Sufficiency Argument

**Why these 17 tests and not others:**

1. **Happy path (E2E-01/02)** — Proves the core value: all 7 modules chain correctly. Without this, nothing else matters.
2. **3 abnormal paths (E2E-04/06/07)** — Each covers a distinct rejection point (Review, Shadow insufficiency, Evaluator L1). These are the three primary "no-go" branches in the state machine.
3. **Override (E2E-09/10)** — The escape hatch is safety-critical; if it breaks, operators lose manual control.
4. **Config snapshot (E2E-11)** — In-flight trial isolation is a correctness invariant, not a nice-to-have.
5. **Audit (E2E-12/13)** — Audit replay is a hard requirement from the design doc (§7). Two tests: one for ReviewGate audit sink, one for Override JSONL.
6. **Cross-module (E2E-14/15/16)** — Data flow integrity, dedup, and failure resilience are integration-specific concerns that unit tests can't cover.

**What we deliberately excluded:**
- Concurrent write stress (P1b scope, needs WAL tuning)
- SIGHUP config reload (not implemented in P1a)
- L3/L4 evaluation (interface-only in P1a)

## Flaky Prevention

| Risk | Mitigation |
|------|-----------|
| SQLite file locking | Each test gets `mkdtempSync` isolated dir; `afterEach` cleans up |
| Timestamp ordering | All timestamps injected via `now` parameter, never rely on `Date.now()` |
| Trial ID collision | Deterministic `trialIdFactory` with counter |
| Config loader singleton | `__resetConfigForTests()` in `beforeEach` |
| Async race conditions | No real I/O or timers; all LLM calls are sync-resolved mock |

## CI Integration

- **Timeout:** 30s per test file (current wall time ~1.5s, 20x margin)
- **Parallelism:** Safe to run with `vitest --pool=forks` (each test has isolated tmp dir)
- **No external deps:** Zero network calls, zero real LLM, zero real filesystem outside tmp
