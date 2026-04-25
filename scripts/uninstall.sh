#!/usr/bin/env bash
# uninstall.sh — Remove @openclaw/self-learning-loop installation
set -euo pipefail

HOME_DIR="${HOME:-$(eval echo ~)}"
BIN_NAME="openclaw-learn"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }

DRY_RUN=false
KEEP_DATA=false
FORCE=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --dry-run       Print actions without executing
  --keep-data     Preserve data directories (candidates, audit, SQLite)
  --force         Skip confirmation prompts
  -h, --help      Show this help
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=true; shift ;;
    --keep-data) KEEP_DATA=true; shift ;;
    --force)     FORCE=true; shift ;;
    -h|--help)   usage ;;
    *) shift ;;
  esac
done

remove_link() {
  local path="$1"
  if [[ -L "$path" ]]; then
    if $DRY_RUN; then
      echo -e "${YELLOW}[dry-run]${NC} rm $path"
    else
      rm "$path"
      ok "Removed symlink: $path"
    fi
  elif [[ -e "$path" ]]; then
    warn "$path exists but is not a symlink — skipping"
  fi
}

remove_dir() {
  local path="$1"
  if [[ -d "$path" ]]; then
    if $DRY_RUN; then
      echo -e "${YELLOW}[dry-run]${NC} rm -rf $path"
    else
      rm -rf "$path"
      ok "Removed directory: $path"
    fi
  fi
}

# ─── Confirmation ────────────────────────────────────
if ! $FORCE && ! $DRY_RUN; then
  echo -e "${YELLOW}This will remove self-learning-loop symlinks and CLI registration.${NC}"
  read -rp "Continue? [y/N] " answer
  if [[ "${answer,,}" != "y" ]]; then
    echo "Aborted."
    exit 0
  fi
  if ! $KEEP_DATA; then
    echo ""
    read -rp "Also remove data directories (candidates, audit, SQLite)? [y/N] " data_answer
    if [[ "${data_answer,,}" != "y" ]]; then
      KEEP_DATA=true
      info "Data directories will be preserved."
    fi
  fi
fi

info "=== Uninstalling @openclaw/self-learning-loop ==="
$DRY_RUN && info "*** DRY-RUN MODE ***"
echo ""

# ─── Remove skill symlinks ──────────────────────────
SKILL_LINKS=(
  "$HOME_DIR/.openclaw/workspace/skills/self-learning-loop"
  "$HOME_DIR/.claude/skills/self-learning-loop"
  "$HOME_DIR/.local/share/opencode/skills/self-learning-loop"
)

for link in "${SKILL_LINKS[@]}"; do
  remove_link "$link"
done

# Global share link
remove_link "$HOME_DIR/.local/share/openclaw-learn"

# ─── Remove CLI bin ──────────────────────────────────
BIN_PATH="$HOME_DIR/.local/bin/$BIN_NAME"
if [[ -f "$BIN_PATH" || -L "$BIN_PATH" ]]; then
  if $DRY_RUN; then
    echo -e "${YELLOW}[dry-run]${NC} rm $BIN_PATH"
  else
    rm "$BIN_PATH"
    ok "Removed CLI: $BIN_PATH"
  fi
fi

# Try npm unlink too
if command -v npm &>/dev/null; then
  if npm ls -g "$BIN_NAME" &>/dev/null 2>&1; then
    if $DRY_RUN; then
      echo -e "${YELLOW}[dry-run]${NC} npm unlink $BIN_NAME"
    else
      npm unlink "$BIN_NAME" 2>/dev/null || true
      ok "npm unlink done"
    fi
  fi
fi

# ─── Remove data directories ────────────────────────
if ! $KEEP_DATA; then
  DATA_DIRS=(
    "$HOME_DIR/.openclaw/workspace/learning-loop"
    "$HOME_DIR/.claude/learning-loop"
    "$HOME_DIR/.local/share/opencode/learning-loop"
    "$HOME_DIR/.local/share/openclaw-learn/data"
  )
  for dir in "${DATA_DIRS[@]}"; do
    remove_dir "$dir"
  done
else
  info "Data directories preserved."
fi

echo ""
ok "=== Uninstall complete! ==="
