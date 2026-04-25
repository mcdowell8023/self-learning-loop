# Four-Layer Evaluator (T-P1a-007)

L1 Assertion + L2 Statistical (Welch t-test + Cohen's d) evaluator.
Implements the 13-row truth table from design v5.0.5 §6.1.2 and the
`secure_l1_required` rule (Blocker B2 closure).

## Files

- `evaluator.ts` — Main `evaluateCandidate()` + L1/L2 helpers + confidence
- `evaluator.spec.ts` — TDD suite: truth table 13 rows + edge cases

## Public API

```ts
import { evaluateCandidate, type EvaluatorInput } from './evaluator.js';
const verdict = evaluateCandidate(input);
```

## Path note

Task instruction pins `src/evaluator/` (single-file module) vs ticket's
`src/decision/` (multi-file split). This module is the canonical evaluator;
ticket-level subsplit (`l1-assertion.ts`/`l2-metrics.ts`/`confidence.ts`) is
kept as named exports within `evaluator.ts` to stay within task bounds. If
later tickets (T-P1a-008+) need the split, re-export from here.
