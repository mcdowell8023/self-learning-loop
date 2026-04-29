#!/usr/bin/env bash
# weekly-delivery-audit.sh — T-046 M4
# 7-day delivery marker audit. Run weekly (Monday 09:00 UTC+8).
# ≥2 days missing/failed → alert via feishu.
set -euo pipefail

WORKSPACE="${LEARNING_LOOP_WORKSPACE:-$HOME/.openclaw/workspace}"
MARKER_DIR="$WORKSPACE/learn/reports/.delivered"
CONFIG_FILE="$WORKSPACE/learn/reporter-config.json"

# ── Read alert target from reporter-config.json (mandatory) ──────
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: reporter-config.json 缺失，无法发送 audit 告警" >&2
  exit 1
fi

ALERT_TARGET=$(python3 -c "import json;print(json.load(open('$CONFIG_FILE'))['channels'][0]['target'])" 2>/dev/null)
if [[ -z "$ALERT_TARGET" ]]; then
  echo "ERROR: reporter-config.json channels[0].target 为空" >&2
  exit 1
fi

# ── Scan past 7 days ─────────────────────────────────────────────
MISSING=0
FAILED=0
DETAILS=""

for i in $(seq 0 6); do
  DATE=$(date -d "-${i} days" +%Y-%m-%d)
  MARKER="$MARKER_DIR/$DATE.json"
  if [[ ! -f "$MARKER" ]]; then
    ((MISSING++)) || true
    DETAILS="${DETAILS}\n  ${DATE}: marker 缺失"
  elif ! python3 -c "import json;d=json.load(open('$MARKER'));assert d.get('messageId')" 2>/dev/null; then
    ((FAILED++)) || true
    DETAILS="${DETAILS}\n  ${DATE}: messageId 缺失/投递失败"
  fi
done

TOTAL=$((MISSING + FAILED))

if [[ $TOTAL -ge 2 ]]; then
  MSG="⚠️ 自学习日报投递巡检：过去 7 天有 ${MISSING} 天缺失 marker、${FAILED} 天投递失败（共 ${TOTAL} 天异常），请检查。${DETAILS}"
  echo "Sending audit alert to $ALERT_TARGET..."
  openclaw message send --channel feishu --target "$ALERT_TARGET" -m "$MSG"
  echo "Audit alert sent."
else
  # Normal — stay silent (no noise)
  exit 0
fi
