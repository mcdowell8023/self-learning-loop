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

# ── Configuration ────────────────────────────────────────────────
ALERT_THRESHOLD=${AUDIT_ALERT_THRESHOLD:-2}  # consecutive days to trigger alert

# ── Scan past 7 days ─────────────────────────────────────────────
MISSING=0
FAILED=0
DETAILS=""
CONSEC_CURRENT=0
CONSEC_MAX=0
CONSEC_START=""
CONSEC_MAX_START=""
CONSEC_MAX_END=""

# Iterate from oldest to newest for streak detection
for i in $(seq 6 -1 0); do
  DATE=$(date -d "-${i} days" +%Y-%m-%d)
  MARKER="$MARKER_DIR/$DATE.json"
  DAY_BAD=false
  if [[ ! -f "$MARKER" ]]; then
    ((MISSING++)) || true
    DETAILS="${DETAILS}\n  ${DATE}: marker 缺失"
    DAY_BAD=true
  elif ! python3 -c "import json;d=json.load(open('$MARKER'));assert d.get('messageId')" 2>/dev/null; then
    ((FAILED++)) || true
    DETAILS="${DETAILS}\n  ${DATE}: messageId 缺失/投递失败"
    DAY_BAD=true
  fi

  if $DAY_BAD; then
    ((CONSEC_CURRENT++)) || true
    [[ $CONSEC_CURRENT -eq 1 ]] && CONSEC_START="$DATE"
    if [[ $CONSEC_CURRENT -gt $CONSEC_MAX ]]; then
      CONSEC_MAX=$CONSEC_CURRENT
      CONSEC_MAX_START="$CONSEC_START"
      CONSEC_MAX_END="$DATE"
    fi
  else
    CONSEC_CURRENT=0
  fi
done

TOTAL=$((MISSING + FAILED))

# Alert if longest consecutive streak >= threshold
if [[ $CONSEC_MAX -ge $ALERT_THRESHOLD ]]; then
  MSG="⚠️ 自学习日报投递巡检告警：过去 7 天有 ${TOTAL} 天异常（${MISSING} 缺失 / ${FAILED} 失败），最长连续异常 ${CONSEC_MAX} 天（${CONSEC_MAX_START} ~ ${CONSEC_MAX_END}），已超阈值 ${ALERT_THRESHOLD} 天。${DETAILS}"
  echo "Sending audit alert to $ALERT_TARGET..."
  if [[ "${DELIVERY_DRY_RUN:-0}" == "1" || "${OPENCLAW_TEST_MODE:-0}" == "1" ]]; then
    echo "[dry-run] ${MSG}"
  elif [[ "${ALLOW_REAL_SEND:-0}" == "1" ]]; then
    openclaw message send --channel feishu --target "$ALERT_TARGET" -m "$MSG"
    echo "Audit alert sent."
  else
    echo "DRY_RUN_REQUIRED: set ALLOW_REAL_SEND=1 to send audit alert, or DELIVERY_DRY_RUN=1 for dry-run." >&2
    exit 1
  fi
else
  # Normal — stay silent (no noise)
  exit 0
fi
