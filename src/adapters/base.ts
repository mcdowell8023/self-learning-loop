/**
 * RuntimeAdapter — abstract contract for runtime-specific session ingestion.
 * Ref: learning-loop-design-v5.0.3.md §4.1
 * @module
 */
import type { SessionEvent, SessionRef, EnvFingerprint } from '../kernel/schemas/session.js';
import type { AuditEvent } from '../kernel/schemas/audit.js';

/**
 * RuntimeAdapter — extracts normalized events from a runtime-specific session store.
 *
 * Each Runtime implements one Adapter. All I/O methods must throw
 * {@link AdapterError} on failure so the collector can record an audit event
 * without crashing the whole pipeline.
 *
 * §4.1.1 Core interface.
 */
export interface RuntimeAdapter {
  /** Unique adapter identifier (e.g. `"openclaw"`). */
  readonly id: string;

  /** Human-readable display name. */
  readonly displayName: string;

  /** Adapter version (semver). */
  readonly version: string;

  /** Extended event types this adapter may emit (beyond the standard six). */
  readonly extendedEventTypes?: string[];

  /** Returns `true` if this adapter can operate in the current environment. */
  detect(): Promise<boolean>;

  /** Lists session refs whose mtime is at or after `since`. */
  listNewSessions(since: Date): Promise<SessionRef[]>;

  /**
   * Streams normalized events from a single session file.
   * Implementations SHOULD respect `ref.lastOffset` for incremental reads
   * and update persisted offset when iteration completes naturally.
   */
  extractEvents(ref: SessionRef): AsyncIterable<SessionEvent>;

  /** Returns the environment fingerprint (runtime/platform/arch/…). */
  getEnvFingerprint(): Promise<EnvFingerprint>;

  /** Optional health check. */
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;

  /** Optional cleanup. */
  dispose?(): Promise<void>;
}

/**
 * Typed error thrown by adapters on recoverable I/O / parse failures.
 * Collector layer converts these into {@link AuditEvent} records.
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly adapterId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * Audit sink — collector layer provides this so adapters can report
 * non-fatal issues (malformed lines, unknown event types, …) without
 * coupling to a concrete logger implementation.
 */
export type AuditSink = (event: AuditEvent) => void;
