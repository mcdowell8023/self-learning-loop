import type { Candidate } from '../../kernel/types.js';
import type { DimensionResult, ReviewGateConfig } from '../types.js';
export interface SafetyReviewDeps {
    config: ReviewGateConfig;
}
export declare function reviewSafety(candidate: Candidate, deps: SafetyReviewDeps): Promise<DimensionResult>;
