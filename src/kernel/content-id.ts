// src/kernel/content-id.ts
// Content-Addressable ID 计算（§5.1.4）
// T-P1a-001 交付的最小子集。

import { createHash } from 'node:crypto';

import type { Strategy, Instance } from './types.js';

function normalize(str: string): string {
  return str.trim().replace(/\s+/g, ' ');
}

export function computeStrategyId(
  s: Pick<Strategy, 'problem_category' | 'trigger_conditions' | 'recommended_action'>,
): string {
  const payload =
    `${normalize(s.problem_category)}\n` +
    `${normalize(s.trigger_conditions)}\n` +
    `${normalize(s.recommended_action)}`;
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function computeInstanceId(
  i: Pick<Instance, 'strategy_id' | 'diff_summary' | 'env_fingerprint'>,
): string {
  const payload =
    `${i.strategy_id}\n` +
    `${normalize(i.diff_summary)}\n` +
    `${i.env_fingerprint.runtime}`;
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
