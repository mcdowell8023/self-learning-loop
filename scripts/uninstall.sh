#!/usr/bin/env bash
# uninstall.sh — Remove @openclaw/self-learning-loop installation
#
# By default, all data is removed. Use --keep-data to preserve.
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

Remove @openclaw/self-learning-loop installation.

By default, all data is removed. Use --keep-data to preserve
data directories (candidates, audit, SQLite).

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

remove_path() {
  local path="$1"
  if [[ -L "$path" ]]; then
    if $DRY_RUN; then
      echo -e "${YELLOW}[dry-run]${NC} rm $path (symlink)"
    else
      rm "$path"
      ok "Removed symlink: $path"
    fi
  elif [[ -d "$path" ]]; then
    if $DRY_RUN; then
      echo -e "${YELLOW}[dry-run]${NC} rm -rf $path (directory)"
    else
      rm -rf "$path"
      ok "Removed directory: $path"
    fi
  elif [[ -f "$path" ]]; then
    if $DRY_RUN; then
      echo -e "${YELLOW}[dry-run]${NC} rm $path (file)"
    else
      rm "$path"
      ok "Removed file: $path"
    fi
  fi
}

# ─── Collect all paths to remove ─────────────────────
SKILL_PATHS=(
  "$HOME_DIR/.openclaw/workspace/skills/self-learning-loop"
  "$HOME_DIR/.claude/skills/self-learning-loop"
  "$HOME_DIR/.local/share/opencode/skills/self-learning-loop"
  "${CODEX_SKILL_PATH:-$HOME_DIR/.codex/skills/self-learning-loop}"
)

BIN_PATH="$HOME_DIR/.local/bin/$BIN_NAME"
SHARE_LINK="$HOME_DIR/.local/share/openclaw-learn"

DATA_PATHS=(
  "$HOME_DIR/.openclaw/learn"
  "$HOME_DIR/.claude/learn"
  "$HOME_DIR/.local/share/opencode/learn"
  "${CODEX_DATA_PATH:-$HOME_DIR/.codex/learn}"
  "$HOME_DIR/.local/share/openclaw-learn/data"
  # Legacy paths (pre-v1.1-alpha.2): clean up if present
  "$HOME_DIR/.openclaw/workspace/learning-loop"
  "$HOME_DIR/.claude/learning-loop"
  "$HOME_DIR/.local/share/opencode/learning-loop"
  "${CODEX_DATA_PATH:-$HOME_DIR/.codex/learning-loop}"
  "$HOME_DIR/.openclaw/workspace/learn"
)

# ─── Safety check on data paths ─────────────────────
validate_data_path() {
  local path="$1"
  local resolved
  resolved="$(realpath -m "$path" 2>/dev/null || echo "$path")"
  if [[ "$resolved" == "$HOME_DIR" || "$resolved" == "/" || "$resolved" == "/home" ]]; then
    warn "REFUSING to delete $path — resolves to $resolved (safety check)"
    return 1
  fi
  return 0
}

# ─── Print "Will remove" summary ─────────────────────
print_will_remove() {
  echo ""
  info "Will remove:"
  for p in "${SKILL_PATHS[@]}"; do
    [[ -e "$p" || -L "$p" ]] && echo "  [skill]  $p"
  done
  [[ -e "$BIN_PATH" || -L "$BIN_PATH" ]] && echo "  [cli]    $BIN_PATH"
  [[ -e "$SHARE_LINK" || -L "$SHARE_LINK" ]] && echo "  [share]  $SHARE_LINK"
  if ! $KEEP_DATA; then
    for p in "${DATA_PATHS[@]}"; do
      if [[ -e "$p" || -L "$p" ]]; then
        echo "  [data]   $p"
      fi
    done
  fi
  echo ""
}

# ─── Confirmation ────────────────────────────────────
if ! $FORCE && ! $DRY_RUN; then
  echo -e "${YELLOW}This will remove self-learning-loop skill files and CLI registration.${NC}"
  if ! $KEEP_DATA; then
    echo -e "${YELLOW}All data (candidates, audit, SQLite) will also be removed.${NC}"
    echo -e "${YELLOW}Use --keep-data to preserve data directories.${NC}"
  fi
  print_will_remove
  read -rp "Continue? [y/N] " answer
  if [[ "${answer,,}" != "y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

info "=== Uninstalling @openclaw/self-learning-loop ==="
$DRY_RUN && info "*** DRY-RUN MODE ***"
print_will_remove

# ─── Remove skill directories/symlinks ───────────────
for path in "${SKILL_PATHS[@]}"; do
  remove_path "$path"
done

# Global share link
remove_path "$SHARE_LINK"

# ─── Remove CLI bin ──────────────────────────────────
if [[ -f "$BIN_PATH" || -L "$BIN_PATH" ]]; then
  remove_path "$BIN_PATH"
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
  for dir in "${DATA_PATHS[@]}"; do
    if [[ -e "$dir" || -L "$dir" ]]; then
      if validate_data_path "$dir"; then
        remove_path "$dir"
      fi
    fi
  done
else
  info "Data directories preserved (--keep-data)."
fi

echo ""
ok "=== Uninstall complete! ==="
