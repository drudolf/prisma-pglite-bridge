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

## Reference results (2026-07-02)

Raw JSON for every table below is committed under
[`results/`](./results/) — re-run the commands and diff.

### Methodology

- **Machines:** Apple M3 Max (16 cores, 128GB, macOS 26.5.1, Node
  24.18.0) and Intel Core i9-9980HK (8 cores, macOS 26.3.1, Node
  24.14.1). Normal background load, not a quiesced lab — the
  *p50 spread* column (min–max of per-repeat p50s) shows run
  stability; treat cross-adapter ratios as the signal and absolute
  numbers as indicative.
- **Versions:** bridge 1.3.0, `@electric-sql/pglite` 0.5.3 (both
  PGlite adapters resolve the same copy), `pglite-prisma-adapter`
  0.7.2, `@prisma/adapter-pg` 7.8.0, `pg` 8.22.0, Prisma 7.8.0.
- **Real Postgres:** PostgreSQL 18.4 via `embedded-postgres`
  18.4.0-beta.17 — native binaries on both architectures (verified:
  no Rosetta), loopback TCP on port 5433, same machine. Note the
  server's version string reports the packager's x86_64 build host
  on both slices; the arm64 slice was confirmed native via process
  inspection.
- **Statistics:** percentiles computed per repeat, median across
  repeats. No outlier trimming. Latency: n=1000, warmup=100, r=5.
  Micro: n=50, warmup=5, r=3. Memory: r=3, with each repeat in a
  freshly spawned child process (a torn-down PGlite's WASM memory is
  not returned to the OS promptly — on some platforms never within
  the process lifetime — so in-process repeats contaminate each
  other's baselines); the in-workload peak is sampled every 25ms;
  baseline and retained snapshots wait for RSS quiescence (up to
  20s) because PGlite's setup transient drains back to the OS
  asynchronously; retained is measured pre-teardown on the live
  instance.
- PGlite ≥ 0.5.3 matters: it ships the raw-stream parse skip
  ([electric-sql/pglite#1030]) this bridge's protocol path is built
  around. On older engines the bridge compensates at runtime and
  tail latencies are higher.

### Read-path latency — `findmany-focused` (`findMany({ take: 100 })`)

**Apple M3 Max:**

| Adapter | p50 | p95 | p99 | max | p50 spread |
| ----------------------- | ---------- | ---------- | ---------- | ------ | ---------- |
| `prisma-pglite-bridge` | **0.43ms** | **0.50ms** | **1.21ms** | 6.43ms | 0.43–0.44 |
| `pglite-prisma-adapter` | 0.83ms | 0.91ms | 1.83ms | **2.81ms** | 0.82–0.84 |
| `postgres-pg` (native) | **0.43ms** | 1.03ms | 1.43ms | 11.28ms | 0.42–0.62 |

**Intel Core i9-9980HK:**

| Adapter | p50 | p95 | p99 | max | p50 spread |
| ----------------------- | ---------- | ---------- | ---------- | ------ | ---------- |
| `prisma-pglite-bridge` | 1.07ms | 1.56ms | **2.51ms** | 8.45ms | 1.03–1.74 |
| `pglite-prisma-adapter` | 2.16ms | 3.20ms | 4.92ms | 24.29ms | 2.10–2.58 |
| `postgres-pg` (native) | **0.97ms** | **1.41ms** | 2.85ms | **4.87ms** | 0.94–1.05 |

Where the bridge **loses**, so you don't have to squint: native
Postgres wins p50 and p95 on Intel and posts the best worst-case
there; on the M3 Max the direct adapter has the tightest max
(2.81ms vs the bridge's 6.43ms). The bridge's claim is the best
p50-through-p99 *envelope* against the direct adapter (~2x on every
percentile, both machines) and parity with native Postgres on hot
read loops — not universal dominance.

### Operation breadth — `micro` (p50, ratio vs bridge)

**Apple M3 Max:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| single create | **0.13ms** | 0.20ms (1.6x) | 0.20ms (1.6x) |
| 100 createMany | **6.87ms** | 7.37ms (1.1x) | 9.27ms (1.4x) |
| findMany 100 | **0.47ms** | 0.86ms (1.8x) | 0.97ms (2.1x) |
| nested create | **0.59ms** | 1.15ms (1.9x) | 2.34ms (4.0x) |
| deep include | **0.72ms** | 1.25ms (1.7x) | 2.00ms (2.8x) |
| interactive tx | **0.74ms** | 1.05ms (1.4x) | 3.22ms (4.3x) |
| update + find | **0.30ms** | 0.48ms (1.6x) | 2.75ms (9.3x) |

**Intel Core i9-9980HK:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| single create | **0.53ms** | 0.75ms (1.4x) | 0.62ms (1.2x) |
| 100 createMany | 16.14ms | 17.77ms (1.1x) | **15.14ms** (0.9x) |
| findMany 100 | 1.24ms | 2.37ms (1.9x) | **1.15ms** (0.9x) |
| nested create | **2.28ms** | 3.42ms (1.5x) | 2.36ms (1.0x) |
| deep include | **1.91ms** | 3.16ms (1.7x) | 1.91ms (1.0x) |
| interactive tx | **1.84ms** | 3.04ms (1.7x) | 1.87ms (1.0x) |
| update + find | 1.18ms | 1.52ms (1.3x) | **0.98ms** (0.8x) |

Against the direct adapter the bridge wins every operation on both
machines (1.1–1.9x). Against native Postgres the picture is
architecture-dependent: on the M3 Max the in-process path avoids
per-query loopback TCP and wins everything (up to 9x on
`update + find`); on Intel, native Postgres wins `createMany`,
`findMany` and `update + find` outright and ties the rest.

### Memory and cold start

Quiesced post-setup baseline RSS, sampled in-workload peak, and
pre-teardown retained growth during the leak-detect workload (1k
mixed ops); one child process per adapter × repeat:

**Apple M3 Max:**

| Adapter | baseline RSS | peak delta | retained delta | setup time |
| ----------------------- | ------ | ------ | ------ | ------- |
| `prisma-pglite-bridge` | 753MB | **+30MB** | **+12MB** | 720ms |
| `pglite-prisma-adapter` | 729MB | +96MB | +74MB | 747ms |
| `postgres-pg` client | **264MB** | +97MB | +63MB | **84ms** |

**Intel Core i9-9980HK:**

| Adapter | baseline RSS | peak delta | retained delta | setup time |
| ----------------------- | ------ | ------ | ------ | ------- |
| `prisma-pglite-bridge` | 1589MB | +177MB | +176MB | 2031ms |
| `pglite-prisma-adapter` | 1733MB | +118MB | +117MB | 2038ms |
| `postgres-pg` client | **261MB** | **+108MB** | **+54MB** | **103ms** |

Read this honestly: PGlite keeps the entire database (WASM engine +
data) inside your process — the baseline scales with your dataset,
and this scenario's seeded dataset costs RSS a Postgres client never
carries client-side. Absolute RSS is not comparable across machines
(allocator and page-accounting differences; note the ~2x baseline
gap between the two) — compare adapters within a machine. Workload
peaks flip by architecture: the bridge allocates ~3x less than the
direct adapter on the M3 Max but ~1.5x more on Intel; both numbers
are real, we don't currently know which allocator behavior drives
the divergence. Postgres server memory is sampled on the postmaster
only (~+20MB baseline); per-connection backend memory is **not**
captured, so the Postgres server column undercounts. On Apple
Silicon, RSS quiescence is best-effort (20s cap) and one bridge
repeat still showed mild residual decay — treat single-digit-MB
deltas there as within a ~±15MB noise floor (per-repeat ranges are
in the raw JSON). Setup time is the WASM cold-start honesty item:
~0.7s (M3 Max) to ~2s (Intel) before the first query for this
scenario's seed, vs ~0.1s for a Postgres connection.

### What this means

For a test suite issuing ~1000 Prisma queries, the bridge saves
roughly one second per run versus the direct PGlite adapter, and it
buys zero-infrastructure Postgres at near-native-Postgres speed. It
does not make PGlite a production database, and none of these
numbers describe production Postgres over a real network — the value
is operational (no Docker, no server, instant snapshot/reset), not a
raw-speed victory over PostgreSQL itself.

[electric-sql/pglite#1030]: https://github.com/electric-sql/pglite/pull/1030

## Adapters

| Flag value                        | What it benchmarks                                                   |
| --------------------------------- | -------------------------------------------------------------------- |
| `prisma-pglite-bridge` / `bridge` | This package — PGlite behind `@prisma/adapter-pg` via `PgBridgePool` |
| `pglite-prisma-adapter`           | Third-party direct adapter — same PGlite engine, no pg protocol      |
| `postgres-pg` / `postgres`        | Real PostgreSQL over node-postgres                                   |

Pick one with `--adapter <name>`. Omit the flag to run all three.

The `postgres-pg` adapter requires connection info — see
[Environment](#environment).

## Scenarios

| Flag value             | Measures                                                                | Needs `--expose-gc` |
| ---------------------- | ----------------------------------------------------------------------- | :-----------------: |
| `micro` (default)      | Latency of common Prisma ops (create, findMany, tx, nested…)            |                     |
| `stress`               | Contention, throughput, bridge-specific concurrency                     |                     |
| `memory`               | Peak & retained RSS/heap with per-bridge-span attribution               |         yes         |
| `single-query`         | One large-result query in isolation                                     |         yes         |
| `stack-breakdown`      | Attributes peak RSS to stages (`pg.send` → `firstRow` → …)              |         yes         |
| `path-split`           | Separates raw PGlite, adapter, Prisma, and maintenance paths            |         yes         |
| `findmany-focused`     | `findMany({ take: 100 })` in isolation — tail-latency probe             |    recommended      |
| `repeated-large-reads` | Repeated Prisma reads over one 1MB JSON row (`$queryRaw`, `findUnique`) |                     |
| `bytes-sweep`          | Bytea decoder across payload sizes, `Bytes` and `Bytes[]` columns       |                     |
| `text-array-sweep`     | TEXT[] parser across array shapes (tag-like through payload-like)       |                     |

Pick one with `--scenario <name>`, or `--scenario all` for the full set.
`findmany-focused`, `repeated-large-reads`, `path-split`,
`bytes-sweep`, and `text-array-sweep` are explicit-only — none are
included in `all`; target them directly (e.g.
`--scenario findmany-focused`) when hunting read-path,
path-attribution, or decoder regressions.

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
3. Instrument via `stackProbe.patchPg()`, `instrumentBridgePGlite()`,
   `instrumentDirectPGlite()`, and/or `instrumentDriverAdapter()` so the
   stack-breakdown scenario works across adapters.
4. If the adapter runs a server process, provide a
   `serverProcessSampler` on the returned `AdapterContext` so combined
   RSS is tracked.

## Comparing results

To collect results from another machine (e.g. a different CPU
architecture), `scripts/bench-remote.sh <ssh-host>` runs the suite on a
remote checkout over SSH and prints clean result JSON to stdout — see
the header comment for setup assumptions.

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

For repeated large-row Prisma reads, use `repeated-large-reads`:

```bash
pnpm bench --scenario repeated-large-reads -n 100 -w 10
```

That isolates the specific path exercised by repeated 1MB-row
`prisma.$queryRaw()` and `prisma.findUnique()` calls without the
stack-probe overhead of `stack-breakdown`.
