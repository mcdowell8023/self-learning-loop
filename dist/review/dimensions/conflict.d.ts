import type { Candidate } from '../../kernel/types.js';
import type { DimensionResult, ExistingRulesProvider, LlmJudge, ReviewGateConfig } from '../types.js';
export interface ConflictReviewDeps {
    config: ReviewGateConfig;
    rulesProvider?: ExistingRulesProvider;
    llm?: LlmJudge;
}
export declare function reviewConflict(candidate: Candidate, deps: ConflictReviewDeps): Promise<DimensionResult>;
