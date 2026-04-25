import { describe, it, expect } from 'vitest';
import { SessionEventSchema } from '../session.js';

describe('[P1a] SessionEvent Schema', () => {
  // Test case #60: session_event_extension_passthrough
  it('#60 should preserve unknown extension fields (passthrough)', () => {
    const input = {
      type: 'user_message',
      timestamp: '2026-04-19T10:00:00+08:00',
      content: 'hello',
      metadata: {},
      // Unknown extension fields — must survive round-trip
      custom_adapter_field: 'some-value',
      x_extra: 42,
    };

    const parsed = SessionEventSchema.parse(input);

    // Extension fields preserved via .passthrough()
    expect((parsed as Record<string, unknown>)['custom_adapter_field']).toBe('some-value');
    expect((parsed as Record<string, unknown>)['x_extra']).toBe(42);

    // Round-trip: serialize → deserialize → same data
    const json = JSON.stringify(parsed);
    const reparsed = SessionEventSchema.parse(JSON.parse(json));
    expect((reparsed as Record<string, unknown>)['custom_adapter_field']).toBe('some-value');
    expect((reparsed as Record<string, unknown>)['x_extra']).toBe(42);
  });

  // Test case #61: unknown_type_graceful
  it('#61 should accept unknown event types gracefully', () => {
    const input = {
      type: 'some_custom_adapter_event',
      timestamp: '2026-04-19T10:00:00+08:00',
      content: 'custom event',
      metadata: { source: 'test' },
    };

    // Should not throw — string union allows arbitrary strings
    const parsed = SessionEventSchema.parse(input);
    expect(parsed.type).toBe('some_custom_adapter_event');
    expect(parsed.content).toBe('custom event');
  });

  it('should serialize/deserialize standard events', () => {
    const input = {
      type: 'tool_call' as const,
      timestamp: '2026-04-19T10:00:00+08:00',
      content: 'Running ls -la',
      metadata: { tool_name: 'exec' },
      contentHash: 'abc123',
    };

    const parsed = SessionEventSchema.parse(input);
    expect(parsed.type).toBe('tool_call');
    expect(parsed.timestamp).toBeInstanceOf(Date);
    expect(parsed.metadata).toEqual({ tool_name: 'exec' });

    // JSON round-trip
    const json = JSON.stringify(parsed);
    const reparsed = SessionEventSchema.parse(JSON.parse(json));
    expect(reparsed.type).toBe('tool_call');
    expect(reparsed.contentHash).toBe('abc123');
  });

  it('should reject events missing required fields', () => {
    expect(() => SessionEventSchema.parse({ type: 'user_message' })).toThrow();
    expect(() => SessionEventSchema.parse({})).toThrow();
  });
});
