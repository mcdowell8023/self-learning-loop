#!/usr/bin/env bash
# setup.test.sh — Isolated tests for scripts/setup.sh & uninstall.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SETUP="$SCRIPT_DIR/scripts/setup.sh"
UNINSTALL="$SCRIPT_DIR/scripts/uninstall.sh"

PASS=0; FAIL=0; TOTAL=0
FAKE_HOME=""

assert() {
  local name="$1"; shift
  TOTAL=$((TOTAL + 1))
  if "$@" 2>/dev/null; then
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

assert_output_not_contains() {
  local name="$1" pattern="$2" output="$3"
  TOTAL=$((TOTAL + 1))
  if ! echo "$output" | grep -q "$pattern"; then
    echo "  ✅ PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL: $name (pattern '$pattern' unexpectedly found)"
    FAIL=$((FAIL + 1))
  fi
}

# Create isolated fake HOME with runtime dirs
setup_fake_home() {
  FAKE_HOME="$(mktemp -d)"
  mkdir -p "$FAKE_HOME/.openclaw/workspace/skills"
  mkdir -p "$FAKE_HOME/.claude"
  mkdir -p "$FAKE_HOME/.local/share/opencode"
  mkdir -p "$FAKE_HOME/.codex"
  mkdir -p "$FAKE_HOME/.local/bin"
}

cleanup_fake_home() {
  [[ -n "$FAKE_HOME" && -d "$FAKE_HOME" ]] && rm -rf "$FAKE_HOME"
}

# Run setup.sh with fake HOME
run_setup() {
  HOME="$FAKE_HOME" bash "$SETUP" "$@" 2>&1
}

# Run uninstall.sh with fake HOME
run_uninstall() {
  HOME="$FAKE_HOME" bash "$UNINSTALL" "$@" 2>&1
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
assert_output_contains "--help shows modes" "local|global|npm" "$help_out"

# ─── Test 3: Invalid mode rejected ──────────────────
echo "Test 3: invalid mode rejected"
invalid_out="$(bash "$SETUP" --mode bogus 2>&1 || true)"
assert_output_contains "invalid mode shows error" "Invalid mode" "$invalid_out"

# ─── Test 4: dry-run local mode (isolated) ──────────
echo "Test 4: dry-run local mode (isolated)"
setup_fake_home
dry_local="$(run_setup --dry-run --mode local)"
assert_output_contains "dry-run local mentions DRY-RUN" "DRY-RUN" "$dry_local"
assert_output_contains "dry-run local mentions self-learning-loop" "self-learning-loop" "$dry_local"
assert_output_contains "dry-run local mentions CLI" "openclaw-learn" "$dry_local"
cleanup_fake_home

# ─── Test 5: dry-run global mode (isolated) ─────────
echo "Test 5: dry-run global mode (isolated)"
setup_fake_home
dry_global="$(run_setup --dry-run --mode global)"
assert_output_contains "global mode mentions global" "global" "$dry_global"
assert_output_contains "global mode mentions shared" ".local/share" "$dry_global"
cleanup_fake_home

# ─── Test 6: dry-run npm mode ───────────────────────
echo "Test 6: dry-run npm mode"
setup_fake_home
dry_npm="$(run_setup --dry-run --mode npm)"
assert_output_contains "npm mode mentions npm" "npm" "$dry_npm"
cleanup_fake_home

# ─── Test 7: auto-detect runtimes (isolated) ────────
echo "Test 7: auto-detect runtimes"
setup_fake_home
detect_out="$(run_setup --dry-run --mode local)"
assert_output_contains "detects openclaw" "openclaw" "$detect_out"
assert_output_contains "detects claude-code" "claude-code" "$detect_out"
assert_output_contains "detects opencode" "opencode" "$detect_out"
assert_output_contains "detects codex" "codex" "$detect_out"
cleanup_fake_home

# ─── Test 8: auto-detect with only openclaw ─────────
echo "Test 8: auto-detect with only openclaw runtime"
FAKE_HOME="$(mktemp -d)"
mkdir -p "$FAKE_HOME/.openclaw/workspace/skills"
mkdir -p "$FAKE_HOME/.local/bin"
detect_one="$(run_setup --dry-run --mode local)"
assert_output_contains "detects only openclaw" "openclaw" "$detect_one"
assert_output_not_contains "no claude-code detected" "claude-code" "$detect_one"
cleanup_fake_home

# ─── Test 9: explicit runtime ───────────────────────
echo "Test 9: explicit --runtime"
setup_fake_home
rt_out="$(run_setup --dry-run --mode local --runtime codex)"
assert_output_contains "explicit codex runtime accepted" "codex" "$rt_out"
cleanup_fake_home

# ─── Test 10: dry-run idempotent ─────────────────────
echo "Test 10: idempotent dry-run"
setup_fake_home
out1="$(run_setup --dry-run --mode local --runtime openclaw)"
out2="$(run_setup --dry-run --mode local --runtime openclaw)"
TOTAL=$((TOTAL + 1))
if [[ "$out1" == "$out2" ]]; then
  echo "  ✅ PASS: idempotent — same output on second run"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: output differs between runs"
  FAIL=$((FAIL + 1))
fi
cleanup_fake_home

# ─── Test 11: real local install + verify + uninstall (isolated) ──
echo "Test 11: real local install + verify + uninstall (isolated)"
setup_fake_home
# Install for openclaw runtime only
run_setup --mode local --runtime openclaw >/dev/null 2>&1 || true
SKILL_DIR="$FAKE_HOME/.openclaw/workspace/skills/self-learning-loop"
BIN_PATH="$FAKE_HOME/.local/bin/openclaw-learn"

# Verify skill dir exists
assert "skill dir created" test -d "$SKILL_DIR"
assert "SKILL.md copied" test -f "$SKILL_DIR/SKILL.md"
assert "bin/learn.sh created" test -f "$SKILL_DIR/bin/learn.sh"
assert "CLI wrapper created" test -f "$BIN_PATH"
assert "CLI wrapper is executable" test -x "$BIN_PATH"

# Verify data dir
DATA_DIR="$FAKE_HOME/.openclaw/workspace/learning-loop"
assert "data dir created" test -d "$DATA_DIR"

# Idempotent: run again, should not fail
run_setup --mode local --runtime openclaw >/dev/null 2>&1 || true
assert "idempotent: skill dir still exists" test -d "$SKILL_DIR"

# Uninstall
run_uninstall --force >/dev/null 2>&1 || true
assert "uninstall: skill dir removed" test ! -e "$SKILL_DIR"
assert "uninstall: CLI removed" test ! -e "$BIN_PATH"
assert "uninstall: data dir removed" test ! -e "$DATA_DIR"
cleanup_fake_home

# ─── Test 12: real global install + verify + uninstall (isolated) ──
echo "Test 12: real global install + verify + uninstall (isolated)"
setup_fake_home
run_setup --mode global --runtime openclaw >/dev/null 2>&1 || true
SHARE_LINK="$FAKE_HOME/.local/share/openclaw-learn"
assert "global: share link created" test -e "$SHARE_LINK"

# Uninstall
run_uninstall --force >/dev/null 2>&1 || true
assert "global uninstall: share link removed" test ! -e "$SHARE_LINK"
cleanup_fake_home

# ─── Test 13: uninstall --dry-run (isolated) ────────
echo "Test 13: uninstall dry-run"
setup_fake_home
uninst_dry="$(run_uninstall --dry-run --force)"
assert_output_contains "uninstall dry-run mentions DRY-RUN" "DRY-RUN" "$uninst_dry"
cleanup_fake_home

# ─── Test 14: uninstall --keep-data ──────────────────
echo "Test 14: uninstall --keep-data"
setup_fake_home
run_setup --mode local --runtime openclaw >/dev/null 2>&1 || true
run_uninstall --force --keep-data >/dev/null 2>&1 || true
SKILL_DIR="$FAKE_HOME/.openclaw/workspace/skills/self-learning-loop"
DATA_DIR="$FAKE_HOME/.openclaw/workspace/learning-loop"
assert "keep-data: skill dir removed" test ! -e "$SKILL_DIR"
assert "keep-data: data dir preserved" test -d "$DATA_DIR"
cleanup_fake_home

# ─── Summary ─────────────────────────────────────────
echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
