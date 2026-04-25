#!/usr/bin/env bash
# daily-reflect.sh — Run learning-loop reflect for yesterday's diary.
# Intended for cron/openclaw cron. Logs to ~/open-claw-output/logs/.

set -euo pipefail

DATE=$(date +%Y-%m-%d)
LOG_DIR="$HOME/open-claw-output/logs"
LOG_FILE="$LOG_DIR/learning-loop-reflect-${DATE}.log"
LEARN_BIN="$HOME/open-claw-output/code/learning-loop/dist/cli/learn.js"

mkdir -p "$LOG_DIR"

echo "[$(date -Iseconds)] Starting daily reflect..." >> "$LOG_FILE"

if node "$LEARN_BIN" reflect >> "$LOG_FILE" 2>&1; then
  echo "[$(date -Iseconds)] Daily reflect completed successfully." >> "$LOG_FILE"
else
  EXIT_CODE=$?
  echo "[$(date -Iseconds)] Daily reflect FAILED (exit $EXIT_CODE)." >> "$LOG_FILE"
  exit $EXIT_CODE
fi
