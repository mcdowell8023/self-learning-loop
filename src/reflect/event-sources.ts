import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { OpenClawAdapter } from '../adapters/openclaw.js';
import type { SessionEvent } from './reflection-prompt.js';

export interface DateBucket {
  date: string;
  events: SessionEvent[];
  files: string[];
  sourceCounts: Record<string, number>;
  sourceItems: string[];
}

function walkFiles(dir: string, depth = 5): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, depth - 1));
    else out.push(full);
  }
  return out;
}

function normalizeDate(ts: Date | string): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fileDate(filePath: string): string {
  const m = basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1]!;
  return normalizeDate(statSync(filePath).mtime);
}

function pushEvent(bucket: DateBucket, source: string, event: SessionEvent, fingerprint: string, filePath?: string): void {
  bucket.events.push(event);
  bucket.sourceCounts[source] = (bucket.sourceCounts[source] ?? 0) + 1;
  bucket.sourceItems.push(`${source}:${fingerprint}`);
  if (filePath) bucket.files.push(filePath);
}

export function createEmptyBucket(date: string): DateBucket {
  return { date, events: [], files: [], sourceCounts: {}, sourceItems: [] };
}

function memoryFileToEvents(filePath: string): SessionEvent[] {
  const content = readFileSync(filePath, 'utf-8');
  if (!content.trim()) return [];
  return [{
    type: 'system',
    timestamp: `${fileDate(filePath)}T00:00:00.000+08:00`,
    content,
    metadata: { source: 'memory', file: basename(filePath) },
  }];
}

function readSnippet(filePath: string, max = 1200): string {
  const raw = readFileSync(filePath, 'utf-8');
  return raw.length > max ? `${raw.slice(0, max)}\n...[truncated ${raw.length - max} chars]` : raw;
}

function collectMemory(workspace: string, buckets: Map<string, DateBucket>): void {
  const memDir = join(workspace, 'memory');
  if (!existsSync(memDir)) return;
  for (const filePath of walkFiles(memDir, 1).filter(file => file.endsWith('.md'))) {
    const date = fileDate(filePath);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    const content = readFileSync(filePath, 'utf-8');
    for (const event of memoryFileToEvents(filePath)) {
      pushEvent(bucket, 'memory', event, createHash('sha256').update(content).digest('hex'), filePath);
    }
  }
}

function shouldCollectGlobalSources(workspace: string): boolean {
  return workspace === join(homedir(), '.openclaw', 'workspace');
}

async function collectOpenClaw(workspace: string, buckets: Map<string, DateBucket>): Promise<void> {
  if (!shouldCollectGlobalSources(workspace)) return;
  const dates = [...buckets.keys()].sort();
  if (dates.length === 0) return;
  const adapter = new OpenClawAdapter({ workspaceDir: workspace });
  const refs = await adapter.listNewSessions(new Date(`${dates[0]}T00:00:00+08:00`));
  for (const ref of refs) {
    const iterRef = { ...ref, lastOffset: 0 };
    for await (const event of adapter.extractEvents(iterRef)) {
      const date = normalizeDate(event.timestamp);
      const bucket = buckets.get(date);
      if (!bucket) continue;
      pushEvent(bucket, 'openclaw', { ...event, timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp }, event.contentHash ?? createHash('sha256').update(`${event.type}:${event.content}`).digest('hex'), ref.path);
    }
  }
}

function collectLearnEvents(workspace: string, buckets: Map<string, DateBucket>): void {
  const eventsDir = join(workspace, 'learn', 'events');
  if (!existsSync(eventsDir)) return;
  for (const filePath of walkFiles(eventsDir).filter(file => /\.(json|jsonl|md|txt)$/.test(file))) {
    const date = fileDate(filePath);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    const content = readSnippet(filePath);
    pushEvent(bucket, 'learn_events', {
      type: 'system',
      timestamp: `${date}T00:00:00.000+08:00`,
      content,
      metadata: { source: 'learn_events', file: filePath },
    }, createHash('sha256').update(content).digest('hex'), filePath);
  }
}

function collectTodoGit(workspace: string, buckets: Map<string, DateBucket>): void {
  for (const date of buckets.keys()) {
    const next = new Date(`${date}T00:00:00+08:00`);
    next.setDate(next.getDate() + 1);
    const until = next.toISOString();
    const since = new Date(`${date}T00:00:00+08:00`).toISOString();
    const result = spawnSync('git', ['-C', workspace, 'log', '--since', since, '--until', until, '--format=%H\t%aI\t%s', '--', 'TODO.md'], {
      encoding: 'utf-8',
    });
    if (result.status !== 0) continue;
    const bucket = buckets.get(date)!;
    const lines = result.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      const [, ts, subject] = line.split('\t');
      pushEvent(bucket, 'todo_git', {
        type: 'system',
        timestamp: ts || `${date}T00:00:00.000+08:00`,
        content: subject || line,
        metadata: { source: 'todo_git' },
      }, createHash('sha256').update(line).digest('hex'));
    }
  }
}

function collectKnowledgeBase(workspace: string, buckets: Map<string, DateBucket>): void {
  if (!shouldCollectGlobalSources(workspace)) return;
  const inboxDir = join(homedir(), 'KnowledgeBase', 'ClawFeed', 'Inbox');
  if (!existsSync(inboxDir)) return;
  for (const filePath of walkFiles(inboxDir).filter(file => /\.(md|txt|json)$/.test(file))) {
    const date = fileDate(filePath);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    const content = readSnippet(filePath);
    pushEvent(bucket, 'knowledge_base', {
      type: 'system',
      timestamp: `${date}T00:00:00.000+08:00`,
      content,
      metadata: { source: 'knowledge_base', file: filePath },
    }, createHash('sha256').update(content).digest('hex'), filePath);
  }
}

export async function collectDateBuckets(workspace: string, dates: string[]): Promise<Map<string, DateBucket>> {
  const buckets = new Map(dates.map(date => [date, createEmptyBucket(date)]));
  collectMemory(workspace, buckets);
  await collectOpenClaw(workspace, buckets);
  collectLearnEvents(workspace, buckets);
  collectTodoGit(workspace, buckets);
  collectKnowledgeBase(workspace, buckets);
  return buckets;
}

export function bucketHash(bucket: DateBucket): string {
  return createHash('sha256').update(bucket.sourceItems.sort().join('\n')).digest('hex');
}
