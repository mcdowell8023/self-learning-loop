/**
 * Configuration types for the Learning Loop.
 * Ref: learning-loop-design-v5.0.3.md §11
 * @module
 */
import { z } from 'zod';
// ─── Sub-schemas ────────────────────────────────────
/**
 * v5.0.5: Adapter session paths use dual-field mode:
 *   - primary (agents_root / projects_root / session_dir)
 *   - legacy_session_dir (fallback, warn-once when hit)
 */
const AdapterConfigSchema = z
    .object({
    name: z.string(),
    enabled: z.boolean().default(true),
    // Generic primary path (adapter-specific alternatives below).
    session_dir: z.string().optional(),
    // openclaw / opencode style
    agents_root: z.string().optional(),
    // claude-code style
    projects_root: z.string().optional(),
    // Legacy fallback (all adapters)
    legacy_session_dir: z.string().optional(),
})
    .passthrough();
const CollectFiltersSchema = z.object({
    min_turns: z.number().int().nonnegative().default(3),
    min_tool_calls: z.number().int().nonnegative().default(1),
    exclude_labels: z.array(z.string()).default([]),
});
const DedupConfigSchema = z.object({
    mode: z.string().default('content_hash_window'),
    window_ms: z.number().int().positive().default(30000),
    prefer_richer_env: z.boolean().default(true),
    trial_dedup_key: z.string().default('candidate_id+runtime+session_id'),
});
const CollectConfigSchema = z.object({
    adapters: z.array(AdapterConfigSchema).default([]),
    filters: CollectFiltersSchema.default({}),
    dedup: DedupConfigSchema.default({}),
});
const ReflectConfigSchema = z.object({
    model: z.string().default('claude-sonnet-4.6'),
    fallback_model: z.string().default('gpt-5-mini'),
    prompt_path: z.string().optional(),
    cron: z.string().default('30 22 * * *'),
    max_candidates_per_session: z.number().int().positive().default(3),
    temperature: z.number().min(0).max(2).default(0.3),
    daily_token_budget: z.number().int().nonnegative().default(50000),
    min_confidence: z.number().min(0).max(1).default(0.65),
    dedup_threshold: z.number().min(0).max(1).default(0.85),
});
const SampleBiasProtectionSchema = z.object({
    enabled: z.boolean().default(true),
    min_unique_sessions: z.number().int().positive().default(2),
    max_same_session_ratio: z.number().min(0).max(1).default(0.6),
});
const ShadowConfigSchema = z.object({
    min_trials: z.number().int().positive().default(3),
    max_trials: z.number().int().positive().default(10),
    max_daily: z.number().int().positive().default(5),
    observation_mode: z.enum(['passive', 'active']).default('passive'),
    sample_bias_protection: SampleBiasProtectionSchema.default({}),
    max_same_session_ratio: z.number().min(0).max(1).default(0.3),
    min_unique_sessions: z.number().int().positive().default(5),
});
const ConfidenceThresholdSchema = z.object({
    high: z.number().min(0).max(1).default(0.7),
    low: z.number().min(0).max(1).default(0.5),
});
const SandboxConfigSchema = z.object({
    chain: z.array(z.string()).default(['bwrap', 'firejail', 'docker']),
    timeout_ms: z.number().int().positive().default(10000),
    timeout_max_ms: z.number().int().positive().default(60000),
});
const SignificanceThresholdsSchema = z.object({
    turns_delta_pct: z.number().default(15),
    turns_delta_abs: z.number().default(2),
    errors_delta: z.number().default(1),
    token_delta_pct: z.number().default(20),
    completion_rate_delta_pct: z.number().default(10),
});
const ClusterConfigSchema = z.object({
    auto_decide_enabled: z.boolean().default(true),
    significance_thresholds: SignificanceThresholdsSchema.default({}),
    post_decision_validation_days: z.number().int().positive().default(5),
    auto_rerun_max: z.number().int().nonnegative().default(2),
});
const DecisionConfigSchema = z.object({
    confidence_threshold: ConfidenceThresholdSchema.default({}),
    l3_enabled: z.boolean().default(false),
    l3_model: z.string().default('claude-sonnet-4.6'),
    sandbox: SandboxConfigSchema.default({}),
    cluster: ClusterConfigSchema.default({}),
});
const ScopeRoutesSchema = z.object({
    general: z.string().default('AGENTS.md'),
    role: z.string().default('agents/{role}.md'),
    tool: z.string().default('TOOLS.md'),
    skill: z.string().default('skills/{skill_name}/SKILL.md'),
});
const SkillPackagingSchema = z.object({
    enabled: z.boolean().default(false),
    output_dir: z.string().optional(),
});
const GraduationConfigSchema = z.object({
    scope_routes: ScopeRoutesSchema.default({}),
    softlink: z.boolean().default(true),
    rollback_keep: z.number().int().nonnegative().default(3),
    skill_packaging: SkillPackagingSchema.default({}),
});
const BridgeConfigSchema = z.object({
    endpoint: z.string().nullable().default(null),
    a2a_enabled: z.boolean().default(false),
    credit_limit: z.number().int().nonnegative().default(100),
    auto_publish: z.boolean().default(false),
    sensitive_patterns: z.array(z.string()).default([
        '(?i)api[_-]?key',
        '(?i)secret',
        '192\\.168\\.',
        '/home/\\w+/',
    ]),
});
const ParliamentConfigSchema = z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().nullable().default(null),
    risk_escalation_rules: z.array(z.string()).default([
        'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7',
    ]),
    timeout_ms: z.number().int().positive().default(30000),
});
const StorageConfigSchema = z.object({
    base_dir: z.string().default('$WORKSPACE/learn'),
    audit_dir: z.string().default('$WORKSPACE/learn/audit'),
    candidates_dir: z.string().default('$WORKSPACE/learn/candidates'),
    clusters_dir: z.string().default('$WORKSPACE/learn/clusters'),
    max_jsonl_size_kb: z.number().int().positive().default(500),
});
// ─── Root Config ────────────────────────────────────
/** §11.2 Full config.yaml schema. */
export const LearnConfigSchema = z.object({
    collect: CollectConfigSchema.default({}),
    reflect: ReflectConfigSchema.default({}),
    shadow: ShadowConfigSchema.default({}),
    decision: DecisionConfigSchema.default({}),
    graduation: GraduationConfigSchema.default({}),
    bridge: BridgeConfigSchema.default({}),
    parliament: ParliamentConfigSchema.default({}),
    storage: StorageConfigSchema.default({}),
});
