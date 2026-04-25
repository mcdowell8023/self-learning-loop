#!/usr/bin/env node
// src/cli/learn.ts
//
// T-P1a-011 · `openclaw-learn` CLI 入口。
//
// 子命令路由：
//   init               → ./init.ts       (runInit)
//   status [id]        → ./status.ts     (runStatus)
//   override <...>     → ./override.ts   (runOverride)
//   config reload      → ../config/loader.ts (reloadConfig)
//
// 手写子命令分发（避免新增 commander 依赖；override 已采用同样风格）。
import { runInit } from './init.js';
import { runStatus } from './status.js';
import { runOverride } from './override.js';
import { runReflect } from './reflect.js';
import { runRepair } from './repair.js';
import { runReview } from './review.js';
import { runAudit } from './audit.js';
import { runConfigShow } from './config-show.js';
import { reloadConfig, loadConfig } from '../config/loader.js';
const TOP_USAGE = [
    'openclaw-learn — Learning Loop CLI (Phase 1a)',
    '',
    'Usage: openclaw-learn <command> [args...]',
    '',
    'Commands:',
    '  init                   Initialise learn/ workspace (SQLite + config.yaml + audit/).',
    '  status [id]            List candidates or show single candidate details.',
    '  reflect              Run a reflection pass (analyse memory, generate candidates).',
    '  review <sub> ...      Query review gate results (list / show).',
    '  override <sub> ...     Force-graduate / force-retire / revert a candidate.',
    '  audit <sub> ...        Query audit log (list / replay / stats).',
    '  config <sub>           Config management (show / reload).',
    '  repair [--dry-run] [--scope <s>]  Repair missing/stale candidate file mirrors.',
    '  help, -h, --help       Show this help.',
    '',
    'Run `openclaw-learn <command> --help` for command-specific help.',
    '',
].join('\n');
export async function runLearn(opts) {
    const out = opts.stdout ?? ((s) => process.stdout.write(s));
    const err = opts.stderr ?? ((s) => process.stderr.write(s));
    const cwd = opts.cwd ?? process.cwd();
    const [cmd, ...rest] = opts.argv;
    if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
        out(TOP_USAGE);
        return { exitCode: 0 };
    }
    switch (cmd) {
        case 'init': {
            const r = await runInit({ argv: rest, cwd, stdout: out, stderr: err });
            return { exitCode: r.exitCode, command: 'init', subResult: r };
        }
        case 'status': {
            const r = await runStatus({ argv: rest, cwd, stdout: out, stderr: err });
            return { exitCode: r.exitCode, command: 'status', subResult: r };
        }
        case 'review': {
            const r = await runReview({ argv: rest, cwd, stdout: out, stderr: err });
            return { exitCode: r.exitCode, command: 'review', subResult: r };
        }
        case 'override': {
            const r = await runOverride({ argv: rest, cwd, stdout: out, stderr: err });
            return { exitCode: r.exitCode, command: 'override', subResult: r };
        }
        case 'reflect': {
            const r = await runReflect({ argv: rest, cwd, stdout: out, stderr: err });
            return { exitCode: r.exitCode, command: 'reflect', subResult: r };
        }
        case 'repair': {
            const r = await runRepair({ argv: rest, cwd, stdout: out, stderr: err });
            return { exitCode: r.exitCode, command: 'repair', subResult: r };
        }
        case 'audit': {
            const r = await runAudit({ argv: rest, cwd, stdout: out, stderr: err });
            return { exitCode: r.exitCode, command: 'audit', subResult: r };
        }
        case 'config': {
            return runConfigGroup(rest, { out, err, cwd });
        }
        default: {
            const msg = `error: unknown command '${cmd}'`;
            err(msg + '\n' + TOP_USAGE);
            return { exitCode: 2, message: msg };
        }
    }
}
async function runConfigGroup(argv, ctx) {
    const [sub, ...rest] = argv;
    if (!sub || sub === '-h' || sub === '--help') {
        ctx.out('Usage: openclaw-learn config <subcommand>\n\n' +
            'Subcommands:\n' +
            '  show      Show current configuration.\n' +
            '  reload    Reload config.yaml (keeps old config on validation failure).\n');
        return { exitCode: 0, command: 'config' };
    }
    if (sub === 'show') {
        return { ...(await runConfigShow({ argv: rest, cwd: ctx.cwd, stdout: ctx.out, stderr: ctx.err })), command: 'config show' };
    }
    if (sub === 'reload') {
        if (rest.some((a) => a === '-h' || a === '--help')) {
            ctx.out('Usage: openclaw-learn config reload\n');
            return { exitCode: 0, command: 'config reload' };
        }
        // Ensure loader has been initialised at least once.
        try {
            loadConfig();
        }
        catch {
            /* loadConfig may fail on first call if no project config — reloadConfig will surface a clean error. */
        }
        const result = reloadConfig();
        if (result.ok) {
            ctx.out(`✓ config reloaded (changed sections: ${result.changed_sections.length > 0 ? result.changed_sections.join(', ') : 'none'})\n`);
            return { exitCode: 0, command: 'config reload', subResult: result };
        }
        else {
            ctx.err(`error: config reload failed [${result.error_code}]: ${result.message}\n`);
            return { exitCode: 6, command: 'config reload', subResult: result };
        }
    }
    const msg = `error: unknown config subcommand '${sub}'`;
    ctx.err(msg + '\n');
    return { exitCode: 2, message: msg };
}
// Entrypoint when invoked as bin.
// Resolve via import.meta.url heuristic for bin compatibility.
const isMain = (() => {
    try {
        const invoked = process.argv[1] ?? '';
        return (invoked.endsWith('learn.js') ||
            invoked.endsWith('learn.ts') ||
            invoked.endsWith('openclaw-learn'));
    }
    catch {
        return false;
    }
})();
if (isMain) {
    runLearn({ argv: process.argv.slice(2) }).then((r) => {
        process.exit(r.exitCode);
    }, (e) => {
        process.stderr.write(`fatal: ${e.message}\n`);
        process.exit(99);
    });
}
