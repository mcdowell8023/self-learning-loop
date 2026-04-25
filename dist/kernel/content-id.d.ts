import type { Strategy, Instance } from './types.js';
export declare function computeStrategyId(s: Pick<Strategy, 'problem_category' | 'trigger_conditions' | 'recommended_action'>): string;
export declare function computeInstanceId(i: Pick<Instance, 'strategy_id' | 'diff_summary' | 'env_fingerprint'>): string;
