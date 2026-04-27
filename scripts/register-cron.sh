#!/usr/bin/env bash
# register-cron.sh — T-SLL-007
# Register/unregister daily-reflect cron job.
#
# Usage:
#   register-cron.sh [--dry-run] [--unregister] [--schedule "30 4 * * *"]

set -euo pipefail

DRY_RUN=false
UNREGISTER=false
SCHEDULE="0 7 * * *"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)     DRY_RUN=true; shift ;;
    --unregister)  UNREGISTER=true; shift ;;
    --schedule)    SCHEDULE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFLECT_SCRIPT="${SCRIPT_DIR}/daily-reflect.sh"
CRON_TAG="# learning-loop-daily-reflect"

if [[ ! -f "$REFLECT_SCRIPT" ]]; then
  echo "ERROR: daily-reflect.sh not found at $REFLECT_SCRIPT" >&2
  exit 1
fi

# ── Detect runtime ────────────────────────────────────────────────
detect_runtime() {
  if command -v openclaw &>/dev/null; then echo "openclaw"
  elif command -v claude &>/dev/null; then echo "claude-code"
  elif command -v opencode &>/dev/null; then echo "opencode"
  elif command -v codex &>/dev/null; then echo "codex"
  else echo "system"
  fi
}

RUNTIME="$(detect_runtime)"
CRON_LINE="${SCHEDULE} bash ${REFLECT_SCRIPT} ${CRON_TAG}"

# ── OpenClaw path ─────────────────────────────────────────────────
if [[ "$RUNTIME" == "openclaw" ]]; then
  if $UNREGISTER; then
    if $DRY_RUN; then
      echo "[dry-run] Would run: openclaw cron remove (learning-loop-daily-reflect)"
    else
      # List and find matching cron, then remove
      CRON_ID="$(openclaw cron list 2>/dev/null | grep -i "daily-reflect" | head -1 | awk '{print $1}' || true)"
      if [[ -n "$CRON_ID" ]]; then
        openclaw cron remove "$CRON_ID"
        echo "Removed openclaw cron: $CRON_ID"
      else
        echo "No matching openclaw cron found."
      fi
    fi
  else
    CRON_MSG="exec: bash ${REFLECT_SCRIPT}"
    if $DRY_RUN; then
      echo "[dry-run] Would run: openclaw cron add --name self-learning-loop-daily-reflect --cron '${SCHEDULE}' --tz Asia/Shanghai --session isolated --tools exec,read --model github-copilot/claude-haiku-4.5 --message '${CRON_MSG}'"
    else
      openclaw cron add \
        --name "self-learning-loop-daily-reflect" \
        --cron "${SCHEDULE}" \
        --tz "Asia/Shanghai" \
        --session isolated \
        --tools "exec,read" \
        --model "github-copilot/claude-haiku-4.5" \
        --message "${CRON_MSG}"
      echo "Registered openclaw cron for daily-reflect (${SCHEDULE})."
    fi
  fi
  exit 0
fi

# ── System crontab path ──────────────────────────────────────────
if $UNREGISTER; then
  if $DRY_RUN; then
    echo "[dry-run] Would remove crontab line matching: ${CRON_TAG}"
    crontab -l 2>/dev/null | grep "${CRON_TAG}" || echo "(no matching line found)"
  else
    EXISTING="$(crontab -l 2>/dev/null || true)"
    echo "$EXISTING" | grep -v "${CRON_TAG}" | crontab -
    echo "Removed crontab entry for learning-loop-daily-reflect."
  fi
else
  if $DRY_RUN; then
    echo "[dry-run] Would add crontab line:"
    echo "  ${CRON_LINE}"
  else
    EXISTING="$(crontab -l 2>/dev/null || true)"
    if echo "$EXISTING" | grep -q "${CRON_TAG}"; then
      echo "Cron already registered. Use --unregister first to replace."
      exit 0
    fi
    (echo "$EXISTING"; echo "$CRON_LINE") | crontab -
    echo "Registered crontab: ${CRON_LINE}"
  fi
fi
