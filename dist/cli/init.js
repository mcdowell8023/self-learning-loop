// src/cli/init.ts
//
// T-P1a-011 · `openclaw-learn init` — 初始化 learn/ 工作区。
//
// 职责：
//   - 创建 `<workspace>/learn/` 目录结构：
//       learn/
//         candidates.db         （SQLite，由 CandidateStore 迁移建表）
//         config.yaml           （从 config.yaml.example 复制而来）
//         audit/                （override + graduation + init 审计）
//   - 幂等：已存在时拒绝（exit 1），`--force` 允许覆盖。
//   - 原子化：失败时回滚本次新建的文件/目录（和 Graduation 风格一致）。
//   - audit：写 audit/init.jsonl 一行 `learn_init` 事件。
//
// 不在范围内：远程同步、migration 升级、user-level config（由 loader 负责）。
import { existsSync, mkdirSync, copyFileSync, appendFileSync, rmSync, readFileSync, writeFileSync, } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openCandidateStore } from '../store/candidate-store.js';
const USAGE = [
    'Usage: openclaw-learn init [--workspace <dir>] [--force]',
    '',
    'Initialise the learn/ workspace: SQLite DB, config.yaml, audit/ dir.',
    '',
    'Options:',
    '  --workspace <dir>  Workspace directory (default: $PWD)',
    '  --force            Overwrite existing learn/ contents',
    '  -h, --help         Show this help',
    '',
].join('\n');
export function parseInitArgs(argv) {
    let workspaceFlag;
    let force = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help')
            return { kind: 'help' };
        else if (a === '--force')
            force = true;
        else if (a === '--workspace') {
            const v = argv[++i];
            if (!v)
                return { kind: 'error', code: 2, message: 'error: --workspace requires a value' };
            workspaceFlag = v;
        }
        else {
            return { kind: 'error', code: 2, message: `error: unknown argument: ${a}` };
        }
    }
    return { kind: 'ok', workspaceFlag, force };
}
function resolveExamplePath() {
    // Try multiple locations: repo root (learn/config.yaml.example) — both when
    // running from source (src/cli) or from dist/cli, walk up until found.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        resolve(here, '../../learn/config.yaml.example'),
        resolve(here, '../../../learn/config.yaml.example'),
        resolve(process.cwd(), 'learn/config.yaml.example'),
    ];
    for (const p of candidates) {
        if (existsSync(p))
            return p;
    }
    return candidates[0]; // let caller error out
}
export async function runInit(opts) {
    const out = opts.stdout ?? ((s) => process.stdout.write(s));
    const err = opts.stderr ?? ((s) => process.stderr.write(s));
    const now = opts.now ?? (() => new Date());
    const uuid = opts.uuid ?? randomUUID;
    const cwd = opts.cwd ?? process.cwd();
    const parsed = parseInitArgs(opts.argv);
    if (parsed.kind === 'error') {
        err((parsed.message ?? 'argument error') + '\n' + USAGE);
        return { exitCode: parsed.code ?? 2, message: parsed.message };
    }
    if (parsed.kind === 'help') {
        out(USAGE);
        return { exitCode: 0 };
    }
    const workspace = parsed.workspaceFlag
        ? (isAbsolute(parsed.workspaceFlag) ? parsed.workspaceFlag : join(cwd, parsed.workspaceFlag))
        : cwd;
    const learnDir = join(workspace, 'learn');
    const dbPath = join(learnDir, 'candidates.db');
    const configPath = join(learnDir, 'config.yaml');
    const auditDir = join(learnDir, 'audit');
    const auditPath = join(auditDir, 'init.jsonl');
    const exists = existsSync(learnDir);
    if (exists && !parsed.force) {
        const msg = `error: ${learnDir} already exists (use --force to overwrite)`;
        err(msg + '\n');
        return { exitCode: 1, message: msg };
    }
    // Track rollback targets: only remove what we created, not pre-existing unrelated files.
    const createdDirs = [];
    const createdFiles = [];
    const ensureDir = (d) => {
        if (!existsSync(d)) {
            mkdirSync(d, { recursive: true });
            createdDirs.push(d);
        }
    };
    const examplePath = resolveExamplePath();
    if (!existsSync(examplePath)) {
        const msg = `error: config.yaml.example not found at ${examplePath}`;
        err(msg + '\n');
        return { exitCode: 4, message: msg };
    }
    let store = null;
    try {
        // Create learn/ dir tree.
        ensureDir(learnDir);
        ensureDir(auditDir);
        // Copy config.yaml (overwrite if --force).
        if (existsSync(configPath) && !parsed.force) {
            // Defensive: shouldn't hit since learnDir existence gate above, but keep as guard.
            throw new Error(`refusing to overwrite ${configPath} without --force`);
        }
        copyFileSync(examplePath, configPath);
        if (!exists || parsed.force)
            createdFiles.push(configPath);
        // If --force and an old DB exists, remove it so migrations run on a fresh file.
        if (parsed.force && existsSync(dbPath)) {
            rmSync(dbPath);
        }
        // Open store — this runs migrations (creates tables).
        store = openCandidateStore({ dbPath });
        // Force a write/read roundtrip to ensure migrations actually ran.
        const mode = store.getJournalMode();
        if (!mode)
            throw new Error('failed to establish SQLite journal mode');
        store.close();
        store = null;
        createdFiles.push(dbPath);
        // Append audit event.
        const auditEventId = uuid();
        const event = {
            event_id: auditEventId,
            action: 'learn_init',
            ts: now().toISOString(),
            workspace,
            learn_dir: learnDir,
            forced: parsed.force ?? false,
        };
        if (!existsSync(auditDir))
            mkdirSync(auditDir, { recursive: true });
        appendFileSync(auditPath, JSON.stringify(event) + '\n', 'utf-8');
        createdFiles.push(auditPath);
        out(`✓ Initialised learn/ workspace at ${learnDir}\n` +
            `  • db:     ${dbPath}\n` +
            `  • config: ${configPath}\n` +
            `  • audit:  ${auditPath}\n`);
        return {
            exitCode: 0,
            workspace,
            learnDir,
            dbPath,
            configPath,
            auditPath,
            auditEventId,
            forced: parsed.force ?? false,
        };
    }
    catch (e) {
        // Rollback.
        if (store) {
            try {
                store.close();
            }
            catch {
                /* ignore */
            }
        }
        for (const f of createdFiles) {
            try {
                if (existsSync(f))
                    rmSync(f, { force: true });
            }
            catch {
                /* ignore */
            }
        }
        // Reverse dir order so children go before parents.
        for (const d of [...createdDirs].reverse()) {
            try {
                if (existsSync(d))
                    rmSync(d, { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
        }
        const msg = `error: init failed: ${e.message}`;
        err(msg + '\n');
        return { exitCode: 5, message: msg };
    }
}
// Exported for tests that want to avoid touching FS further.
export const __internal = { resolveExamplePath };
// Suppress "unused" warnings for helpers consumed only by tests.
void writeFileSync;
void readFileSync;
