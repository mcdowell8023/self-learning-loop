import type { Candidate } from '../../kernel/types.js';
import type { AssertionRegistry, DimensionResult, ReviewGateConfig, StrategyLookup } from '../types.js';
export interface SemanticReviewDeps {
    config: ReviewGateConfig;
    strategyLookup?: StrategyLookup;
    assertionRegistry?: AssertionRegistry;
}
export declare function reviewSemantic(candidate: Candidate, deps: SemanticReviewDeps): Promise<DimensionResult>;
