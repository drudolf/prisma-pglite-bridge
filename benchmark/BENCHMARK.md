# Benchmark Suite

Reproducible comparisons of `prisma-pglite-bridge` against other Prisma
Postgres drivers. Everything runs from a single Node process via
`pnpm bench`.

## Quick start

```bash
pnpm bench                                # all adapters, micro scenario
pnpm bench --scenario all                 # all scenarios, all adapters
pnpm bench --adapter bridge -n 20         # more iterations
pnpm bench --json > results.json          # machine-readable output
```

The first run generates schema SQL via `prisma migrate diff`, so Prisma's
CLI must be resolvable (`pnpm install` takes care of that).

## Adapters

| Flag value                        | What it benchmarks                                                 |
| --------------------------------- | ------------------------------------------------------------------ |
| `prisma-pglite-bridge` / `bridge` | This package — PGlite behind `@prisma/adapter-pg` via `createPool` |
| `pglite-prisma-adapter`           | Third-party direct adapter — same PGlite engine, no pg protocol    |
| `postgres-pg` / `postgres`        | Real PostgreSQL over node-postgres                                 |

Pick one with `--adapter <name>`. Omit the flag to run all three.

The `postgres-pg` adapter requires connection info — see
[Environment](#environment).

## Scenarios

| Flag value          | Measures                                                     | Needs `--expose-gc` |
| ------------------- | ------------------------------------------------------------ | :-----------------: |
| `micro` (default)   | Latency of common Prisma ops (create, findMany, tx, nested…) |                     |
| `stress`            | Contention, throughput, bridge-specific concurrency          |                     |
| `memory`            | Peak & retained RSS/heap with per-bridge-span attribution    |         yes         |
| `single-query`      | One large-result query in isolation                          |         yes         |
| `stack-breakdown`   | Attributes peak RSS to stages (`pg.send` → `firstRow` → …)   |         yes         |
| `findmany-focused`  | `findMany({ take: 100 })` in isolation — tail-latency probe  |    recommended      |

Pick one with `--scenario <name>`, or `--scenario all` for the full set.
`findmany-focused` is explicit-only — it is not included in `all`; target
it with `--scenario findmany-focused` when hunting read-path regressions.

## CLI flags

| Flag                      | Default | Meaning                                                  |
| ------------------------- | :-----: | -------------------------------------------------------- |
| `--adapter <name>`        | all     | Filter adapters (matches friendly aliases like `bridge`) |
| `--scenario <name>`       | `micro` | Filter scenarios, or `all`                               |
| `-n <N>` / `--n <N>`      |  `5`    | Iterations per operation                                 |
| `-w <N>` / `--warmup <N>` |  `1`    | Warmup iterations (discarded) before each real run       |
| `-r <N>` / `--repeat <N>` |  `1`    | Whole-run repeats (aggregated per repeat)                |
| `--json`                  |  off    | Emit structured JSON to stdout instead of a table        |

## Memory benchmarks: use `--expose-gc`

The memory scenarios force garbage collection between measurements. Run
them under a node flag passthrough:

```bash
NODE_OPTIONS="--expose-gc" pnpm bench --scenario memory
NODE_OPTIONS="--expose-gc" pnpm bench --scenario all -r 3
```

Without `--expose-gc` the memory numbers are noisy and include GC lag.
The runner warns when you skip it.

## Environment

Create a `.env.test` in the repo root for the `postgres-pg` adapter:

```dotenv
# Required for --adapter postgres-pg
BENCH_POSTGRES_URL=postgresql://user:pass@localhost:5432/bench

# Optional — enables server-side RSS sampling so combined client+server
# memory is reported. Comma-separated PIDs of postgres backend workers.
BENCH_POSTGRES_SERVER_PIDS=12345,12346
```

`DATABASE_URL` is accepted as a fallback for the connection string.
The in-process adapters (`bridge`, `pglite-prisma-adapter`) need no
configuration.

## Output

### Table (default)

Grouped by scenario, one row per adapter + operation. Ratios against the
first adapter in the run are shown in parentheses:

```text
═══ micro ═══════════════════════════════════════════════════════════════
  prisma-pglite-bridge: setup med 120.3ms, … baseline rss client 85.4MB…
  pglite-prisma-adapter: setup med 118.9ms, …

Operation                prisma-pglite-bridge    pglite-prisma-adapter
──────────────────────────────────────────────────────────────────────
single create                        4.2ms          4.1ms (1.0x)
100 createMany                      18.7ms         19.2ms (1.0x)
findMany 100                         3.1ms          2.9ms (0.9x)
…
```

### JSON (`--json`)

Full aggregated results plus every raw run. Suitable for committing as a
snapshot or diffing between branches. Top-level array of adapter×scenario
results; each has `operations[]`, `runs[]`, `baseline`, `peakDelta`,
`retainedDelta`, and per-operation `stackAttribution` if the stack probe
recorded traces.

## Writing a new scenario

1. Create `benchmark/scenarios/<name>.ts` exporting a `Scenario`
   (see `adapters/types.ts` for the contract).
2. Register it in `loadScenarios()` in `benchmark/run.ts`.
3. Return one `ScenarioResult` per named operation; include `memory` /
   `attribution` fields only if your scenario records them.

Use `micro.ts` as a starting point for timing-only scenarios,
`single-query.ts` for memory-sensitive ones, and `stack-breakdown.ts` if
you want stage-level attribution.

## Writing a new adapter

1. Create `benchmark/adapters/<name>.ts` exporting an `AdapterHarness`.
2. Register it in `loadAdapters()` in `benchmark/run.ts` (add any CLI
   aliases there).
3. Instrument via `stackProbe.patchPg()`, `instrumentBridgePglite()`,
   `instrumentDirectPglite()`, and/or `instrumentDriverAdapter()` so the
   stack-breakdown scenario works across adapters.
4. If the adapter runs a server process, provide a
   `serverProcessSampler` on the returned `AdapterContext` so combined
   RSS is tracked.

## Comparing results

The simplest workflow:

```bash
pnpm bench --scenario all -r 3 --json > before.json
# … make changes …
pnpm bench --scenario all -r 3 --json > after.json
# diff the two files manually or with jq:
jq '.[] | {adapter, scenario, median: .operations[0].p50.median}' before.json
jq '.[] | {adapter, scenario, median: .operations[0].p50.median}' after.json
```

For memory regressions, compare `combinedPeakDelta.rss.median` and
`combinedRetainedDelta.rss.median` between runs; those are the bottom
lines. For stage attribution, look at `operations[].stackAttribution.peakStageCounts`
to see whether the peak moved between stages.

### Hunting read-path latency regressions

The aggregate `micro` suite can mask tail-latency regressions on a single
operation behind setup, cross-operation GC noise, and statistical churn.
For targeted read-path investigations, use `findmany-focused` with a high
iteration count and meaningful warmup:

```bash
NODE_OPTIONS="--expose-gc" pnpm bench \
  --scenario findmany-focused -n 1000 -w 100
```

To compare against another revision, check it out into a git worktree and
run the same command in both trees back-to-back:

```bash
git worktree add ../bridge-0.4.1 v0.4.1
cd ../bridge-0.4.1 && pnpm install && pnpm prisma generate
NODE_OPTIONS="--expose-gc" pnpm bench --scenario findmany-focused -n 1000 -w 100
```

Diff the reported `findMany 100` p50/p95/p99 medians between the two
trees — 1000 iterations keep the noise band tight enough that a few
percent regression shows up reliably.
