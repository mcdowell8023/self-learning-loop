#!/usr/bin/env bash
# setup.test.sh — Self-contained tests for scripts/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SETUP="$SCRIPT_DIR/scripts/setup.sh"
UNINSTALL="$SCRIPT_DIR/scripts/uninstall.sh"

PASS=0; FAIL=0; TOTAL=0

assert() {
  local name="$1"; shift
  TOTAL=$((TOTAL + 1))
  if "$@"; then
    echo "  ✅ PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_contains() {
  local name="$1" pattern="$2" output="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$output" | grep -q "$pattern"; then
    echo "  ✅ PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $name (pattern '$pattern' not found)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== setup.sh test suite ==="
echo ""

# ─── Test 1: Syntax check ───────────────────────────
echo "Test 1: bash -n syntax check"
assert "setup.sh passes bash -n" bash -n "$SETUP"
assert "uninstall.sh passes bash -n" bash -n "$UNINSTALL"

# ─── Test 2: --help works ───────────────────────────
echo "Test 2: --help flag"
help_out="$(bash "$SETUP" --help 2>&1 || true)"
assert_output_contains "--help shows usage" "Usage:" "$help_out"

# ─── Test 3: --dry-run --mode local outputs expected actions ─
echo "Test 3: dry-run local mode"
dry_out="$(bash "$SETUP" --dry-run --mode local 2>&1 || true)"
assert_output_contains "dry-run mentions DRY-RUN" "DRY-RUN" "$dry_out"
assert_output_contains "dry-run mentions skill symlink" "self-learning-loop" "$dry_out"
assert_output_contains "dry-run mentions CLI registration" "openclaw-learn" "$dry_out"

# ─── Test 4: --dry-run --mode global ─────────────────
echo "Test 4: dry-run global mode"
global_out="$(bash "$SETUP" --dry-run --mode global 2>&1 || true)"
assert_output_contains "global mode mentions shared location" "global" "$global_out"
assert_output_contains "global mode mentions .local/share" ".local/share" "$global_out"

# ─── Test 5: Invalid mode rejected ──────────────────
echo "Test 5: invalid mode rejected"
invalid_out="$(bash "$SETUP" --mode bogus 2>&1 || true)"
assert_output_contains "invalid mode shows error" "Invalid mode" "$invalid_out"

# ─── Test 6: --dry-run --runtime with non-existent runtime ──
echo "Test 6: dry-run with explicit runtime"
rt_out="$(bash "$SETUP" --dry-run --mode local --runtime openclaw 2>&1 || true)"
assert_output_contains "explicit runtime accepted" "openclaw" "$rt_out"

# ─── Test 7: Idempotent — run dry-run twice, same output ────
echo "Test 7: idempotent dry-run"
dry_out2="$(bash "$SETUP" --dry-run --mode local 2>&1 || true)"
TOTAL=$((TOTAL + 1))
if [[ "$dry_out" == "$dry_out2" ]]; then
  echo "  ✅ PASS: idempotent — same output on second run"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: output differs between runs"
  FAIL=$((FAIL + 1))
fi

# ─── Test 8: uninstall --dry-run ─────────────────────
echo "Test 8: uninstall dry-run"
uninst_out="$(bash "$UNINSTALL" --dry-run --force 2>&1 || true)"
assert_output_contains "uninstall dry-run mentions DRY-RUN" "DRY-RUN" "$uninst_out"

# ─── Summary ─────────────────────────────────────────
echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
