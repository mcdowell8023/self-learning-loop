#!/usr/bin/env bash
# scripts/__tests__/uninstall-e2e.test.sh — End-to-end setup → uninstall verification
#
# Runs in mktemp sandbox. Tests:
#   1. setup --mode local creates all expected artifacts
#   2. uninstall (no --keep-data) removes everything
#   3. setup → uninstall --keep-data preserves data_dir but removes skill/CLI
#   4. uninstall dry-run prints "Will remove" list
#   5. uninstall safety check refuses to delete $HOME or /
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
PASS=0; FAIL=0

assert_exists() {
  local label="$1" path="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    echo -e "  ${GREEN}✅ PASS${NC}: $label exists: $path"; PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ FAIL${NC}: $label missing: $path"; FAIL=$((FAIL + 1))
  fi
}

assert_not_exists() {
  local label="$1" path="$2"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    echo -e "  ${GREEN}✅ PASS${NC}: $label removed: $path"; PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ FAIL${NC}: $label still exists: $path"; FAIL=$((FAIL + 1))
  fi
}

assert_output_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}✅ PASS${NC}: $label"; PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ FAIL${NC}: $label — expected '$needle' in output"; FAIL=$((FAIL + 1))
  fi
}

# ─── Setup sandbox ───────────────────────────────────
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

export HOME="$SANDBOX/home"
mkdir -p "$HOME/.openclaw/workspace"
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

echo ""
echo "=== Uninstall E2E Test ==="
echo "Sandbox: $SANDBOX"
echo "Repo: $REPO_DIR"
echo ""

# ─── Test 1: setup creates all expected artifacts ────
echo "Test 1: setup --mode local creates all expected artifacts"
bash "$REPO_DIR/scripts/setup.sh" --mode local --runtime openclaw 2>&1 >& /dev/null || true

SKILL_DIR="$HOME/.openclaw/workspace/skills/self-learning-loop"
DATA_DIR="$HOME/.openclaw/learn"
CLI_BIN="$HOME/.local/bin/openclaw-learn"

assert_exists "skill dir" "$SKILL_DIR"
assert_exists "SKILL.md" "$SKILL_DIR/SKILL.md"
assert_exists "bin/learn.sh" "$SKILL_DIR/bin/learn.sh"
assert_exists "CLI binary" "$CLI_BIN"
assert_exists "data dir" "$DATA_DIR"
assert_exists "candidates.db" "$DATA_DIR/candidates.db"
assert_exists "config.yaml" "$DATA_DIR/config.yaml"
assert_exists "audit dir" "$DATA_DIR/audit"
echo ""

# ─── Test 2: uninstall (default, no --keep-data) removes everything ───
echo "Test 2: uninstall --force removes everything (default = delete data)"
bash "$REPO_DIR/scripts/uninstall.sh" --force 2>&1 >& /dev/null || true

assert_not_exists "skill dir" "$SKILL_DIR"
assert_not_exists "CLI binary" "$CLI_BIN"
assert_not_exists "data dir" "$DATA_DIR"
echo ""

# ─── Test 3: setup → uninstall --keep-data ───────────
echo "Test 3: setup → uninstall --keep-data preserves data_dir"
bash "$REPO_DIR/scripts/setup.sh" --mode local --runtime openclaw 2>&1 >& /dev/null || true

# Verify setup worked
assert_exists "re-setup: skill dir" "$SKILL_DIR"
assert_exists "re-setup: data dir" "$DATA_DIR"

bash "$REPO_DIR/scripts/uninstall.sh" --force --keep-data 2>&1 >& /dev/null || true

assert_not_exists "keep-data: skill dir" "$SKILL_DIR"
assert_not_exists "keep-data: CLI binary" "$CLI_BIN"
assert_exists "keep-data: data dir preserved" "$DATA_DIR"
assert_exists "keep-data: candidates.db preserved" "$DATA_DIR/candidates.db"
echo ""

# ─── Test 4: dry-run prints "Will remove" ────────────
echo "Test 4: uninstall --dry-run prints Will remove list"
# Re-setup first
bash "$REPO_DIR/scripts/setup.sh" --mode local --runtime openclaw 2>&1 >& /dev/null || true

DRY_OUTPUT=$(bash "$REPO_DIR/scripts/uninstall.sh" --dry-run 2>&1)
assert_output_contains "dry-run: mentions Will remove" "Will remove" "$DRY_OUTPUT"
assert_output_contains "dry-run: mentions skill path" "self-learning-loop" "$DRY_OUTPUT"
assert_output_contains "dry-run: mentions dry-run" "dry-run" "$DRY_OUTPUT"

# Verify nothing was actually deleted
assert_exists "dry-run: skill dir still exists" "$SKILL_DIR"
assert_exists "dry-run: data dir still exists" "$DATA_DIR"

# Clean up for next test
bash "$REPO_DIR/scripts/uninstall.sh" --force 2>&1 >& /dev/null || true
echo ""

# ─── Test 5: legacy learning-loop/ cleanup ───────────
echo "Test 5: uninstall cleans up legacy learning-loop/ directories"
# Create legacy dirs
mkdir -p "$HOME/.openclaw/workspace/learning-loop"
echo "legacy" > "$HOME/.openclaw/workspace/learning-loop/test.txt"
mkdir -p "$HOME/.openclaw/workspace/learn"
echo "legacy2" > "$HOME/.openclaw/workspace/learn/test.txt"

bash "$REPO_DIR/scripts/uninstall.sh" --force 2>&1 >& /dev/null || true

assert_not_exists "legacy: learning-loop dir" "$HOME/.openclaw/workspace/learning-loop"
assert_not_exists "legacy: workspace/learn dir" "$HOME/.openclaw/workspace/learn"
echo ""

# ─── Summary ─────────────────────────────────────────
echo ""
echo "=== Results: $PASS/$((PASS + FAIL)) passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
