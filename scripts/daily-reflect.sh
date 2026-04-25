#!/usr/bin/env bash
# daily-reflect.sh — T-SLL-007
# Run learning-loop reflect with runtime detection, token budget check,
# and off-peak enforcement. Logs JSONL to <workspace>/learning-loop/logs/.
#
# Usage: daily-reflect.sh [--dry-run]

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# ── Workspace detection ──────────────────────────────────────────
detect_workspace() {
  if [[ -n "${LEARNING_LOOP_WORKSPACE:-}" ]]; then
    echo "$LEARNING_LOOP_WORKSPACE"
  elif [[ -d "$HOME/.openclaw/workspace" ]]; then
    echo "$HOME/.openclaw/workspace"
  elif [[ -d "$HOME/.claude" ]]; then
    echo "$HOME/.claude"
  else
    return 1
  fi
}

WORKSPACE="$(detect_workspace)" || {
  echo '{"ts":"'"$(date -Iseconds)"'","level":"error","msg":"No workspace found"}' >&2
  exit 1
}

# ── Paths ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${PROJECT_DIR}/config.yaml"
DATE="$(date +%Y-%m-%d)"
LOG_DIR="${WORKSPACE}/learning-loop/logs"
LOG_FILE="${LOG_DIR}/daily-reflect-${DATE}.log"
CHECK_BUDGET="${SCRIPT_DIR}/check-token-budget.sh"

mkdir -p "$LOG_DIR"

# ── Helper: JSONL log ─────────────────────────────────────────────
jlog() {
  local level="$1" msg="$2"
  printf '{"ts":"%s","level":"%s","msg":"%s"}\n' "$(date -Iseconds)" "$level" "$msg"
}

# ── Off-peak enforcement (skip 03:00-03:59) ───────────────────────
HOUR="$(date +%H)"
if [[ "$HOUR" == "03" ]]; then
  jlog "warn" "Skipped: inside blackout window 03:00-04:00" | tee -a "$LOG_FILE"
  exit 0
fi

# ── Token budget check ────────────────────────────────────────────
if [[ -x "$CHECK_BUDGET" ]]; then
  BUDGET_STATUS="$("$CHECK_BUDGET" 2>/dev/null || echo "UNKNOWN")"
  if [[ "$BUDGET_STATUS" == *"EXCEEDED"* ]]; then
    jlog "warn" "Skipped: daily token budget exceeded" | tee -a "$LOG_FILE"
    exit 0
  fi
fi

# ── Runtime detection ─────────────────────────────────────────────
detect_runtime() {
  if command -v openclaw &>/dev/null; then
    echo "openclaw"
  elif command -v claude &>/dev/null; then
    echo "claude-code"
  elif command -v opencode &>/dev/null; then
    echo "opencode"
  elif command -v codex &>/dev/null; then
    echo "codex"
  else
    echo "unknown"
  fi
}

RUNTIME="$(detect_runtime)"

# ── Build reflect command ─────────────────────────────────────────
LEARN_BIN="${PROJECT_DIR}/dist/cli/learn.js"

build_cmd() {
  case "$RUNTIME" in
    openclaw)
      # Prefer the compiled CLI if available
      if [[ -f "$LEARN_BIN" ]]; then
        echo "node $LEARN_BIN reflect"
      else
        echo "openclaw-learn reflect"
      fi
      ;;
    *)
      if [[ -f "$LEARN_BIN" ]]; then
        echo "node $LEARN_BIN reflect"
      else
        echo "echo NO_LEARN_BINARY"
        return 1
      fi
      ;;
  esac
}

CMD="$(build_cmd)" || {
  jlog "error" "No learn binary found for runtime=$RUNTIME" | tee -a "$LOG_FILE"
  exit 1
}

# ── Execute ───────────────────────────────────────────────────────
if $DRY_RUN; then
  jlog "info" "dry-run: would execute: $CMD"
  jlog "info" "dry-run: runtime=$RUNTIME workspace=$WORKSPACE log=$LOG_FILE"
  exit 0
fi

jlog "info" "Starting daily reflect (runtime=$RUNTIME)" >> "$LOG_FILE"

if eval "$CMD" >> "$LOG_FILE" 2>&1; then
  jlog "info" "Daily reflect completed successfully" >> "$LOG_FILE"
else
  EXIT_CODE=$?
  jlog "error" "Daily reflect FAILED (exit $EXIT_CODE)" >> "$LOG_FILE"
  exit $EXIT_CODE
fi
