#!/usr/bin/env bash
# check-token-budget.sh — T-SLL-007
# Check today's token usage against daily_token_budget from config.yaml.
# Reads audit/*.jsonl, sums tokens, outputs: OK / WARN / EXCEEDED
#
# Usage: check-token-budget.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${PROJECT_DIR}/config.yaml"
DATE="$(date +%Y-%m-%d)"

# ── Read budget from config.yaml (default 50000) ─────────────────
DEFAULT_BUDGET=50000
BUDGET="$DEFAULT_BUDGET"

if [[ -f "$CONFIG_FILE" ]]; then
  # Simple grep-based YAML parse (no yq dependency)
  PARSED="$(grep -E '^\s*daily_token_budget\s*:' "$CONFIG_FILE" 2>/dev/null | head -1 | sed 's/.*:\s*//' | tr -d '[:space:]"'"'" || true)"
  if [[ -n "$PARSED" && "$PARSED" =~ ^[0-9]+$ ]]; then
    BUDGET="$PARSED"
  fi
fi

# ── Detect workspace ─────────────────────────────────────────────
if [[ -n "${LEARNING_LOOP_WORKSPACE:-}" ]]; then
  WORKSPACE="$LEARNING_LOOP_WORKSPACE"
elif [[ -d "$HOME/.openclaw/workspace" ]]; then
  WORKSPACE="$HOME/.openclaw/workspace"
else
  WORKSPACE="$PROJECT_DIR"
fi

AUDIT_DIR="${WORKSPACE}/learn/audit"

# ── Sum today's tokens from audit JSONL ───────────────────────────
TOTAL=0
if [[ -d "$AUDIT_DIR" ]]; then
  for f in "$AUDIT_DIR"/*.jsonl; do
    [[ -f "$f" ]] || continue
    # Sum tokens from lines matching today's date
    DAY_TOKENS="$(grep "\"${DATE}" "$f" 2>/dev/null | \
      grep -oP '"tokens"\s*:\s*\K[0-9]+' | \
      awk '{s+=$1} END {print s+0}' || echo 0)"
    TOTAL=$((TOTAL + DAY_TOKENS))
  done
fi

# ── Evaluate ──────────────────────────────────────────────────────
WARN_THRESHOLD=$(( BUDGET * 80 / 100 ))

if [[ "$TOTAL" -ge "$BUDGET" ]]; then
  echo "EXCEEDED (${TOTAL}/${BUDGET})"
elif [[ "$TOTAL" -ge "$WARN_THRESHOLD" ]]; then
  echo "WARN (${TOTAL}/${BUDGET})"
else
  echo "OK (${TOTAL}/${BUDGET})"
fi
