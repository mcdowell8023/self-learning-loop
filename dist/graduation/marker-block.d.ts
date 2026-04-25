export declare function assertSha256(hash: string): void;
/** Build start / end marker lines for a given sha256 hash. */
export declare function markerLines(hash: string): {
    start: string;
    end: string;
};
/** True iff the given file already contains a block for this hash. */
export declare function hasMarkerBlock(filePath: string, hash: string): boolean;
/** Extract the body (text between start+end markers, trimmed of surrounding blank lines) for a hash, or null. */
export declare function readMarkerBlock(filePath: string, hash: string): string | null;
/**
 * Atomically replace `target` with `newContent`.
 * Writes <target>.tmp.<pid>.<rand>, fsyncs, then rename()s.
 *
 * If the write or rename fails, the tmp file is cleaned up and the target file
 * remains untouched. Caller can catch and react.
 */
export declare function atomicWrite(target: string, newContent: string): void;
export interface InjectOptions {
    /** Trailing newline separator inserted before the block if file non-empty and doesn't already end with one. */
    ensureTrailingNewline?: boolean;
}
/**
 * Inject a marker block into `target`. Creates the file if missing.
 * Idempotent: if a block with the same hash already exists, this is a no-op and
 * returns `{ injected: false, reason: 'already_present' }`.
 */
export declare function injectMarkerBlock(target: string, hash: string, body: string, opts?: InjectOptions): {
    injected: boolean;
    reason?: string;
};
/**
 * Remove a marker block (and one adjacent blank separator line, if any) from `target`.
 * Returns `{ removed: true }` on success, `{ removed: false, reason: 'not_found' }`
 * if no block for that hash exists.
 */
export declare function removeMarkerBlock(target: string, hash: string): {
    removed: boolean;
    reason?: string;
};
