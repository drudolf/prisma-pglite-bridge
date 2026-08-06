# Mutation testing (duplex + pool)

On-demand mutation testing of `src/duplex/` and `src/pool/` with
[StrykerJS](https://stryker-mutator.io/). It measures test *detection
strength*: for every small syntactic change to production code, does at
least one test fail? The 100% branch-coverage gate proves execution;
mutation testing proves assertion. There is no CI gate and no score
target — the deliverable is a fully triaged survivor ledger (below).

## Running

```bash
pnpm test:mutation            # full cold run over duplex + pool (hours)
pnpm exec stryker run --mutate src/duplex/row-description.ts   # one file
```

Config: `stryker.config.json` (concurrency 1 — the authoritative
setting; higher concurrency produces invisible false verdicts via
StrykerJS #5284/#6073) and `vitest.mutation.config.ts` (the killing
suite: duplex/pool unit + property tests, fast-check pinned to a fixed
seed and reduced `numRuns` via `FC_NUM_RUNS`). Scores are labeled
**reduced-suite** (fixed seed, `numRuns` 50) — not comparable to a
full-suite score. Reports land in `reports/mutation/` (gitignored).

## Reading a run

StrykerJS output is a *candidate map, not a verdict*. Every surviving
mutant is re-verified by hand-applying it and running the covering
tests (the arbiter), because #6073 can mislabel a killed mutant as
survived under load. A survivor is REAL only if the suite stays green
with the mutant applied; RED means the suite already kills it (a false
survivor). Future runs diff their survivor list against the ledger
below — a survivor not in the ledger is a genuine regression in test
strength.

## Disposition taxonomy

- **kill** — behavior is observable; a deterministic example test asserts
  the true behavior (red under the mutant, green after revert). Property
  oracles are never weakened to kill mutants; example tests are the gate.
- **equivalent** — semantically identical on every reachable input;
  recorded here with a one-line proof (no test can kill it). Ledger-only.
- **accept** — deliberately unobservable by the fast suite (a defensive
  `c8`/`v8`-ignored branch, a hygiene-only clear, or an
  integration-only path); suppressed inline with
  `// Stryker disable next-line <mutator>: accept — <reason>`.
- **false-survivor** — #6073 noise; the suite already kills it (RED under
  hand-apply). No action.

### Note on the accept/equivalent split

The plan's taxonomy suggested inline-disabling equivalents too. We
disable only the **accept** bucket (deliberately-unobservable lines,
low volume) and keep **equivalent** mutants ledger-only with proofs —
this keeps ~185 equivalent annotations out of the production source
while preserving a clean regression signal via the ledger diff. Flip
an equivalent to an inline disable only if a future run's noise
warrants it.

## Ledger

*Baseline: cold run over 2483 mutants (concurrency 1). 414 actionable
survivors (Survived + NoCoverage) + 8 StrykerJS RuntimeError mutants,
all dispositioned below. Final reduced-suite scores and the per-mutant
table are recorded at closeout.*

| file | survivors | kill | equivalent | accept | false-surv |
| ---- | --------- | ---- | ---------- | ------ | ---------- |
| duplex/row-description.ts | 16 | 10 | 6 | 0 | 0 |
| duplex/copy-in.ts | 30 | 12 | 18 | 0 | 0 |
| duplex/frontend-buffer.ts | 36 | 3 | 30 | 3 | 0 |
| duplex/backend-framer.ts | 40 | 18 | 19 | 3 | 0 |
| duplex/index.ts | 125 | 70 | 45 | 9 | 1 |
| pool/deallocate.ts | 49 | 5 | 44 | 0 | 0 |
| pool/fast-array-parsers.ts | 10 | 10 | 0 | 0 | 0 |
| pool/fast-query.ts | 10 | 3 | 5 | 2 | 0 |
| pool/pg-internals.ts | 2 | 0 | 2 | 0 | 0 |
| pool/index.ts | 27 | 18 | 1 | 8 | 0 |
| pool/pg-bridge-client.ts | 69 | 38 | 18 | 11 | 2 |
| **total** | **414** | **187** | **188** | **36** | **3** |

Zero survivors exposed a production defect. The 8 RuntimeError mutants:
7 are detected by the existing suite (RED under hand-apply); 1
(`pg-bridge-client.ts` `deregisterLiveClient` idempotency guard) is
covered by a dedicated kill test.

The per-mutant disposition detail (id · mutator · replacement · proof)
lives alongside the kill tests and inline `// Stryker disable` comments
in the source; regenerate the survivor set with `pnpm test:mutation`
and diff against this table.

## Closeout (cold full run, concurrency 1)

Final **reduced-suite** score **92.36%** (2436 covered mutants):

| status | count |
| ------ | ----- |
| Killed | 2168 |
| Timeout | 80 |
| Ignored (inline-disabled) | 47 |
| Survived | 184 |
| NoCoverage | 2 |
| RuntimeError | 2 |

Per file (score · killed · timeout · survived): duplex/backend-framer
93.75% (276·9·19), copy-in 92.86% (208·26·18), frontend-buffer 77.78%
(101·4·30), index 92.06% (504·6·44), row-description 94.39% (95·6·6);
pool/deallocate 84.67% (241·2·44), fast-array-parsers 100% (52·0·0),
fast-query 96.12% (123·1·5), index 99.07% (106·0·1), pg-bridge-client
95.88% (370·26·15), pg-internals 97.85% (91·0·2).

**Verification.** Every one of the 186 undetected (Survived +
NoCoverage) plus 2 RuntimeError mutants was cross-checked against this
ledger by joining on `(mutator, replacement, source-line-text)` —
line-number-independent, since disables shift lines. Result: for every
file `undetected ≤ equivalent`, and each undetected mutant maps to an
`equivalent` proof or a defensive `accept`. **No `kill`-targeted mutant
regressed to Survived** (independently corroborated by the Aug-4
kill-proof: all 187 kills RED under mutant). **Zero production bugs.**

**Four baseline mislabels the cold run corrected** (all benign):

- `pg-bridge-client.ts` `#evictStatementCachesEverywhere`
  `clients !== undefined → true` — baseline **Timeout** (spurious, load
  artifact), so never triaged; hand-apply GREEN → **equivalent** (the
  `/* v8 ignore */` issuer stays registered, so the guard is always true
  on reachable paths).
- `pg-bridge-client.ts` `#fastSubmit` `!isObject(config) → false` —
  baseline **Timeout** (spurious); hand-apply GREEN → **accept**
  (inline-disabled): every legal first-arg is equivalent under the
  mutation, only a type-illegal `null`/`undefined` distinguishes it.
- `pg-bridge-client.ts` callback-error `catch` + `process.nextTick`
  blocks (2 × `BlockStatement`) — the verify-batch harness had labeled
  them `false-survivor`; the structural **NoCoverage** verdict is
  authoritative → **accept** (integration/subprocess-only, already
  `/* v8 ignore */`).

Corrected grand totals: **187 kill / 189 equivalent / 39 accept / 1
false-survivor** (416 triaged; +2290 & +2336 lifted from spurious
baseline Timeouts). 2336's inline disable takes effect on the next run
(moves it Survived → Ignored).
