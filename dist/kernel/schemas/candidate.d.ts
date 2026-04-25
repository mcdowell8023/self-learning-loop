/**
 * Candidate types for the Learning Kernel.
 * Ref: learning-loop-design-v5.0.3.md §5.1 / §5.2
 * @module
 */
import { z } from 'zod';
/**
 * 8-state lifecycle FSM. §5.2.1
 *
 * pending → reviewing → validating → graduated
 *                                  → retired
 *                                  → conflict → validating | retired
 *                                  → dormant  → validating | retired
 *                       → rejected
 */
export declare const CandidateStateSchema: z.ZodEnum<["pending", "reviewing", "validating", "conflict", "graduated", "retired", "dormant", "rejected"]>;
/** 8-state candidate lifecycle. */
export type CandidateState = z.infer<typeof CandidateStateSchema>;
/** Dormant reason — distinguishes "no matching session" from "conflicting signals". §5.2.1 B3 fix */
export declare const DormantReasonSchema: z.ZodEnum<["no_match", "inconclusive"]>;
export type DormantReason = z.infer<typeof DormantReasonSchema>;
/** §5.1.2 Strategy Schema — reusable experience template. */
export declare const StrategySchema: z.ZodObject<{
    /** Content-addressable ID: SHA256(problem_category + trigger_conditions + recommended_action). */
    strategy_id: z.ZodString;
    /** Problem category. */
    problem_category: z.ZodString;
    /** When to apply this strategy. */
    trigger_conditions: z.ZodString;
    /** What to do. */
    recommended_action: z.ZodString;
    /** Applicability scope. */
    scope: z.ZodUnion<[z.ZodEnum<["general", "skill"]>, z.ZodString, z.ZodString]>;
    /** Optional tags. */
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Creation timestamp (ISO 8601). */
    created_at: z.ZodString;
    /** Associated Instance IDs. */
    instance_ids: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    created_at: string;
    strategy_id: string;
    problem_category: string;
    trigger_conditions: string;
    recommended_action: string;
    scope: string;
    instance_ids: string[];
    tags?: string[] | undefined;
}, {
    created_at: string;
    strategy_id: string;
    problem_category: string;
    trigger_conditions: string;
    recommended_action: string;
    scope: string;
    instance_ids: string[];
    tags?: string[] | undefined;
}>;
export type Strategy = z.infer<typeof StrategySchema>;
/** §5.1.3 Assertion spec embedded in Instance. */
export declare const AssertionSpecSchema: z.ZodObject<{
    /** Assertion type. */
    type: z.ZodString;
    /** Command to run (for command_exit_code type). */
    command: z.ZodOptional<z.ZodString>;
    /** Expected exit code. */
    expected_exit_code: z.ZodOptional<z.ZodNumber>;
    /** Allowed commands (sandbox allowlist). */
    command_allowlist: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Timeout in ms. */
    timeout_ms: z.ZodOptional<z.ZodNumber>;
    /** Sandbox profile. */
    sandbox_profile: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: string;
    timeout_ms?: number | undefined;
    command?: string | undefined;
    expected_exit_code?: number | undefined;
    command_allowlist?: string[] | undefined;
    sandbox_profile?: string | undefined;
}, {
    type: string;
    timeout_ms?: number | undefined;
    command?: string | undefined;
    expected_exit_code?: number | undefined;
    command_allowlist?: string[] | undefined;
    sandbox_profile?: string | undefined;
}>;
export type AssertionSpec = z.infer<typeof AssertionSpecSchema>;
/** Source session reference within an Instance. */
export declare const SourceSessionSchema: z.ZodObject<{
    session_id: z.ZodString;
    runtime: z.ZodString;
    timestamp: z.ZodString;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    runtime: string;
    session_id: string;
}, {
    timestamp: string;
    runtime: string;
    session_id: string;
}>;
/** §5.1.3 Instance Schema — concrete application of a Strategy. */
export declare const InstanceSchema: z.ZodObject<{
    /** Content-addressable ID: SHA256(strategy_id + diff_summary + runtime). */
    instance_id: z.ZodString;
    /** Parent Strategy ID. */
    strategy_id: z.ZodString;
    /** What was actually done. */
    diff_summary: z.ZodString;
    /** Files touched. */
    files_touched: z.ZodArray<z.ZodString, "many">;
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
    /** Source sessions. */
    source_sessions: z.ZodArray<z.ZodObject<{
        session_id: z.ZodString;
        runtime: z.ZodString;
        timestamp: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        timestamp: string;
        runtime: string;
        session_id: string;
    }, {
        timestamp: string;
        runtime: string;
        session_id: string;
    }>, "many">;
    /** Assertion definitions. */
    assertions: z.ZodArray<z.ZodObject<{
        /** Assertion type. */
        type: z.ZodString;
        /** Command to run (for command_exit_code type). */
        command: z.ZodOptional<z.ZodString>;
        /** Expected exit code. */
        expected_exit_code: z.ZodOptional<z.ZodNumber>;
        /** Allowed commands (sandbox allowlist). */
        command_allowlist: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        /** Timeout in ms. */
        timeout_ms: z.ZodOptional<z.ZodNumber>;
        /** Sandbox profile. */
        sandbox_profile: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: string;
        timeout_ms?: number | undefined;
        command?: string | undefined;
        expected_exit_code?: number | undefined;
        command_allowlist?: string[] | undefined;
        sandbox_profile?: string | undefined;
    }, {
        type: string;
        timeout_ms?: number | undefined;
        command?: string | undefined;
        expected_exit_code?: number | undefined;
        command_allowlist?: string[] | undefined;
        sandbox_profile?: string | undefined;
    }>, "many">;
    /** Trial results (populated during validation). */
    trial_results: z.ZodArray<z.ZodLazy<z.ZodRecord<z.ZodString, z.ZodUnknown>>, "many">;
    /** Creation timestamp (ISO 8601). */
    created_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    env_fingerprint: {
        runtime: string;
        platform: "linux" | "darwin" | "win32";
        arch: "x64" | "arm64";
        runtimeVersion?: string | undefined;
        model?: string | undefined;
        nodeVersion?: string | undefined;
        extensions?: Record<string, unknown> | undefined;
    };
    assertions: {
        type: string;
        timeout_ms?: number | undefined;
        command?: string | undefined;
        expected_exit_code?: number | undefined;
        command_allowlist?: string[] | undefined;
        sandbox_profile?: string | undefined;
    }[];
    created_at: string;
    strategy_id: string;
    instance_id: string;
    diff_summary: string;
    files_touched: string[];
    source_sessions: {
        timestamp: string;
        runtime: string;
        session_id: string;
    }[];
    trial_results: Record<string, unknown>[];
}, {
    env_fingerprint: {
        runtime: string;
        platform: "linux" | "darwin" | "win32";
        arch: "x64" | "arm64";
        runtimeVersion?: string | undefined;
        model?: string | undefined;
        nodeVersion?: string | undefined;
        extensions?: Record<string, unknown> | undefined;
    };
    assertions: {
        type: string;
        timeout_ms?: number | undefined;
        command?: string | undefined;
        expected_exit_code?: number | undefined;
        command_allowlist?: string[] | undefined;
        sandbox_profile?: string | undefined;
    }[];
    created_at: string;
    strategy_id: string;
    instance_id: string;
    diff_summary: string;
    files_touched: string[];
    source_sessions: {
        timestamp: string;
        runtime: string;
        session_id: string;
    }[];
    trial_results: Record<string, unknown>[];
}>;
export type Instance = z.infer<typeof InstanceSchema>;
/** Full candidate record as persisted in SQLite. */
export declare const CandidateSchema: z.ZodObject<{
    /** Candidate ID (= strategy_id for now, may diverge). */
    candidate_id: z.ZodString;
    /** Strategy ID. */
    strategy_id: z.ZodString;
    /** Current lifecycle state. */
    state: z.ZodEnum<["pending", "reviewing", "validating", "conflict", "graduated", "retired", "dormant", "rejected"]>;
    /** Dormant reason (only when state=dormant). */
    dormant_reason: z.ZodOptional<z.ZodNullable<z.ZodEnum<["no_match", "inconclusive"]>>>;
    /** Full candidate data. */
    data: z.ZodObject<{
        strategy: z.ZodObject<{
            /** Content-addressable ID: SHA256(problem_category + trigger_conditions + recommended_action). */
            strategy_id: z.ZodString;
            /** Problem category. */
            problem_category: z.ZodString;
            /** When to apply this strategy. */
            trigger_conditions: z.ZodString;
            /** What to do. */
            recommended_action: z.ZodString;
            /** Applicability scope. */
            scope: z.ZodUnion<[z.ZodEnum<["general", "skill"]>, z.ZodString, z.ZodString]>;
            /** Optional tags. */
            tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            /** Creation timestamp (ISO 8601). */
            created_at: z.ZodString;
            /** Associated Instance IDs. */
            instance_ids: z.ZodArray<z.ZodString, "many">;
        }, "strip", z.ZodTypeAny, {
            created_at: string;
            strategy_id: string;
            problem_category: string;
            trigger_conditions: string;
            recommended_action: string;
            scope: string;
            instance_ids: string[];
            tags?: string[] | undefined;
        }, {
            created_at: string;
            strategy_id: string;
            problem_category: string;
            trigger_conditions: string;
            recommended_action: string;
            scope: string;
            instance_ids: string[];
            tags?: string[] | undefined;
        }>;
        instances: z.ZodArray<z.ZodObject<{
            /** Content-addressable ID: SHA256(strategy_id + diff_summary + runtime). */
            instance_id: z.ZodString;
            /** Parent Strategy ID. */
            strategy_id: z.ZodString;
            /** What was actually done. */
            diff_summary: z.ZodString;
            /** Files touched. */
            files_touched: z.ZodArray<z.ZodString, "many">;
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
            /** Source sessions. */
            source_sessions: z.ZodArray<z.ZodObject<{
                session_id: z.ZodString;
                runtime: z.ZodString;
                timestamp: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                timestamp: string;
                runtime: string;
                session_id: string;
            }, {
                timestamp: string;
                runtime: string;
                session_id: string;
            }>, "many">;
            /** Assertion definitions. */
            assertions: z.ZodArray<z.ZodObject<{
                /** Assertion type. */
                type: z.ZodString;
                /** Command to run (for command_exit_code type). */
                command: z.ZodOptional<z.ZodString>;
                /** Expected exit code. */
                expected_exit_code: z.ZodOptional<z.ZodNumber>;
                /** Allowed commands (sandbox allowlist). */
                command_allowlist: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                /** Timeout in ms. */
                timeout_ms: z.ZodOptional<z.ZodNumber>;
                /** Sandbox profile. */
                sandbox_profile: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                type: string;
                timeout_ms?: number | undefined;
                command?: string | undefined;
                expected_exit_code?: number | undefined;
                command_allowlist?: string[] | undefined;
                sandbox_profile?: string | undefined;
            }, {
                type: string;
                timeout_ms?: number | undefined;
                command?: string | undefined;
                expected_exit_code?: number | undefined;
                command_allowlist?: string[] | undefined;
                sandbox_profile?: string | undefined;
            }>, "many">;
            /** Trial results (populated during validation). */
            trial_results: z.ZodArray<z.ZodLazy<z.ZodRecord<z.ZodString, z.ZodUnknown>>, "many">;
            /** Creation timestamp (ISO 8601). */
            created_at: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            env_fingerprint: {
                runtime: string;
                platform: "linux" | "darwin" | "win32";
                arch: "x64" | "arm64";
                runtimeVersion?: string | undefined;
                model?: string | undefined;
                nodeVersion?: string | undefined;
                extensions?: Record<string, unknown> | undefined;
            };
            assertions: {
                type: string;
                timeout_ms?: number | undefined;
                command?: string | undefined;
                expected_exit_code?: number | undefined;
                command_allowlist?: string[] | undefined;
                sandbox_profile?: string | undefined;
            }[];
            created_at: string;
            strategy_id: string;
            instance_id: string;
            diff_summary: string;
            files_touched: string[];
            source_sessions: {
                timestamp: string;
                runtime: string;
                session_id: string;
            }[];
            trial_results: Record<string, unknown>[];
        }, {
            env_fingerprint: {
                runtime: string;
                platform: "linux" | "darwin" | "win32";
                arch: "x64" | "arm64";
                runtimeVersion?: string | undefined;
                model?: string | undefined;
                nodeVersion?: string | undefined;
                extensions?: Record<string, unknown> | undefined;
            };
            assertions: {
                type: string;
                timeout_ms?: number | undefined;
                command?: string | undefined;
                expected_exit_code?: number | undefined;
                command_allowlist?: string[] | undefined;
                sandbox_profile?: string | undefined;
            }[];
            created_at: string;
            strategy_id: string;
            instance_id: string;
            diff_summary: string;
            files_touched: string[];
            source_sessions: {
                timestamp: string;
                runtime: string;
                session_id: string;
            }[];
            trial_results: Record<string, unknown>[];
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        strategy: {
            created_at: string;
            strategy_id: string;
            problem_category: string;
            trigger_conditions: string;
            recommended_action: string;
            scope: string;
            instance_ids: string[];
            tags?: string[] | undefined;
        };
        instances: {
            env_fingerprint: {
                runtime: string;
                platform: "linux" | "darwin" | "win32";
                arch: "x64" | "arm64";
                runtimeVersion?: string | undefined;
                model?: string | undefined;
                nodeVersion?: string | undefined;
                extensions?: Record<string, unknown> | undefined;
            };
            assertions: {
                type: string;
                timeout_ms?: number | undefined;
                command?: string | undefined;
                expected_exit_code?: number | undefined;
                command_allowlist?: string[] | undefined;
                sandbox_profile?: string | undefined;
            }[];
            created_at: string;
            strategy_id: string;
            instance_id: string;
            diff_summary: string;
            files_touched: string[];
            source_sessions: {
                timestamp: string;
                runtime: string;
                session_id: string;
            }[];
            trial_results: Record<string, unknown>[];
        }[];
    }, {
        strategy: {
            created_at: string;
            strategy_id: string;
            problem_category: string;
            trigger_conditions: string;
            recommended_action: string;
            scope: string;
            instance_ids: string[];
            tags?: string[] | undefined;
        };
        instances: {
            env_fingerprint: {
                runtime: string;
                platform: "linux" | "darwin" | "win32";
                arch: "x64" | "arm64";
                runtimeVersion?: string | undefined;
                model?: string | undefined;
                nodeVersion?: string | undefined;
                extensions?: Record<string, unknown> | undefined;
            };
            assertions: {
                type: string;
                timeout_ms?: number | undefined;
                command?: string | undefined;
                expected_exit_code?: number | undefined;
                command_allowlist?: string[] | undefined;
                sandbox_profile?: string | undefined;
            }[];
            created_at: string;
            strategy_id: string;
            instance_id: string;
            diff_summary: string;
            files_touched: string[];
            source_sessions: {
                timestamp: string;
                runtime: string;
                session_id: string;
            }[];
            trial_results: Record<string, unknown>[];
        }[];
    }>;
    /** Created timestamp. */
    created_at: z.ZodString;
    /** Last updated timestamp. */
    updated_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    candidate_id: string;
    data: {
        strategy: {
            created_at: string;
            strategy_id: string;
            problem_category: string;
            trigger_conditions: string;
            recommended_action: string;
            scope: string;
            instance_ids: string[];
            tags?: string[] | undefined;
        };
        instances: {
            env_fingerprint: {
                runtime: string;
                platform: "linux" | "darwin" | "win32";
                arch: "x64" | "arm64";
                runtimeVersion?: string | undefined;
                model?: string | undefined;
                nodeVersion?: string | undefined;
                extensions?: Record<string, unknown> | undefined;
            };
            assertions: {
                type: string;
                timeout_ms?: number | undefined;
                command?: string | undefined;
                expected_exit_code?: number | undefined;
                command_allowlist?: string[] | undefined;
                sandbox_profile?: string | undefined;
            }[];
            created_at: string;
            strategy_id: string;
            instance_id: string;
            diff_summary: string;
            files_touched: string[];
            source_sessions: {
                timestamp: string;
                runtime: string;
                session_id: string;
            }[];
            trial_results: Record<string, unknown>[];
        }[];
    };
    state: "graduated" | "retired" | "dormant" | "pending" | "reviewing" | "validating" | "conflict" | "rejected";
    created_at: string;
    updated_at: string;
    strategy_id: string;
    dormant_reason?: "inconclusive" | "no_match" | null | undefined;
}, {
    candidate_id: string;
    data: {
        strategy: {
            created_at: string;
            strategy_id: string;
            problem_category: string;
            trigger_conditions: string;
            recommended_action: string;
            scope: string;
            instance_ids: string[];
            tags?: string[] | undefined;
        };
        instances: {
            env_fingerprint: {
                runtime: string;
                platform: "linux" | "darwin" | "win32";
                arch: "x64" | "arm64";
                runtimeVersion?: string | undefined;
                model?: string | undefined;
                nodeVersion?: string | undefined;
                extensions?: Record<string, unknown> | undefined;
            };
            assertions: {
                type: string;
                timeout_ms?: number | undefined;
                command?: string | undefined;
                expected_exit_code?: number | undefined;
                command_allowlist?: string[] | undefined;
                sandbox_profile?: string | undefined;
            }[];
            created_at: string;
            strategy_id: string;
            instance_id: string;
            diff_summary: string;
            files_touched: string[];
            source_sessions: {
                timestamp: string;
                runtime: string;
                session_id: string;
            }[];
            trial_results: Record<string, unknown>[];
        }[];
    };
    state: "graduated" | "retired" | "dormant" | "pending" | "reviewing" | "validating" | "conflict" | "rejected";
    created_at: string;
    updated_at: string;
    strategy_id: string;
    dormant_reason?: "inconclusive" | "no_match" | null | undefined;
}>;
export type Candidate = z.infer<typeof CandidateSchema>;
