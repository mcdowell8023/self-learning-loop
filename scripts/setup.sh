#!/usr/bin/env bash
# setup.sh — One-click installer for @openclaw/self-learning-loop
# Supports: --mode local|global|npm  --dry-run  --runtime <name>  --help
set -euo pipefail

# ─── Defaults ────────────────────────────────────────
MODE="local"
DRY_RUN=false
RUNTIME=""
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME:-$(eval echo ~)}"
BIN_NAME="openclaw-learn"

# ─── Colors ──────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()   { echo -e "${RED}[error]${NC} $*" >&2; }
dry()   { echo -e "${YELLOW}[dry-run]${NC} $*"; }

# ─── Usage ───────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --mode local|global|npm   Install mode (default: local)
                            local  — symlink to ~/.openclaw/workspace/skills/
                            global — symlink to ~/.local/share/openclaw-learn/ (multi-runtime)
                            npm    — npm link (developer mode)
  --runtime NAME            Target runtime: openclaw|claude-code|opencode|codex|auto (default: auto-detect)
  --dry-run                 Print actions without executing
  -h, --help                Show this help

Examples:
  bash scripts/setup.sh                         # auto-detect, local mode
  bash scripts/setup.sh --mode global           # global install
  bash scripts/setup.sh --dry-run --mode local  # preview actions
EOF
  exit 0
}

# ─── Parse args ──────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)    MODE="$2"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage ;;
    *) err "Unknown option: $1"; usage ;;
  esac
done

# Validate mode
case "$MODE" in
  local|global|npm) ;;
  *) err "Invalid mode: $MODE (must be local|global|npm)"; exit 1 ;;
esac

# ─── Runtime detection ───────────────────────────────
RUNTIME_PATHS=()

detect_runtimes() {
  local found=()
  if [[ -d "$HOME_DIR/.openclaw/workspace" ]]; then
    found+=("openclaw")
  fi
  if [[ -d "$HOME_DIR/.claude" ]]; then
    found+=("claude-code")
  fi
  if [[ -d "$HOME_DIR/.local/share/opencode" ]]; then
    found+=("opencode")
  fi
  # codex requires user-specified path, skip auto-detect
  RUNTIME_PATHS=("${found[@]}")
}

get_skill_link_target() {
  local rt="$1"
  case "$rt" in
    openclaw)    echo "$HOME_DIR/.openclaw/workspace/skills/self-learning-loop" ;;
    claude-code) echo "$HOME_DIR/.claude/skills/self-learning-loop" ;;
    opencode)    echo "$HOME_DIR/.local/share/opencode/skills/self-learning-loop" ;;
    codex)       echo "${CODEX_SKILL_PATH:-$HOME_DIR/.codex/skills/self-learning-loop}" ;;
    *) err "Unknown runtime: $rt"; return 1 ;;
  esac
}

get_data_dir() {
  local rt="$1"
  case "$rt" in
    openclaw)    echo "$HOME_DIR/.openclaw/workspace/learning-loop" ;;
    claude-code) echo "$HOME_DIR/.claude/learning-loop" ;;
    opencode)    echo "$HOME_DIR/.local/share/opencode/learning-loop" ;;
    codex)       echo "${CODEX_DATA_PATH:-$HOME_DIR/.codex/learning-loop}" ;;
    *) echo "$HOME_DIR/.local/share/openclaw-learn/data"; return 0 ;;
  esac
}

