#!/usr/bin/env bash
# daily-reflect.sh — T-SLL-007
# Run learning-loop reflect with runtime detection, token budget check,
# and off-peak enforcement. Logs JSONL to <workspace>/learn/logs/.
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
  echo "❌ daily-reflect.sh FAILED"
  echo "Stage: workspace_detect"
  echo "Error: No workspace found"
  exit 1
}

# ── Paths ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${PROJECT_DIR}/config.yaml"
DATE="$(date +%Y-%m-%d)"
LOG_DIR="${WORKSPACE}/learn/logs"
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

# ── Helper: surface failure to stdout (for cron agent capture) ────
fail_stdout() {
  local stage="$1" error="$2"
  # Print structured summary so cron agents see it on stdout
  echo "❌ daily-reflect.sh FAILED"
  echo "Stage: ${stage}"
  echo "Error: ${error}"
  echo "Log: ${LOG_FILE}"
}

# ── Execute ───────────────────────────────────────────────────────
if $DRY_RUN || [[ "${DELIVERY_DRY_RUN:-0}" == "1" ]] || [[ "${OPENCLAW_TEST_MODE:-0}" == "1" ]]; then
  jlog "info" "dry-run: would execute: $CMD"
  jlog "info" "dry-run: runtime=$RUNTIME workspace=$WORKSPACE log=$LOG_FILE"
  if [[ "${DELIVERY_DRY_RUN:-0}" == "1" || "${OPENCLAW_TEST_MODE:-0}" == "1" ]]; then
    jlog "info" "dry-run: delivery target isolation active (no real send)"
  fi
  exit 0
fi

jlog "info" "Starting daily reflect (runtime=$RUNTIME)" >> "$LOG_FILE"

if eval "$CMD" >> "$LOG_FILE" 2>&1; then
  jlog "info" "Daily reflect completed successfully" >> "$LOG_FILE"

  # ── Post-reflect: optional evaluate-all ────────────────────────
  if [[ "${EVALUATE_AFTER_REFLECT:-0}" == "1" ]]; then
    jlog "info" "Running evaluate-all (post-reflect)" >> "$LOG_FILE"
    CMD_EVALUATE="node ${LEARN_BIN} evaluate-all ${EVALUATE_FLAGS:-}"
    if eval "$CMD_EVALUATE" >> "$LOG_FILE" 2>&1; then
      jlog "info" "evaluate-all completed" >> "$LOG_FILE"
    else
      jlog "warn" "evaluate-all failed (non-fatal)" >> "$LOG_FILE"
    fi
  fi
else
  EXIT_CODE=$?
  jlog "error" "Daily reflect FAILED (exit $EXIT_CODE)" >> "$LOG_FILE"
  fail_stdout "reflect" "reflect command exited with code $EXIT_CODE"
  exit $EXIT_CODE
fi

# ── Post-run: invoke reporter + verify delivery marker (T-046) ──
REPORTER_CMD=(learning-loop-reporter notify --date "$DATE")
if [[ "${ALLOW_REAL_SEND:-0}" == "1" ]]; then
  REPORTER_CMD+=(--allow-real-send)
fi

if command -v learning-loop-reporter &>/dev/null; then
  jlog "info" "Invoking reporter notify --date $DATE" >> "$LOG_FILE"
  if ! "${REPORTER_CMD[@]}" >> "$LOG_FILE" 2>&1; then
    jlog "error" "Reporter notify exited non-zero" >> "$LOG_FILE"
    fail_stdout "reporter_notify" "learning-loop-reporter notify failed"
    exit 1
  fi

  # Read delivery marker written by reporter
  MARKER_FILE="${WORKSPACE}/learn/reports/.delivered/${DATE}.json"
  if [[ ! -f "$MARKER_FILE" ]]; then
    jlog "error" "Delivery marker missing after reporter notify" >> "$LOG_FILE"
    fail_stdout "delivery_verify" "No marker at $MARKER_FILE"
    exit 1
  fi

  MSG_ID=$(python3 -c "import json,sys;d=json.load(open('$MARKER_FILE'));print(d.get('messageId',''))" 2>/dev/null || echo "")
  if [[ -z "$MSG_ID" ]]; then
    jlog "error" "Delivery marker has no messageId" >> "$LOG_FILE"
    fail_stdout "delivery_verify" "Marker exists but messageId empty"
    exit 1
  fi

  echo "投递验证通过 messageId=${MSG_ID}"
  jlog "info" "Delivery verified messageId=${MSG_ID}" >> "$LOG_FILE"
else
  jlog "error" "learning-loop-reporter not found in PATH" >> "$LOG_FILE"
  fail_stdout "reporter_missing" "learning-loop-reporter command not found"
  exit 1
fi
