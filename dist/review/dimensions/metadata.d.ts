import type { Candidate } from '../../kernel/types.js';
import type { DimensionResult, ReviewGateConfig } from '../types.js';
export interface MetadataReviewDeps {
    config: ReviewGateConfig;
}
export declare function reviewMetadata(candidate: Candidate, deps: MetadataReviewDeps): Promise<DimensionResult>;
