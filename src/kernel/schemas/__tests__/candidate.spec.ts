import { describe, it, expect } from 'vitest';
import { CandidateStateSchema, CandidateSchema, DormantReasonSchema } from '../candidate.js';

describe('[P1a] Candidate Types', () => {
  it('should define all 8 states', () => {
    const states = CandidateStateSchema.options;
    expect(states).toHaveLength(8);
    expect(states).toEqual([
      'pending',
      'reviewing',
      'validating',
      'conflict',
      'graduated',
      'retired',
      'dormant',
      'rejected',
    ]);
  });

  it('should validate dormant_reason enum', () => {
    expect(DormantReasonSchema.parse('no_match')).toBe('no_match');
    expect(DormantReasonSchema.parse('inconclusive')).toBe('inconclusive');
    expect(() => DormantReasonSchema.parse('invalid')).toThrow();
  });

  it('should serialize/deserialize a full Candidate round-trip', () => {
    const candidate = {
      candidate_id: 'sha256:abc123',
      strategy_id: 'sha256:abc123',
      state: 'dormant' as const,
      dormant_reason: 'no_match' as const,
      data: {
        strategy: {
          strategy_id: 'sha256:abc123',
          problem_category: 'file_cleanup',
          trigger_conditions: 'tmp files left after task',
          recommended_action: 'rm -f /tmp/prefix*',
          scope: 'general' as const,
          tags: ['cleanup'],
          created_at: '2026-04-19T10:00:00+08:00',
          instance_ids: ['sha256:def456'],
        },
        instances: [{
          instance_id: 'sha256:def456',
          strategy_id: 'sha256:abc123',
          diff_summary: 'Added cleanup step to SKILL.md',
          files_touched: ['skills/video-summarizer/SKILL.md'],
          env_fingerprint: {
            runtime: 'openclaw',
            platform: 'linux' as const,
            arch: 'x64' as const,
          },
          source_sessions: [{
            session_id: 'oc-2026-04-18-001',
            runtime: 'openclaw',
            timestamp: '2026-04-18T10:00:00+08:00',
          }],
          assertions: [{
            type: 'command_exit_code',
            command: 'test ! -f /tmp/test-marker',
            expected_exit_code: 0,
            command_allowlist: ['test'],
            timeout_ms: 5000,
            sandbox_profile: 'readonly',
          }],
          trial_results: [],
          created_at: '2026-04-19T10:00:00+08:00',
        }],
      },
      created_at: '2026-04-19T10:00:00+08:00',
      updated_at: '2026-04-19T10:00:00+08:00',
    };

    const parsed = CandidateSchema.parse(candidate);
    expect(parsed.state).toBe('dormant');
    expect(parsed.dormant_reason).toBe('no_match');

    // JSON round-trip
    const json = JSON.stringify(parsed);
    const reparsed = CandidateSchema.parse(JSON.parse(json));
    expect(reparsed.data.strategy.problem_category).toBe('file_cleanup');
    expect(reparsed.data.instances).toHaveLength(1);
    expect(reparsed.data.instances[0].assertions[0].type).toBe('command_exit_code');
  });

  it('should reject invalid state values', () => {
    expect(() => CandidateStateSchema.parse('unknown_state')).toThrow();
  });
});
