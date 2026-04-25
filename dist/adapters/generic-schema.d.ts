/**
 * GenericAdapter YAML Mapping Schema — Zod validation for user-defined runtime mappings.
 * Ref: self-learning-loop-skill-design-v1.1.md §4.2.4
 * @module
 */
import { z } from 'zod';
/** Supported session file formats. */
export declare const SessionFormatSchema: z.ZodEnum<["jsonl", "sqlite", "yaml", "json"]>;
/** Field mapping — JSONPath-like expressions for extracting standard fields. */
export declare const FieldMappingSchema: z.ZodObject<{
    role: z.ZodString;
    content: z.ZodString;
    timestamp: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    role: z.ZodString;
    content: z.ZodString;
    timestamp: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    role: z.ZodString;
    content: z.ZodString;
    timestamp: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** Event extractor configuration. */
export declare const EventExtractorSchema: z.ZodObject<{
    type: z.ZodDefault<z.ZodEnum<["jsonpath", "regex", "custom"]>>;
    template: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    type: z.ZodDefault<z.ZodEnum<["jsonpath", "regex", "custom"]>>;
    template: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    type: z.ZodDefault<z.ZodEnum<["jsonpath", "regex", "custom"]>>;
    template: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** Full YAML mapping document schema. */
export declare const GenericMappingSchema: z.ZodObject<{
    /** User-defined runtime identifier. */
    runtime_id: z.ZodString;
    /** Paths to probe for workspace detection. Supports `~` expansion. */
    workspace_paths: z.ZodArray<z.ZodString, "many">;
    /** Session file format. */
    session_format: z.ZodEnum<["jsonl", "sqlite", "yaml", "json"]>;
    /** Glob pattern to find session files within workspace. */
    session_glob: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    /** Field mapping for extracting standard fields from raw records. */
    field_mapping: z.ZodOptional<z.ZodObject<{
        role: z.ZodString;
        content: z.ZodString;
        timestamp: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        role: z.ZodString;
        content: z.ZodString;
        timestamp: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        role: z.ZodString;
        content: z.ZodString;
        timestamp: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>>;
    /** Event extractor configuration. */
    event_extractor: z.ZodOptional<z.ZodObject<{
        type: z.ZodDefault<z.ZodEnum<["jsonpath", "regex", "custom"]>>;
        template: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodDefault<z.ZodEnum<["jsonpath", "regex", "custom"]>>;
        template: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodDefault<z.ZodEnum<["jsonpath", "regex", "custom"]>>;
        template: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>>;
    /** Free-form notes (not used at runtime). */
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    runtime_id: string;
    workspace_paths: string[];
    session_format: "jsonl" | "sqlite" | "yaml" | "json";
    session_glob: string;
    field_mapping?: z.objectOutputType<{
        role: z.ZodString;
        content: z.ZodString;
        timestamp: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    event_extractor?: z.objectOutputType<{
        type: z.ZodDefault<z.ZodEnum<["jsonpath", "regex", "custom"]>>;
        template: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    notes?: string | undefined;
}, {
    runtime_id: string;
    workspace_paths: string[];
    session_format: "jsonl" | "sqlite" | "yaml" | "json";
    session_glob?: string | undefined;
    field_mapping?: z.objectInputType<{
        role: z.ZodString;
        content: z.ZodString;
        timestamp: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    event_extractor?: z.objectInputType<{
        type: z.ZodDefault<z.ZodEnum<["jsonpath", "regex", "custom"]>>;
        template: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    notes?: string | undefined;
}>;
export type GenericMapping = z.infer<typeof GenericMappingSchema>;
