/**
 * Public type re-exports for @openclaw/learning-loop.
 * @module
 */

// Session / Collection Layer
export {
  SessionEventSchema,
  SessionRefSchema,
  EnvFingerprintSchema,
  SessionEventTypeSchema,
  type SessionEvent,
  type SessionRef,
  type EnvFingerprint,
} from './session.js';

// Candidate / Learning Kernel
export {
  CandidateStateSchema,
  DormantReasonSchema,
  StrategySchema,
  InstanceSchema,
  AssertionSpecSchema,
  SourceSessionSchema,
  CandidateSchema,
  type CandidateState,
  type DormantReason,
  type Strategy,
  type Instance,
  type AssertionSpec,
  type Candidate,
} from './candidate.js';

// Trial / Shadow Runner
export {
  AssertionStatusSchema,
  AssertionResultSchema,
  SecureL1EvidenceSchema,
  TrialMetricsSchema,
  TrialResultSchema,
  type AssertionStatus,
  type AssertionResult,
  type SecureL1Evidence,
  type TrialMetrics,
  type TrialResult,
} from './trial.js';

// Verdict / Decision Layer
export {
  VerdictNameSchema,
  LayerStatusSchema,
  LayerResultSchema,
  EvaluationVerdictSchema,
  type VerdictName,
  type LayerStatus,
  type LayerResult,
  type EvaluationVerdict,
} from './verdict.js';

// Config
export {
  LearnConfigSchema,
  type LearnConfig,
} from './config.js';

// Audit
export {
  AuditEventSchema,
  type AuditEvent,
} from './audit.js';
