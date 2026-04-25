/**
 * Typed error thrown by adapters on recoverable I/O / parse failures.
 * Collector layer converts these into {@link AuditEvent} records.
 */
export class AdapterError extends Error {
    adapterId;
    cause;
    constructor(message, adapterId, cause) {
        super(message);
        this.adapterId = adapterId;
        this.cause = cause;
        this.name = 'AdapterError';
    }
}
