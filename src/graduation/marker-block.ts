// src/graduation/marker-block.ts
//
// T-P1a-008 · Marker block injection / rollback for graduated artifacts.
//
// Format (design §9.2.2):
//   <!-- graduated:sha256:<hash> start -->
//   <body>
//   <!-- graduated:sha256:<hash> end -->
//
// Atomic write strategy (§9.2.2 v5.0.1):
//   1. Compose full new content in memory.
//   2. Write to "<target>.tmp.<pid>.<rand>"
//   3. fsync()
//   4. rename() → atomic replace on POSIX.
//
// Parser is regex-based and tolerates users editing AGENTS.md manually around
// existing marker blocks (we locate by marker, not by line number).

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  existsSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Strict SHA-256 check — 64 lowercase hex chars. */
const SHA256_RE = /^[a-f0-9]{64}$/;

export function assertSha256(hash: string): void {
  if (!SHA256_RE.test(hash)) {
    throw new Error(
      `Invalid SHA-256 marker hash: expected 64 lowercase hex chars, got "${hash}"`,
    );
  }
}

/** Build start / end marker lines for a given sha256 hash. */
export function markerLines(hash: string): { start: string; end: string } {
  assertSha256(hash);
  return {
    start: `<!-- graduated:sha256:${hash} start -->`,
    end: `<!-- graduated:sha256:${hash} end -->`,
  };
}

/**
 * Regex for locating an existing marker block by hash. Captures the inner body.
 * Uses [\s\S]*? so we tolerate any content and cross-line bodies.
 */
function blockRegex(hash: string): RegExp {
  assertSha256(hash);
  return new RegExp(
    `<!--\\s*graduated:sha256:${hash}\\s+start\\s*-->[\\s\\S]*?<!--\\s*graduated:sha256:${hash}\\s+end\\s*-->`,
    'g',
  );
}

/** True iff the given file already contains a block for this hash. */
export function hasMarkerBlock(filePath: string, hash: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  return blockRegex(hash).test(content);
}

/** Extract the body (text between start+end markers, trimmed of surrounding blank lines) for a hash, or null. */
export function readMarkerBlock(filePath: string, hash: string): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const m = blockRegex(hash).exec(content);
  if (!m) return null;
  const { start, end } = markerLines(hash);
  const full = m[0];
  return full.slice(start.length, full.length - end.length).replace(/^\n+|\n+$/g, '');
}

// ---------------------------------------------------------------------------
// Atomic file replace
// ---------------------------------------------------------------------------

/**
 * Atomically replace `target` with `newContent`.
 * Writes <target>.tmp.<pid>.<rand>, fsyncs, then rename()s.
 *
 * If the write or rename fails, the tmp file is cleaned up and the target file
 * remains untouched. Caller can catch and react.
 */
export function atomicWrite(target: string, newContent: string): void {
  const suffix = `${process.pid}.${randomBytes(4).toString('hex')}`;
  const tmp = `${target}.tmp.${suffix}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w', 0o644);
    writeSync(fd, newContent);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Inject / rollback
// ---------------------------------------------------------------------------

export interface InjectOptions {
  /** Trailing newline separator inserted before the block if file non-empty and doesn't already end with one. */
  ensureTrailingNewline?: boolean;
}

/**
 * Inject a marker block into `target`. Creates the file if missing.
 * Idempotent: if a block with the same hash already exists, this is a no-op and
 * returns `{ injected: false, reason: 'already_present' }`.
 */
export function injectMarkerBlock(
  target: string,
  hash: string,
  body: string,
  opts: InjectOptions = {},
): { injected: boolean; reason?: string } {
  assertSha256(hash);
  const ensureNl = opts.ensureTrailingNewline !== false;

  const prior = existsSync(target) ? readFileSync(target, 'utf-8') : '';
  if (blockRegex(hash).test(prior)) {
    return { injected: false, reason: 'already_present' };
  }

  const { start, end } = markerLines(hash);
  const block = `${start}\n${body.replace(/\s+$/, '')}\n${end}\n`;

  let next: string;
  if (prior.length === 0) {
    next = block;
  } else if (prior.endsWith('\n')) {
    next = `${prior}${ensureNl ? '\n' : ''}${block}`;
  } else {
    next = `${prior}\n${ensureNl ? '\n' : ''}${block}`;
  }

  atomicWrite(target, next);
  return { injected: true };
}

/**
 * Remove a marker block (and one adjacent blank separator line, if any) from `target`.
 * Returns `{ removed: true }` on success, `{ removed: false, reason: 'not_found' }`
 * if no block for that hash exists.
 */
export function removeMarkerBlock(
  target: string,
  hash: string,
): { removed: boolean; reason?: string } {
  assertSha256(hash);
  if (!existsSync(target)) {
    return { removed: false, reason: 'not_found' };
  }
  const prior = readFileSync(target, 'utf-8');
  const re = blockRegex(hash);
  if (!re.test(prior)) {
    return { removed: false, reason: 'not_found' };
  }

  // Replace block plus at most one surrounding blank-line pair (\n\n before).
  const killRe = new RegExp(
    `(?:\\n\\n)?<!--\\s*graduated:sha256:${hash}\\s+start\\s*-->[\\s\\S]*?<!--\\s*graduated:sha256:${hash}\\s+end\\s*-->\\n?`,
    'g',
  );
  const next = prior.replace(killRe, '');
  atomicWrite(target, next);
  return { removed: true };
}
