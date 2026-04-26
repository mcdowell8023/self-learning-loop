# Adapters Reference

## Built-in Adapters

| Runtime | Adapter | Status |
|---------|---------|--------|
| OpenClaw | `OpenClawAdapter` | ✅ Stable |
| Opencode | `OpencodeAdapter` | ✅ Stable |
| Claude Code | `ClaudeCodeAdapter` | ✅ Stable |
| Codex | `GenericAdapter` (YAML) | ✅ v1.1 |

## How to write a GenericAdapter YAML

The `GenericAdapter` lets you add support for **any** runtime by writing a
YAML mapping file. No TypeScript needed.

### Minimal example

```yaml
runtime_id: my-runtime          # Unique ID
workspace_paths:                # Where to find session files
  - ~/.my-runtime/sessions
session_format: jsonl           # Currently supported: jsonl
field_mapping:
  role: $.role                  # JSONPath to role field
  content: $.content            # JSONPath to content field
  timestamp: $.created_at       # JSONPath to timestamp (optional)
```

### Full example with transforms

```yaml
runtime_id: codex
workspace_paths:
  - ~/.codex/sessions
session_format: jsonl
session_glob: "**/*.jsonl"       # Default: **/*.jsonl

field_mapping:
  session_id: $.session_id       # Optional: session ID field
  message_id: $.id               # Optional: message ID field
  role: $.role                   # Required: who sent this
  content: $.content             # Required: message text
  timestamp: $.ts                # Optional: when it happened
  part_type: $.type              # Optional: tool_call / tool_result

transforms:
  role_map:                      # Map runtime roles → standard roles
    human: user
    bot: assistant
    system: system
  timestamp_format: iso8601      # iso8601 | epoch_ms | epoch_s
```

### Field mapping rules

- Paths use JSONPath dot notation: `$.field` or `$.nested.field`
- Missing fields gracefully default (role→"unknown", content→"", timestamp→now)
- `part_type` overrides role-based event typing (e.g. `tool_call` → `tool_call`)

### Transform rules

- **`role_map`**: dict mapping raw role strings to standard names (`user`, `assistant`, `system`)
- **`timestamp_format`**: hint for parsing — `iso8601` (default), `epoch_ms`, `epoch_s`

### Loading

```typescript
import { GenericAdapter } from './src/adapters/generic.js';

const adapter = new GenericAdapter('configs/adapters/codex.yaml');
const sessions = await adapter.listNewSessions(since);
for await (const event of adapter.extractEvents(sessions[0])) {
  console.log(event.type, event.content);
}
```

### File locations

- Project-bundled: `configs/adapters/<runtime>.yaml`
- User-local: `~/.openclaw/workspace/skills/learning-loop-adapters/<runtime>.yaml`