# ─── Resolve target runtime(s) ──────────────────────
resolve_runtime() {
  if [[ -n "$RUNTIME" && "$RUNTIME" != "auto" ]]; then
    RUNTIME_PATHS=("$RUNTIME")
    return
  fi
  detect_runtimes
  if [[ ${#RUNTIME_PATHS[@]} -eq 0 ]]; then
    err "No supported AI coding runtime detected."
    err "Checked: ~/.openclaw/workspace, ~/.claude, ~/.local/share/opencode"
    err "Use --runtime <name> to specify manually."
    exit 1
  fi
  info "Detected runtimes: ${RUNTIME_PATHS[*]}"
}

# ─── Execute or dry-run ─────────────────────────────
run_cmd() {
  if $DRY_RUN; then
    dry "would run: $*"
  else
    "$@"
  fi
}

make_dir() {
  if $DRY_RUN; then
    dry "mkdir -p $1"
  else
    mkdir -p "$1"
  fi
}

make_link() {
  local target="$1" link_name="$2"
  if [[ -L "$link_name" ]]; then
    local existing
    existing="$(readlink -f "$link_name" 2>/dev/null || true)"
    if [[ "$existing" == "$(readlink -f "$target" 2>/dev/null || echo "$target")" ]]; then
      ok "Symlink already correct: $link_name → $target"
      return 0
    fi
    warn "Symlink exists but points elsewhere, updating: $link_name"
    if $DRY_RUN; then
      dry "rm $link_name && ln -s $target $link_name"
    else
      rm "$link_name"
      ln -s "$target" "$link_name"
    fi
  elif [[ -e "$link_name" ]]; then
    err "$link_name exists and is not a symlink. Remove it manually first."
    return 1
  else
    if $DRY_RUN; then
      dry "ln -s $target $link_name"
    else
      make_dir "$(dirname "$link_name")"
      ln -s "$target" "$link_name"
    fi
  fi
}

# ─── Install: mode local ────────────────────────────
install_local() {
  local rt="$1"
  info "Installing (local) for runtime: $rt"
  local skill_link
  skill_link="$(get_skill_link_target "$rt")"
  make_dir "$(dirname "$skill_link")"
  make_link "$REPO_DIR" "$skill_link"

  local data_dir
  data_dir="$(get_data_dir "$rt")"
  make_dir "$data_dir"
  make_dir "$data_dir/audit"
  make_dir "$data_dir/candidates"
  ok "Data directory: $data_dir"
}

# ─── Install: mode global ───────────────────────────
install_global() {
  info "Installing (global) — shared location"
  local share_dir="$HOME_DIR/.local/share/openclaw-learn"
  make_link "$REPO_DIR" "$share_dir"

  # Also link into each detected runtime for discoverability
  for rt in "${RUNTIME_PATHS[@]}"; do
    local skill_link
    skill_link="$(get_skill_link_target "$rt")"
    make_dir "$(dirname "$skill_link")"
    make_link "$share_dir" "$skill_link"
  done

  local data_dir="$HOME_DIR/.local/share/openclaw-learn/data"
  make_dir "$data_dir"
  make_dir "$data_dir/audit"
  make_dir "$data_dir/candidates"
  ok "Shared data directory: $data_dir"
}

# ─── Install: mode npm ──────────────────────────────
install_npm() {
  info "Installing (npm link) — developer mode"
  if $DRY_RUN; then
    dry "cd $REPO_DIR && npm link"
  else
    (cd "$REPO_DIR" && npm link)
  fi
  ok "npm link complete — $BIN_NAME should be in PATH"
}

# ─── Register CLI to PATH ───────────────────────────
register_bin() {
  if [[ "$MODE" == "npm" ]]; then
    return 0  # npm link handles this
  fi
  local bin_dir="$HOME_DIR/.local/bin"
  local cli_entry="$REPO_DIR/dist/cli/learn.js"
  local bin_link="$bin_dir/$BIN_NAME"

  make_dir "$bin_dir"

  if $DRY_RUN; then
    dry "Create wrapper: $bin_link → node $cli_entry"
  else
    cat > "$bin_link" <<WRAPPER
#!/usr/bin/env bash
exec node "$cli_entry" "\$@"
WRAPPER
    chmod +x "$bin_link"
  fi

  # Check if ~/.local/bin is in PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$bin_dir"; then
    warn "$bin_dir is not in PATH. Add to your shell profile:"
    warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
  ok "CLI registered: $bin_link"
}

# ─── Init & health check ────────────────────────────
run_init() {
  local data_dir="$1"
  local cli="$REPO_DIR/dist/cli/learn.js"
  if [[ ! -f "$cli" ]]; then
    warn "dist/cli/learn.js not found — run 'npm run build' first"
    return 0
  fi
  if $DRY_RUN; then
    dry "node $cli init --workspace $(dirname "$data_dir")"
    dry "node $cli status"
  else
    info "Running init..."
    node "$cli" init --workspace "$(dirname "$data_dir")" || warn "init returned non-zero (may already be initialized)"
    info "Running health check..."
    node "$cli" status || warn "status check returned non-zero"
  fi
}

# ─── Main ────────────────────────────────────────────
main() {
  echo ""
  info "=== @openclaw/self-learning-loop setup ==="
  info "Repo:  $REPO_DIR"
  info "Mode:  $MODE"
  $DRY_RUN && info "*** DRY-RUN MODE — no changes will be made ***"
  echo ""

  resolve_runtime
  info "Target runtime(s): ${RUNTIME_PATHS[*]}"
  echo ""

  case "$MODE" in
    local)
      for rt in "${RUNTIME_PATHS[@]}"; do
        install_local "$rt"
      done
      ;;
    global)
      install_global
      ;;
    npm)
      install_npm
      ;;
  esac

  echo ""
  register_bin

  echo ""
  if [[ "$MODE" != "npm" ]]; then
    local primary_rt="${RUNTIME_PATHS[0]}"
    local data_dir
    if [[ "$MODE" == "global" ]]; then
      data_dir="$HOME_DIR/.local/share/openclaw-learn/data"
    else
      data_dir="$(get_data_dir "$primary_rt")"
    fi
    run_init "$data_dir"
  fi

  echo ""
  ok "=== Setup complete! ==="
  echo ""
  info "Next steps:"
  info "  1. Ensure ~/.local/bin is in your PATH"
  info "  2. Run: $BIN_NAME status"
  info "  3. Run: $BIN_NAME reflect --today"
}

main
