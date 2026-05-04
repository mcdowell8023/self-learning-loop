#!/usr/bin/env npx tsx
/**
 * backfill-chinese-titles.ts
 * 为缺少 title 字段的候选文件回填中文标题。
 * 用法: npx tsx scripts/backfill-chinese-titles.ts [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

import { DOMAIN_TITLE_MAP, humanizeProblemCategory } from '../src/reports/daily-report-generator.js';

const CANDIDATES_DIR = resolve(process.env.HOME ?? '~', '.openclaw/workspace/learn/candidates');
const DRY_RUN = process.argv.includes('--dry-run');

interface Stats { scanned: number; skipped: number; updated: number; errors: number }
const stats: Stats = { scanned: 0, skipped: 0, updated: 0, errors: 0 };

function walk(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) results.push(...walk(full));
      else if (entry.endsWith('.md')) results.push(full);
    }
  } catch { /* dir may not exist */ }
  return results;
}

function generateTitle(problemCategory: string | undefined, candidateId: string): string {
  if (problemCategory && DOMAIN_TITLE_MAP[problemCategory]) return DOMAIN_TITLE_MAP[problemCategory];
  if (problemCategory) return humanizeProblemCategory(problemCategory);
  return `候选 ${candidateId.slice(0, 8)}`;
}

function processFile(filepath: string): void {
  stats.scanned++;
  const raw = readFileSync(filepath, 'utf-8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) { stats.skipped++; return; }

  let fm: Record<string, any>;
  try { fm = YAML.parse(fmMatch[1]!); } catch { stats.errors++; return; }

  if (fm.title) { stats.skipped++; return; }

  const problemCategory = fm.problem_category ?? fm.strategy?.problem_category;
  const candidateId = fm.candidate_id ?? '';
  const title = generateTitle(problemCategory, candidateId);

  if (DRY_RUN) {
    console.log(`[dry-run] ${filepath} → title: "${title}"`);
    stats.updated++;
    return;
  }

  // Insert title after first line of frontmatter
  const fmParsed = YAML.parse(fmMatch[1]!);
  fmParsed.title = title;
  const newFm = YAML.stringify(fmParsed).trim();
  const newContent = raw.replace(/^---\n[\s\S]*?\n---/, `---\n${newFm}\n---`);
  writeFileSync(filepath, newContent, 'utf-8');
  stats.updated++;
  console.log(`[updated] ${filepath} → title: "${title}"`);
}

// Main
const files = walk(CANDIDATES_DIR);
for (const f of files) processFile(f);

console.log(`\n--- 统计 ---`);
console.log(`扫描: ${stats.scanned}`);
console.log(`跳过(已有title): ${stats.skipped}`);
console.log(`更新: ${stats.updated}`);
console.log(`错误: ${stats.errors}`);
if (DRY_RUN) console.log('(dry-run 模式，未实际写入)');
