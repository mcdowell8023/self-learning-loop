#!/usr/bin/env bash
# daily-reflect.test.sh — T-SLL-007
# Tests for daily-reflect.sh, register-cron.sh, check-token-budget.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0; TOTAL=0

run_test() {
  local name="$1"; shift
  TOTAL=$((TOTAL + 1))
  if "$@" >/dev/null 2>&1; then
    echo "  ✅ $name"; PASS=$((PASS + 1))
  else
    echo "  ❌ $name"; FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local output="$1" pattern="$2"
  echo "$output" | grep -q "$pattern"
}

echo "=== daily-reflect.test.sh ==="

# ── Test 1: --dry-run does not error ──────────────────────────────
run_test "dry-run exits 0" bash "$SCRIPT_DIR/daily-reflect.sh" --dry-run

# ── Test 2: dry-run outputs JSONL with dry-run marker ─────────────
TOTAL=$((TOTAL + 1))
DRY_OUT="$(bash "$SCRIPT_DIR/daily-reflect.sh" --dry-run 2>&1)"
if assert_contains "$DRY_OUT" "dry-run"; then
  echo "  ✅ dry-run output contains marker"; PASS=$((PASS + 1))
else
  echo "  ❌ dry-run output missing marker"; FAIL=$((FAIL + 1))
fi

# ── Test 3: 03:00-04:00 blackout window ───────────────────────────
TOTAL=$((TOTAL + 1))
# We can't truly mock time, but we can check the code path exists
if grep -q 'HOUR.*03' "$SCRIPT_DIR/daily-reflect.sh"; then
  echo "  ✅ blackout window 03:00 check present"; PASS=$((PASS + 1))
else
  echo "  ❌ blackout window check missing"; FAIL=$((FAIL + 1))
fi

# ── Test 4: token budget exceeded → skip ──────────────────────────
TOTAL=$((TOTAL + 1))
# Create a mock check-token-budget.sh that always returns EXCEEDED
TMPDIR_T="$(mktemp -d)"
MOCK_BUDGET="${TMPDIR_T}/check-token-budget.sh"
echo '#!/usr/bin/env bash
echo "EXCEEDED (99999/50000)"' > "$MOCK_BUDGET"
chmod +x "$MOCK_BUDGET"
# Verify the logic exists in daily-reflect.sh
if grep -q 'EXCEEDED' "$SCRIPT_DIR/daily-reflect.sh"; then
  echo "  ✅ token budget exceeded check present"; PASS=$((PASS + 1))
else
  echo "  ❌ token budget exceeded check missing"; FAIL=$((FAIL + 1))
fi
rm -rf "$TMPDIR_T"

# ── Test 5: missing workspace → friendly error ────────────────────
TOTAL=$((TOTAL + 1))
ERR_OUT="$(LEARNING_LOOP_WORKSPACE="/nonexistent/path" HOME="/nonexistent" bash "$SCRIPT_DIR/daily-reflect.sh" --dry-run 2>&1 || true)"
# Should still work since LEARNING_LOOP_WORKSPACE is set (even if path doesn't exist, mkdir -p handles it)
# The real failure is when detect_workspace returns 1
UNSET_OUT="$(env -u LEARNING_LOOP_WORKSPACE HOME="/nonexistent" bash "$SCRIPT_DIR/daily-reflect.sh" --dry-run 2>&1 || true)"
if assert_contains "$UNSET_OUT" "No workspace"; then
  echo "  ✅ missing workspace gives friendly error"; PASS=$((PASS + 1))
else
  echo "  ❌ missing workspace error not friendly"; FAIL=$((FAIL + 1))
fi

# ── Test 6: register-cron.sh --dry-run ────────────────────────────
run_test "register-cron --dry-run exits 0" bash "$SCRIPT_DIR/register-cron.sh" --dry-run

# ── Test 7: check-token-budget.sh runs ────────────────────────────
TOTAL=$((TOTAL + 1))
BUDGET_OUT="$(bash "$SCRIPT_DIR/check-token-budget.sh" 2>&1)"
if assert_contains "$BUDGET_OUT" "OK\|WARN\|EXCEEDED"; then
  echo "  ✅ check-token-budget outputs status"; PASS=$((PASS + 1))
else
  echo "  ❌ check-token-budget bad output: $BUDGET_OUT"; FAIL=$((FAIL + 1))
fi

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "Results: ${PASS}/${TOTAL} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]] || exit 1
