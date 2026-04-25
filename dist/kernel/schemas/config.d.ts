/**
 * Configuration types for the Learning Loop.
 * Ref: learning-loop-design-v5.0.3.md §11
 * @module
 */
import { z } from 'zod';
/** §11.2 Full config.yaml schema. */
export declare const LearnConfigSchema: z.ZodObject<{
    collect: z.ZodDefault<z.ZodObject<{
        adapters: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            enabled: z.ZodDefault<z.ZodBoolean>;
            session_dir: z.ZodOptional<z.ZodString>;
            agents_root: z.ZodOptional<z.ZodString>;
            projects_root: z.ZodOptional<z.ZodString>;
            legacy_session_dir: z.ZodOptional<z.ZodString>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            name: z.ZodString;
            enabled: z.ZodDefault<z.ZodBoolean>;
            session_dir: z.ZodOptional<z.ZodString>;
            agents_root: z.ZodOptional<z.ZodString>;
            projects_root: z.ZodOptional<z.ZodString>;
            legacy_session_dir: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            name: z.ZodString;
            enabled: z.ZodDefault<z.ZodBoolean>;
            session_dir: z.ZodOptional<z.ZodString>;
            agents_root: z.ZodOptional<z.ZodString>;
            projects_root: z.ZodOptional<z.ZodString>;
            legacy_session_dir: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">>, "many">>;
        filters: z.ZodDefault<z.ZodObject<{
            min_turns: z.ZodDefault<z.ZodNumber>;
            min_tool_calls: z.ZodDefault<z.ZodNumber>;
            exclude_labels: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            min_turns: number;
            min_tool_calls: number;
            exclude_labels: string[];
        }, {
            min_turns?: number | undefined;
            min_tool_calls?: number | undefined;
            exclude_labels?: string[] | undefined;
        }>>;
        dedup: z.ZodDefault<z.ZodObject<{
            mode: z.ZodDefault<z.ZodString>;
            window_ms: z.ZodDefault<z.ZodNumber>;
            prefer_richer_env: z.ZodDefault<z.ZodBoolean>;
            trial_dedup_key: z.ZodDefault<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            mode: string;
            window_ms: number;
            prefer_richer_env: boolean;
            trial_dedup_key: string;
        }, {
            mode?: string | undefined;
            window_ms?: number | undefined;
            prefer_richer_env?: boolean | undefined;
            trial_dedup_key?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        adapters: z.objectOutputType<{
            name: z.ZodString;
            enabled: z.ZodDefault<z.ZodBoolean>;
            session_dir: z.ZodOptional<z.ZodString>;
            agents_root: z.ZodOptional<z.ZodString>;
            projects_root: z.ZodOptional<z.ZodString>;
            legacy_session_dir: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">[];
        filters: {
            min_turns: number;
            min_tool_calls: number;
            exclude_labels: string[];
        };
        dedup: {
            mode: string;
            window_ms: number;
            prefer_richer_env: boolean;
            trial_dedup_key: string;
        };
    }, {
        adapters?: z.objectInputType<{
            name: z.ZodString;
            enabled: z.ZodDefault<z.ZodBoolean>;
            session_dir: z.ZodOptional<z.ZodString>;
            agents_root: z.ZodOptional<z.ZodString>;
            projects_root: z.ZodOptional<z.ZodString>;
            legacy_session_dir: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">[] | undefined;
        filters?: {
            min_turns?: number | undefined;
            min_tool_calls?: number | undefined;
            exclude_labels?: string[] | undefined;
        } | undefined;
        dedup?: {
            mode?: string | undefined;
            window_ms?: number | undefined;
            prefer_richer_env?: boolean | undefined;
            trial_dedup_key?: string | undefined;
        } | undefined;
    }>>;
    reflect: z.ZodDefault<z.ZodObject<{
        model: z.ZodDefault<z.ZodString>;
        fallback_model: z.ZodDefault<z.ZodString>;
        prompt_path: z.ZodOptional<z.ZodString>;
        cron: z.ZodDefault<z.ZodString>;
        max_candidates_per_session: z.ZodDefault<z.ZodNumber>;
        temperature: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        model: string;
        fallback_model: string;
        cron: string;
        max_candidates_per_session: number;
        temperature: number;
        prompt_path?: string | undefined;
    }, {
        model?: string | undefined;
        fallback_model?: string | undefined;
        prompt_path?: string | undefined;
        cron?: string | undefined;
        max_candidates_per_session?: number | undefined;
        temperature?: number | undefined;
    }>>;
    shadow: z.ZodDefault<z.ZodObject<{
        min_trials: z.ZodDefault<z.ZodNumber>;
        max_trials: z.ZodDefault<z.ZodNumber>;
        max_daily: z.ZodDefault<z.ZodNumber>;
        observation_mode: z.ZodDefault<z.ZodEnum<["passive", "active"]>>;
        sample_bias_protection: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            min_unique_sessions: z.ZodDefault<z.ZodNumber>;
            max_same_session_ratio: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            min_unique_sessions: number;
            max_same_session_ratio: number;
        }, {
            enabled?: boolean | undefined;
            min_unique_sessions?: number | undefined;
            max_same_session_ratio?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        min_trials: number;
        max_trials: number;
        max_daily: number;
        observation_mode: "passive" | "active";
        sample_bias_protection: {
            enabled: boolean;
            min_unique_sessions: number;
            max_same_session_ratio: number;
        };
    }, {
        min_trials?: number | undefined;
        max_trials?: number | undefined;
        max_daily?: number | undefined;
        observation_mode?: "passive" | "active" | undefined;
        sample_bias_protection?: {
            enabled?: boolean | undefined;
            min_unique_sessions?: number | undefined;
            max_same_session_ratio?: number | undefined;
        } | undefined;
    }>>;
    decision: z.ZodDefault<z.ZodObject<{
        confidence_threshold: z.ZodDefault<z.ZodObject<{
            high: z.ZodDefault<z.ZodNumber>;
            low: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            high: number;
            low: number;
        }, {
            high?: number | undefined;
            low?: number | undefined;
        }>>;
        l3_enabled: z.ZodDefault<z.ZodBoolean>;
        l3_model: z.ZodDefault<z.ZodString>;
        sandbox: z.ZodDefault<z.ZodObject<{
            chain: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            timeout_ms: z.ZodDefault<z.ZodNumber>;
            timeout_max_ms: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            chain: string[];
            timeout_ms: number;
            timeout_max_ms: number;
        }, {
            chain?: string[] | undefined;
            timeout_ms?: number | undefined;
            timeout_max_ms?: number | undefined;
        }>>;
        cluster: z.ZodDefault<z.ZodObject<{
            auto_decide_enabled: z.ZodDefault<z.ZodBoolean>;
            significance_thresholds: z.ZodDefault<z.ZodObject<{
                turns_delta_pct: z.ZodDefault<z.ZodNumber>;
                turns_delta_abs: z.ZodDefault<z.ZodNumber>;
                errors_delta: z.ZodDefault<z.ZodNumber>;
                token_delta_pct: z.ZodDefault<z.ZodNumber>;
                completion_rate_delta_pct: z.ZodDefault<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                turns_delta_pct: number;
                turns_delta_abs: number;
                errors_delta: number;
                token_delta_pct: number;
                completion_rate_delta_pct: number;
            }, {
                turns_delta_pct?: number | undefined;
                turns_delta_abs?: number | undefined;
                errors_delta?: number | undefined;
                token_delta_pct?: number | undefined;
                completion_rate_delta_pct?: number | undefined;
            }>>;
            post_decision_validation_days: z.ZodDefault<z.ZodNumber>;
            auto_rerun_max: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            auto_decide_enabled: boolean;
            significance_thresholds: {
                turns_delta_pct: number;
                turns_delta_abs: number;
                errors_delta: number;
                token_delta_pct: number;
                completion_rate_delta_pct: number;
            };
            post_decision_validation_days: number;
            auto_rerun_max: number;
        }, {
            auto_decide_enabled?: boolean | undefined;
            significance_thresholds?: {
                turns_delta_pct?: number | undefined;
                turns_delta_abs?: number | undefined;
                errors_delta?: number | undefined;
                token_delta_pct?: number | undefined;
                completion_rate_delta_pct?: number | undefined;
            } | undefined;
            post_decision_validation_days?: number | undefined;
            auto_rerun_max?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        confidence_threshold: {
            high: number;
            low: number;
        };
        l3_enabled: boolean;
        l3_model: string;
        sandbox: {
            chain: string[];
            timeout_ms: number;
            timeout_max_ms: number;
        };
        cluster: {
            auto_decide_enabled: boolean;
            significance_thresholds: {
                turns_delta_pct: number;
                turns_delta_abs: number;
                errors_delta: number;
                token_delta_pct: number;
                completion_rate_delta_pct: number;
            };
            post_decision_validation_days: number;
            auto_rerun_max: number;
        };
    }, {
        confidence_threshold?: {
            high?: number | undefined;
            low?: number | undefined;
        } | undefined;
        l3_enabled?: boolean | undefined;
        l3_model?: string | undefined;
        sandbox?: {
            chain?: string[] | undefined;
            timeout_ms?: number | undefined;
            timeout_max_ms?: number | undefined;
        } | undefined;
        cluster?: {
            auto_decide_enabled?: boolean | undefined;
            significance_thresholds?: {
                turns_delta_pct?: number | undefined;
                turns_delta_abs?: number | undefined;
                errors_delta?: number | undefined;
                token_delta_pct?: number | undefined;
                completion_rate_delta_pct?: number | undefined;
            } | undefined;
            post_decision_validation_days?: number | undefined;
            auto_rerun_max?: number | undefined;
        } | undefined;
    }>>;
    graduation: z.ZodDefault<z.ZodObject<{
        scope_routes: z.ZodDefault<z.ZodObject<{
            general: z.ZodDefault<z.ZodString>;
            role: z.ZodDefault<z.ZodString>;
            tool: z.ZodDefault<z.ZodString>;
            skill: z.ZodDefault<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            role: string;
            tool: string;
            general: string;
            skill: string;
        }, {
            role?: string | undefined;
            tool?: string | undefined;
            general?: string | undefined;
            skill?: string | undefined;
        }>>;
        softlink: z.ZodDefault<z.ZodBoolean>;
        rollback_keep: z.ZodDefault<z.ZodNumber>;
        skill_packaging: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            output_dir: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            output_dir?: string | undefined;
        }, {
            enabled?: boolean | undefined;
            output_dir?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        scope_routes: {
            role: string;
            tool: string;
            general: string;
            skill: string;
        };
        softlink: boolean;
        rollback_keep: number;
        skill_packaging: {
            enabled: boolean;
            output_dir?: string | undefined;
        };
    }, {
        scope_routes?: {
            role?: string | undefined;
            tool?: string | undefined;
            general?: string | undefined;
            skill?: string | undefined;
        } | undefined;
        softlink?: boolean | undefined;
        rollback_keep?: number | undefined;
        skill_packaging?: {
            enabled?: boolean | undefined;
            output_dir?: string | undefined;
        } | undefined;
    }>>;
    bridge: z.ZodDefault<z.ZodObject<{
        endpoint: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        a2a_enabled: z.ZodDefault<z.ZodBoolean>;
        credit_limit: z.ZodDefault<z.ZodNumber>;
        auto_publish: z.ZodDefault<z.ZodBoolean>;
        sensitive_patterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        endpoint: string | null;
        a2a_enabled: boolean;
        credit_limit: number;
        auto_publish: boolean;
        sensitive_patterns: string[];
    }, {
        endpoint?: string | null | undefined;
        a2a_enabled?: boolean | undefined;
        credit_limit?: number | undefined;
        auto_publish?: boolean | undefined;
        sensitive_patterns?: string[] | undefined;
    }>>;
    parliament: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        endpoint: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        risk_escalation_rules: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        timeout_ms: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        timeout_ms: number;
        endpoint: string | null;
        risk_escalation_rules: string[];
    }, {
        enabled?: boolean | undefined;
        timeout_ms?: number | undefined;
        endpoint?: string | null | undefined;
        risk_escalation_rules?: string[] | undefined;
    }>>;
    storage: z.ZodDefault<z.ZodObject<{
        base_dir: z.ZodDefault<z.ZodString>;
        audit_dir: z.ZodDefault<z.ZodString>;
        candidates_dir: z.ZodDefault<z.ZodString>;
        clusters_dir: z.ZodDefault<z.ZodString>;
        max_jsonl_size_kb: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        base_dir: string;
        audit_dir: string;
        candidates_dir: string;
        clusters_dir: string;
        max_jsonl_size_kb: number;
    }, {
        base_dir?: string | undefined;
        audit_dir?: string | undefined;
        candidates_dir?: string | undefined;
        clusters_dir?: string | undefined;
        max_jsonl_size_kb?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    collect: {
        adapters: z.objectOutputType<{
            name: z.ZodString;
            enabled: z.ZodDefault<z.ZodBoolean>;
            session_dir: z.ZodOptional<z.ZodString>;
            agents_root: z.ZodOptional<z.ZodString>;
            projects_root: z.ZodOptional<z.ZodString>;
            legacy_session_dir: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">[];
        filters: {
            min_turns: number;
            min_tool_calls: number;
            exclude_labels: string[];
        };
        dedup: {
            mode: string;
            window_ms: number;
            prefer_richer_env: boolean;
            trial_dedup_key: string;
        };
    };
    reflect: {
        model: string;
        fallback_model: string;
        cron: string;
        max_candidates_per_session: number;
        temperature: number;
        prompt_path?: string | undefined;
    };
    shadow: {
        min_trials: number;
        max_trials: number;
        max_daily: number;
        observation_mode: "passive" | "active";
        sample_bias_protection: {
            enabled: boolean;
            min_unique_sessions: number;
            max_same_session_ratio: number;
        };
    };
    decision: {
        confidence_threshold: {
            high: number;
            low: number;
        };
        l3_enabled: boolean;
        l3_model: string;
        sandbox: {
            chain: string[];
            timeout_ms: number;
            timeout_max_ms: number;
        };
        cluster: {
            auto_decide_enabled: boolean;
            significance_thresholds: {
                turns_delta_pct: number;
                turns_delta_abs: number;
                errors_delta: number;
                token_delta_pct: number;
                completion_rate_delta_pct: number;
            };
            post_decision_validation_days: number;
            auto_rerun_max: number;
        };
    };
    graduation: {
        scope_routes: {
            role: string;
            tool: string;
            general: string;
            skill: string;
        };
        softlink: boolean;
        rollback_keep: number;
        skill_packaging: {
            enabled: boolean;
            output_dir?: string | undefined;
        };
    };
    bridge: {
        endpoint: string | null;
        a2a_enabled: boolean;
        credit_limit: number;
        auto_publish: boolean;
        sensitive_patterns: string[];
    };
    parliament: {
        enabled: boolean;
        timeout_ms: number;
        endpoint: string | null;
        risk_escalation_rules: string[];
    };
    storage: {
        base_dir: string;
        audit_dir: string;
        candidates_dir: string;
        clusters_dir: string;
        max_jsonl_size_kb: number;
    };
}, {
    collect?: {
        adapters?: z.objectInputType<{
            name: z.ZodString;
            enabled: z.ZodDefault<z.ZodBoolean>;
            session_dir: z.ZodOptional<z.ZodString>;
            agents_root: z.ZodOptional<z.ZodString>;
            projects_root: z.ZodOptional<z.ZodString>;
            legacy_session_dir: z.ZodOptional<z.ZodString>;
        }, z.ZodTypeAny, "passthrough">[] | undefined;
        filters?: {
            min_turns?: number | undefined;
            min_tool_calls?: number | undefined;
            exclude_labels?: string[] | undefined;
        } | undefined;
        dedup?: {
            mode?: string | undefined;
            window_ms?: number | undefined;
            prefer_richer_env?: boolean | undefined;
            trial_dedup_key?: string | undefined;
        } | undefined;
    } | undefined;
    reflect?: {
        model?: string | undefined;
        fallback_model?: string | undefined;
        prompt_path?: string | undefined;
        cron?: string | undefined;
        max_candidates_per_session?: number | undefined;
        temperature?: number | undefined;
    } | undefined;
    shadow?: {
        min_trials?: number | undefined;
        max_trials?: number | undefined;
        max_daily?: number | undefined;
        observation_mode?: "passive" | "active" | undefined;
        sample_bias_protection?: {
            enabled?: boolean | undefined;
            min_unique_sessions?: number | undefined;
            max_same_session_ratio?: number | undefined;
        } | undefined;
    } | undefined;
    decision?: {
        confidence_threshold?: {
            high?: number | undefined;
            low?: number | undefined;
        } | undefined;
        l3_enabled?: boolean | undefined;
        l3_model?: string | undefined;
        sandbox?: {
            chain?: string[] | undefined;
            timeout_ms?: number | undefined;
            timeout_max_ms?: number | undefined;
        } | undefined;
        cluster?: {
            auto_decide_enabled?: boolean | undefined;
            significance_thresholds?: {
                turns_delta_pct?: number | undefined;
                turns_delta_abs?: number | undefined;
                errors_delta?: number | undefined;
                token_delta_pct?: number | undefined;
                completion_rate_delta_pct?: number | undefined;
            } | undefined;
            post_decision_validation_days?: number | undefined;
            auto_rerun_max?: number | undefined;
        } | undefined;
    } | undefined;
    graduation?: {
        scope_routes?: {
            role?: string | undefined;
            tool?: string | undefined;
            general?: string | undefined;
            skill?: string | undefined;
        } | undefined;
        softlink?: boolean | undefined;
        rollback_keep?: number | undefined;
        skill_packaging?: {
            enabled?: boolean | undefined;
            output_dir?: string | undefined;
        } | undefined;
    } | undefined;
    bridge?: {
        endpoint?: string | null | undefined;
        a2a_enabled?: boolean | undefined;
        credit_limit?: number | undefined;
        auto_publish?: boolean | undefined;
        sensitive_patterns?: string[] | undefined;
    } | undefined;
    parliament?: {
        enabled?: boolean | undefined;
        timeout_ms?: number | undefined;
        endpoint?: string | null | undefined;
        risk_escalation_rules?: string[] | undefined;
    } | undefined;
    storage?: {
        base_dir?: string | undefined;
        audit_dir?: string | undefined;
        candidates_dir?: string | undefined;
        clusters_dir?: string | undefined;
        max_jsonl_size_kb?: number | undefined;
    } | undefined;
}>;
/** Complete Learning Loop configuration. §11 */
export type LearnConfig = z.infer<typeof LearnConfigSchema>;
