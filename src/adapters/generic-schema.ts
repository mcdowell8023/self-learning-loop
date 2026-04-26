/**
 * GenericAdapter YAML Mapping Schema — Zod validation for user-defined runtime mappings.
 * Ref: self-learning-loop-skill-design-v1.1.md §4.2.4
 * @module
 */
import { z } from 'zod';

/** Supported session file formats. */
export const SessionFormatSchema = z.enum(['jsonl', 'sqlite', 'yaml', 'json']);

/** Role mapping — transform runtime-specific role names to standard names. */
export const RoleMapSchema = z.record(z.string()).optional().describe(
  'Map runtime role names to standard names (e.g. human→user, bot→assistant)',
);

/** Transform rules for field values. */
export const TransformSchema = z.object({
  /** Map raw role strings to standard role names. */
  role_map: RoleMapSchema,

  /** strftime-compatible format hint for parsing timestamps (informational). */
  timestamp_format: z.string().optional().describe('Hint for timestamp parsing (e.g. iso8601, epoch_ms)'),
}).passthrough().optional();

/** Field mapping — JSONPath-like expressions for extracting standard fields. */
export const FieldMappingSchema = z.object({
  session_id: z.string().optional().describe('JSONPath to session ID field'),
  message_id: z.string().optional().describe('JSONPath to message/event ID field'),
  role: z.string().describe('JSONPath to role field'),
  content: z.string().describe('JSONPath to content field'),
  timestamp: z.string().optional().describe('JSONPath to timestamp field'),
  part_type: z.string().optional().describe('JSONPath to part/event type field'),
}).passthrough();

/** Event extractor configuration. */
export const EventExtractorSchema = z.object({
  type: z.enum(['jsonpath', 'regex', 'custom']).default('jsonpath'),
  template: z.string().optional(),
}).passthrough();

/** Full YAML mapping document schema. */
export const GenericMappingSchema = z.object({
  /** User-defined runtime identifier. */
  runtime_id: z.string().min(1),

  /** Paths to probe for workspace detection. Supports `~` expansion. */
  workspace_paths: z.array(z.string().min(1)).min(1),

  /** Session file format. */
  session_format: SessionFormatSchema,

  /** Glob pattern to find session files within workspace. */
  session_glob: z.string().optional().default('**/*.jsonl'),

  /** Field mapping for extracting standard fields from raw records. */
  field_mapping: FieldMappingSchema.optional(),

  /** Event extractor configuration. */
  event_extractor: EventExtractorSchema.optional(),

  /** Transform rules for field values. */
  transforms: TransformSchema,

  /** Free-form notes (not used at runtime). */
  notes: z.string().optional(),
});

export type GenericMapping = z.infer<typeof GenericMappingSchema>;
