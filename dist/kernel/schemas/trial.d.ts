/**
 * Trial result types for Shadow Runner.
 * Ref: learning-loop-design-v5.0.3.md §5.5
 * @module
 */
import { z } from 'zod';
/** Status of a single assertion execution. */
export declare const AssertionStatusSchema: z.ZodEnum<["pass", "fail", "timeout", "error", "skipped"]>;
export type AssertionStatus = z.infer<typeof AssertionStatusSchema>;
/** Result of executing one assertion during a trial. */
export declare const AssertionResultSchema: z.ZodObject<{
    /** Assertion type. */
    type: z.ZodString;
    /** Execution status. */
    status: z.ZodEnum<["pass", "fail", "timeout", "error", "skipped"]>;
    /** Execution duration in milliseconds. */
    duration_ms: z.ZodNumber;
    /** Human-readable detail (error message, etc.). */
    detail: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "error" | "pass" | "fail" | "timeout" | "skipped";
    type: string;
    duration_ms: number;
    detail?: string | undefined;
}, {
    status: "error" | "pass" | "fail" | "timeout" | "skipped";
    type: string;
    duration_ms: number;
    detail?: string | undefined;
}>;
export type AssertionResult = z.infer<typeof AssertionResultSchema>;
/** Sandbox execution evidence. Only filled by Assertion Engine in real sandbox. */
export declare const SecureL1EvidenceSchema: z.ZodObject<{
    /** Sandbox backend used. */
    sandbox_type: z.ZodEnum<["bwrap", "firejail", "docker"]>;
    /** Whether exit code was verified. */
    exit_code_verified: z.ZodBoolean;
    /** SHA-256 hash of execution trace for audit. */
    execution_trace_hash: z.ZodString;
    /** Sandbox execution timestamp. */
    timestamp: z.ZodString;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    sandbox_type: "bwrap" | "firejail" | "docker";
    exit_code_verified: boolean;
    execution_trace_hash: string;
}, {
    timestamp: string;
    sandbox_type: "bwrap" | "firejail" | "docker";
    exit_code_verified: boolean;
    execution_trace_hash: string;
}>;
export type SecureL1Evidence = z.infer<typeof SecureL1EvidenceSchema>;
/** Metrics collected during a single trial. */
export declare const TrialMetricsSchema: z.ZodObject<{
    /** Number of conversation turns. */
    turns: z.ZodNumber;
    /** Number of errors encountered. */
    errors: z.ZodNumber;
    /** Total token usage. */
    token_usage: z.ZodNumber;
    /** Task completion rate (0-1). */
    completion_rate: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    turns: number;
    errors: number;
    token_usage: number;
    completion_rate: number;
}, {
    turns: number;
    errors: number;
    token_usage: number;
    completion_rate: number;
}>;
export type TrialMetrics = z.infer<typeof TrialMetricsSchema>;
/** §5.5 TrialResult — one observation in the validation phase. */
export declare const TrialResultSchema: z.ZodObject<{
    /** Unique trial ID. */
    trial_id: z.ZodString;
    /** Associated candidate ID. */
    candidate_id: z.ZodString;
    /** Session where this trial was observed. */
    session_id: z.ZodString;
    /** Runtime where trial ran. */
    runtime: z.ZodString;
    /** Trial start time (ISO 8601). */
    started_at: z.ZodString;
    /** Trial end time (ISO 8601). */
    completed_at: z.ZodString;
    /** Assertion results. */
    assertions: z.ZodArray<z.ZodObject<{
        /** Assertion type. */
        type: z.ZodString;
        /** Execution status. */
        status: z.ZodEnum<["pass", "fail", "timeout", "error", "skipped"]>;
        /** Execution duration in milliseconds. */
        duration_ms: z.ZodNumber;
        /** Human-readable detail (error message, etc.). */
        detail: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "error" | "pass" | "fail" | "timeout" | "skipped";
        type: string;
        duration_ms: number;
        detail?: string | undefined;
    }, {
        status: "error" | "pass" | "fail" | "timeout" | "skipped";
        type: string;
        duration_ms: number;
        detail?: string | undefined;
    }>, "many">;
    /** Collected metrics. */
    metrics: z.ZodObject<{
        /** Number of conversation turns. */
        turns: z.ZodNumber;
        /** Number of errors encountered. */
        errors: z.ZodNumber;
        /** Total token usage. */
        token_usage: z.ZodNumber;
        /** Task completion rate (0-1). */
        completion_rate: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        turns: number;
        errors: number;
        token_usage: number;
        completion_rate: number;
    }, {
        turns: number;
        errors: number;
        token_usage: number;
        completion_rate: number;
    }>;
    /** Environment fingerprint. */
    env_fingerprint: z.ZodObject<{
        runtime: z.ZodString;
        runtimeVersion: z.ZodOptional<z.ZodString>;
        platform: z.ZodEnum<["linux", "darwin", "win32"]>;
        arch: z.ZodEnum<["x64", "arm64"]>;
        model: z.ZodOptional<z.ZodString>;
        nodeVersion: z.ZodOptional<z.ZodString>;
        extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        runtime: string;
        platform: "linux" | "darwin" | "win32";
        arch: "x64" | "arm64";
        runtimeVersion?: string | undefined;
        model?: string | undefined;
        nodeVersion?: string | undefined;
        extensions?: Record<string, unknown> | undefined;
    }, {
        runtime: string;
        platform: "linux" | "darwin" | "win32";
        arch: "x64" | "arm64";
        runtimeVersion?: string | undefined;
        model?: string | undefined;
        nodeVersion?: string | undefined;
        extensions?: Record<string, unknown> | undefined;
    }>;
    /** Sandbox execution evidence (v5.0.2, only present when L1 ran in sandbox). */
    secure_l1_evidence: z.ZodOptional<z.ZodObject<{
        /** Sandbox backend used. */
        sandbox_type: z.ZodEnum<["bwrap", "firejail", "docker"]>;
        /** Whether exit code was verified. */
        exit_code_verified: z.ZodBoolean;
        /** SHA-256 hash of execution trace for audit. */
        execution_trace_hash: z.ZodString;
        /** Sandbox execution timestamp. */
        timestamp: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        timestamp: string;
        sandbox_type: "bwrap" | "firejail" | "docker";
        exit_code_verified: boolean;
        execution_trace_hash: string;
    }, {
        timestamp: string;
        sandbox_type: "bwrap" | "firejail" | "docker";
        exit_code_verified: boolean;
        execution_trace_hash: string;
    }>>;
}, "strip", z.ZodTypeAny, {
    runtime: string;
    candidate_id: string;
    trial_id: string;
    env_fingerprint: {
        runtime: string;
        platform: "linux" | "darwin" | "win32";
        arch: "x64" | "arm64";
        runtimeVersion?: string | undefined;
        model?: string | undefined;
        nodeVersion?: string | undefined;
        extensions?: Record<string, unknown> | undefined;
    };
    session_id: string;
    started_at: string;
    completed_at: string;
    assertions: {
        status: "error" | "pass" | "fail" | "timeout" | "skipped";
        type: string;
        duration_ms: number;
        detail?: string | undefined;
    }[];
    metrics: {
        turns: number;
        errors: number;
        token_usage: number;
        completion_rate: number;
    };
    secure_l1_evidence?: {
        timestamp: string;
        sandbox_type: "bwrap" | "firejail" | "docker";
        exit_code_verified: boolean;
        execution_trace_hash: string;
    } | undefined;
}, {
    runtime: string;
    candidate_id: string;
    trial_id: string;
    env_fingerprint: {
        runtime: string;
        platform: "linux" | "darwin" | "win32";
        arch: "x64" | "arm64";
        runtimeVersion?: string | undefined;
        model?: string | undefined;
        nodeVersion?: string | undefined;
        extensions?: Record<string, unknown> | undefined;
    };
    session_id: string;
    started_at: string;
    completed_at: string;
    assertions: {
        status: "error" | "pass" | "fail" | "timeout" | "skipped";
        type: string;
        duration_ms: number;
        detail?: string | undefined;
    }[];
    metrics: {
        turns: number;
        errors: number;
        token_usage: number;
        completion_rate: number;
    };
    secure_l1_evidence?: {
        timestamp: string;
        sandbox_type: "bwrap" | "firejail" | "docker";
        exit_code_verified: boolean;
        execution_trace_hash: string;
    } | undefined;
}>;
export type TrialResult = z.infer<typeof TrialResultSchema>;
