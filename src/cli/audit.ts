// src/cli/audit.ts
//
// CLI: `openclaw-learn audit list|replay|stats` — Audit log query commands.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AuditRunOptions {
  argv: string[];
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface AuditResult {
  exitCode: number;
  message?: string;
}

const USAGE = [
  'Usage: openclaw-learn audit <command> [options]',
  '',
  'Commands:',
  '  list [--type <t>] [--since <date>] [--limit N]  List audit events (newest first).',
  '  replay <event_id>                                Replay a specific audit event.',
  '  stats [--days N]                                 Show audit statistics.',
  '',
].join('\n');

interface AuditEvent {
  event_id?: string;
  type?: string;
  timestamp?: string;
  actor?: string;
  candidate_id?: string;
  data?: Record<string, unknown>;
  summary?: string;
  [key: string]: unknown;
}

function loadAuditEvents(auditDir: string): AuditEvent[] {
  if (!existsSync(auditDir)) return [];

  const events: AuditEvent[] = [];
  const files = readdirSync(auditDir).filter(f => f.endsWith('.jsonl')).sort();

  for (const file of files) {
    const content = readFileSync(join(auditDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch { /* skip malformed */ }
    }
  }

  return events;
}

export async function runAudit(opts: AuditRunOptions): Promise<AuditResult> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const cwd = opts.cwd ?? process.cwd();

  const [sub, ...rest] = opts.argv;

  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    out(USAGE);
    return { exitCode: 0 };
  }

  const auditDir = join(cwd, 'learn', 'audit');

  switch (sub) {
    case 'list':
      return auditList(rest, auditDir, out, err);
    case 'replay':
      return auditReplay(rest, auditDir, out, err);
    case 'stats':
      return auditStats(rest, auditDir, out, err);
    default:
      err(`error: unknown audit subcommand '${sub}'\n` + USAGE);
      return { exitCode: 2, message: `unknown subcommand: ${sub}` };
  }
}

function auditList(
  argv: string[],
  auditDir: string,
  out: (s: string) => void,
  _err: (s: string) => void,
): AuditResult {
  let typeFilter: string | undefined;
  let sinceFilter: string | undefined;
  let limit = 50;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--type' && argv[i + 1]) typeFilter = argv[++i];
    else if (tok.startsWith('--type=')) typeFilter = tok.slice('--type='.length);
    else if (tok === '--since' && argv[i + 1]) sinceFilter = argv[++i];
    else if (tok.startsWith('--since=')) sinceFilter = tok.slice('--since='.length);
    else if (tok === '--limit' && argv[i + 1]) limit = parseInt(argv[++i]!, 10) || 50;
    else if (tok.startsWith('--limit=')) limit = parseInt(tok.slice('--limit='.length), 10) || 50;
  }

  let events = loadAuditEvents(auditDir);

  if (typeFilter) {
    events = events.filter(e => e.type === typeFilter);
  }
  if (sinceFilter) {
    const sinceDate = new Date(sinceFilter);
    events = events.filter(e => e.timestamp && new Date(e.timestamp) >= sinceDate);
  }

  // Sort newest first
  events.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });

  events = events.slice(0, limit);

  if (events.length === 0) {
    out('No audit events found.\n');
    return { exitCode: 0 };
  }

  out(`Audit events (${events.length}):\n\n`);
  for (const e of events) {
    const id = e.event_id ?? '-';
    const type = e.type ?? '-';
    const ts = e.timestamp ?? '-';
    const actor = e.actor ?? '-';
    const summary = e.summary ?? e.candidate_id ?? '';
    out(`  [${ts}] ${id}  type=${type}  actor=${actor}  ${summary}\n`);
  }
  out('\n');
  return { exitCode: 0 };
}

function auditReplay(
  argv: string[],
  auditDir: string,
  out: (s: string) => void,
  err: (s: string) => void,
): AuditResult {
  const eventId = argv[0];
  if (!eventId || eventId.startsWith('-')) {
    err('error: audit replay requires <event_id>\n');
    return { exitCode: 2, message: 'missing event_id' };
  }

  const events = loadAuditEvents(auditDir);
  const event = events.find(e => e.event_id === eventId);

  if (!event) {
    err(`error: audit event not found: ${eventId}\n`);
    return { exitCode: 3, message: 'event not found' };
  }

  out(`Audit Event Replay:\n`);
  out(JSON.stringify(event, null, 2) + '\n');
  return { exitCode: 0 };
}

function auditStats(
  argv: string[],
  auditDir: string,
  out: (s: string) => void,
  _err: (s: string) => void,
): AuditResult {
  let days = 30;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--days' && argv[i + 1]) days = parseInt(argv[++i]!, 10) || 30;
    else if (tok.startsWith('--days=')) days = parseInt(tok.slice('--days='.length), 10) || 30;
  }

  const cutoff = new Date(Date.now() - days * 86400000);
  let events = loadAuditEvents(auditDir);
  events = events.filter(e => e.timestamp && new Date(e.timestamp) >= cutoff);

  if (events.length === 0) {
    out(`No audit events in the last ${days} days.\n`);
    return { exitCode: 0 };
  }

  // Count by type
  const byType = new Map<string, number>();
  const byActor = new Map<string, number>();
  for (const e of events) {
    const t = e.type ?? 'unknown';
    byType.set(t, (byType.get(t) ?? 0) + 1);
    const a = e.actor ?? 'unknown';
    byActor.set(a, (byActor.get(a) ?? 0) + 1);
  }

  out(`Audit stats (last ${days} days, ${events.length} events):\n\n`);
  out(`  By type:\n`);
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    out(`    ${t}: ${n}\n`);
  }
  out(`\n  By actor:\n`);
  for (const [a, n] of [...byActor.entries()].sort((a, b) => b[1] - a[1])) {
    out(`    ${a}: ${n}\n`);
  }
  out('\n');
  return { exitCode: 0 };
}
