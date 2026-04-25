// src/cli/review.ts
//
// CLI: `openclaw-learn review list|show` — Review Gate query commands.
import { openCandidateStore } from '../store/candidate-store.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
const USAGE = [
    'Usage: openclaw-learn review <command> [options]',
    '',
    'Commands:',
    '  list [--state pending|reviewing|validating|rejected]  List candidates by review state.',
    '  show <id>                                             Show candidate review details.',
    '',
].join('\n');
export async function runReview(opts) {
    const out = opts.stdout ?? ((s) => process.stdout.write(s));
    const err = opts.stderr ?? ((s) => process.stderr.write(s));
    const cwd = opts.cwd ?? process.cwd();
    const [sub, ...rest] = opts.argv;
    if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
        out(USAGE);
        return { exitCode: 0 };
    }
    const dbPath = join(cwd, 'learn', 'candidates.db');
    const store = opts.store ?? (existsSync(dbPath)
        ? openCandidateStore({ dbPath, defaultActor: 'system' })
        : null);
    const ownsStore = !opts.store;
    if (!store) {
        err('error: candidate store not found. Run `openclaw-learn init` first.\n');
        return { exitCode: 2, message: 'store not found' };
    }
    try {
        switch (sub) {
            case 'list':
                return reviewList(rest, store, out, err);
            case 'show':
                return reviewShow(rest, store, out, err);
            default:
                err(`error: unknown review subcommand '${sub}'\n` + USAGE);
                return { exitCode: 2, message: `unknown subcommand: ${sub}` };
        }
    }
    finally {
        if (ownsStore) {
            try {
                store.close();
            }
            catch { /* ignore */ }
        }
    }
}
function reviewList(argv, store, out, _err) {
    let stateFilter;
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (tok === '--state' && argv[i + 1]) {
            stateFilter = argv[++i];
        }
        else if (tok.startsWith('--state=')) {
            stateFilter = tok.slice('--state='.length);
        }
    }
    const filter = {};
    if (stateFilter) {
        filter.state = stateFilter;
    }
    else {
        // Default: show review-related states
        filter.state = ['pending', 'reviewing', 'validating'];
    }
    const candidates = store.list(filter);
    if (candidates.length === 0) {
        out('No candidates found.\n');
        return { exitCode: 0 };
    }
    out(`Found ${candidates.length} candidate(s):\n\n`);
    for (const c of candidates) {
        const s = c.strategy;
        out(`  ${c.candidate_id}  [${c.state}]  scope=${s.scope}  category=${s.problem_category ?? '-'}\n`);
    }
    out('\n');
    return { exitCode: 0 };
}
function reviewShow(argv, store, out, err) {
    const id = argv[0];
    if (!id || id.startsWith('-')) {
        err('error: review show requires <candidate_id>\n');
        return { exitCode: 2, message: 'missing id' };
    }
    const candidate = store.get(id);
    if (!candidate) {
        err(`error: candidate not found: ${id}\n`);
        return { exitCode: 3, message: 'not found' };
    }
    const s = candidate.strategy;
    out(`Candidate: ${candidate.candidate_id}\n`);
    out(`  State:    ${candidate.state}\n`);
    out(`  Scope:    ${s.scope}\n`);
    out(`  Category: ${s.problem_category ?? '-'}\n`);
    out(`  Created:  ${candidate.created_at}\n`);
    // Show transitions
    const transitions = store.getTransitions(candidate.candidate_id);
    if (transitions.length > 0) {
        out(`\n  Transitions:\n`);
        for (const t of transitions) {
            out(`    ${t.transitioned_at}  ${t.from_state} → ${t.to_state}  (${t.action}, actor=${t.actor})\n`);
        }
    }
    // Show strategy details
    if (s.trigger_conditions) {
        out(`\n  Trigger:  ${s.trigger_conditions}\n`);
    }
    if (s.recommended_action) {
        out(`  Action:   ${s.recommended_action}\n`);
    }
    out('\n');
    return { exitCode: 0 };
}
