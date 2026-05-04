import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const DB_PATH = '/home/mcdowell/.openclaw/workspace/learn/candidates.db';
const CANDIDATES_DIR = '/home/mcdowell/.openclaw/workspace/learn/candidates';

const db = new Database(DB_PATH);
const update = db.prepare('UPDATE candidate_state SET title = ? WHERE candidate_id = ?');

let updated = 0;
let skipped = 0;

function walkDir(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walkDir(full); continue; }
    if (!entry.name.endsWith('.md')) continue;
    const content = readFileSync(full, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) { skipped++; continue; }
    const parsed = YAML.parse(fmMatch[1]);
    const cid = parsed?.candidate_id ?? parsed?.id;
    if (!parsed?.title || !cid) { skipped++; continue; }
    const result = update.run(parsed.title, cid);
    if (result.changes > 0) updated++; else skipped++;
  }
}

walkDir(CANDIDATES_DIR);
db.close();
console.log(`Done: updated=${updated} skipped=${skipped}`);
