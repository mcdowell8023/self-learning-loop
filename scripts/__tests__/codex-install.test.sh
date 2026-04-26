#!/bin/bash
# Integration test: codex adapter loads from a non-source-repo install path
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo "=== Test: codex adapter discovery from installed location ==="

# Simulate a local install: copy dist/ + configs/adapters/ to tmp
INSTALL_DIR="$TMPDIR_BASE/fake-install"
mkdir -p "$INSTALL_DIR/dist" "$INSTALL_DIR/configs/adapters"
cp -r "$REPO_DIR/dist/"* "$INSTALL_DIR/dist/"
cp "$REPO_DIR/configs/adapters/codex.yaml" "$INSTALL_DIR/configs/adapters/"
# Symlink node_modules so dependencies resolve (simulates npm install)
ln -s "$REPO_DIR/node_modules" "$INSTALL_DIR/node_modules"
# Copy package.json for module resolution
cp "$REPO_DIR/package.json" "$INSTALL_DIR/package.json"

# Run a small Node script that imports registry from the installed location
# and verifies codex adapter can be created
node --input-type=module << NODESCRIPT
import { join } from 'node:path';
const installDir = '${INSTALL_DIR}';
// Import getAdapter from installed dist
const { getAdapter } = await import(join(installDir, 'dist/adapters/registry.js'));
try {
  const adapter = await getAdapter('codex');
  console.log('✅ PASS: codex adapter loaded from installed path');
  console.log('   Adapter type:', adapter.constructor.name);
} catch (e) {
  console.error('❌ FAIL: codex adapter failed to load:', e.message);
  process.exit(1);
}
NODESCRIPT

echo "=== codex install test passed ==="
