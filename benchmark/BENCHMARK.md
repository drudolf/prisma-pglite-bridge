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
pnpm bench:isolation                      # per-test isolation cost (own entry point)
pnpm bench:pg-server                      # native Postgres baseline (separate terminal)
```

The first run generates schema SQL via `prisma migrate diff`, so Prisma's
CLI must be resolvable (`pnpm install` takes care of that).

## Reference results

Raw JSON for every table below is committed under
[`results/`](./results/) — re-run the commands and diff. Latency,
operation breadth, and multi-shape reads were refreshed 2026-07-05;
memory and cold start are from the 2026-07-02 run.

### Methodology

- **Machines:** Apple M3 Max (16 cores, 128GB, macOS 26.5.1, Node
  24.18.0), Apple i9-9980HK (8 cores, macOS 26.3.1, Node 24.14.1),
  and Linux i7-8700 (6c/12t, Ubuntu 26.04, Node 24.16.0). The
  read-path, operation-breadth, and multi-shape-read tables cover all
  three; memory and cold start cover the two Apple machines. Normal
  background load, not a quiesced lab — the
  *p50 spread* column (min–max of per-repeat p50s) shows run
  stability; treat cross-adapter ratios as the signal and absolute
  numbers as indicative.
- **Versions:** bridge 1.4.0 + prepared-statement caching (opt-in
  `preparedStatements: true` from the following release),
  `@electric-sql/pglite` 0.5.3 (both PGlite adapters resolve the
  same copy), `pglite-prisma-adapter` 0.7.2, `@prisma/adapter-pg`
  7.8.0, `pg` 8.22.0, Prisma 7.8.0. The bridge rows run with the
  statement cache enabled; native Postgres appears twice — default
  configuration and with `BENCH_POSTGRES_PREPARED=1` giving it the
  same statement-caching lever.
- **Real Postgres:** PostgreSQL 18.4 via `embedded-postgres`
  18.4.0-beta.17 — native binaries on both architectures (verified:
  no Rosetta), loopback TCP on port 5433, same machine. Note the
  server's version string reports the packager's x86_64 build host
  on both slices; the arm64 slice was confirmed native via process
  inspection.
- **Statistics:** percentiles computed per repeat, median across
  repeats. No outlier trimming. Latency: n=1000, warmup=100, r=5.
  Micro: n=60, warmup=10, r=3. Read-mix: n=400, warmup=40, r=1.
  Memory: r=3, with each repeat in a
  freshly spawned child process (a torn-down PGlite's WASM memory is
  not returned to the OS promptly — on some platforms never within
  the process lifetime — so in-process repeats contaminate each
  other's baselines); the in-workload peak is sampled every 25ms;
  baseline and retained snapshots wait for RSS quiescence (up to
  20s) because PGlite's setup transient drains back to the OS
  asynchronously; retained is measured pre-teardown on the live
  instance. Server-side RSS covers the whole postgres process tree
  (postmaster's children resolved at each sample; tree sampled every
  250ms during the workload). Summing per-process RSS double-counts
  `shared_buffers` pages across processes that touch them, so server
  numbers are an upper bound of unique physical memory.
- PGlite ≥ 0.5.3 matters: it ships the raw-stream parse skip
  ([electric-sql/pglite#1030]) this bridge's protocol path is built
  around. On older engines the bridge compensates at runtime and
  tail latencies are higher.

### Read-path latency — `findmany-focused` (`findMany({ take: 100 })`)

Re-measured 2026-07-05 (bridge 1.6.1, PGlite 0.5.3) with the statement
cache enabled in the harness — the bridge's documented fast path
(`preparedStatements: true`). The `postgres-pg` (prepared) rows are
retained from the 2026-07-02 run; native Postgres is hardware-bound and
stable across bridge releases. Raw JSON:
[m3max](./results/2026-07-05-m3max-findmany-focused.json),
[intel](./results/2026-07-05-intel-findmany-focused.json),
[hetzner](./results/2026-07-05-hetzner-findmany-focused.json).

**Apple M3 Max:**

| Adapter | p50 | p95 | p99 | max | p50 spread |
| ------------------------- | ---------- | ---------- | ---------- | ---------- | ---------- |
| `prisma-pglite-bridge` | **0.34ms** | **0.38ms** | **0.63ms** | 3.38ms | 0.34–0.35 |
| `pglite-prisma-adapter` | 0.88ms | 0.99ms | 1.91ms | 5.67ms | 0.87–0.91 |
| `postgres-pg` (default) | 0.51ms | 0.69ms | 1.19ms | **2.48ms** | 0.49–0.52 |
| `postgres-pg` (prepared) | 0.52ms | 0.66ms | 1.25ms | 2.86ms | 0.44–0.52 |

**Apple i9-9980HK:**

| Adapter | p50 | p95 | p99 | max | p50 spread |
| ------------------------- | ---------- | ---------- | ---------- | ---------- | ---------- |
| `prisma-pglite-bridge` | 0.95ms | 1.29ms | **1.79ms** | 7.94ms | 0.94–0.97 |
| `pglite-prisma-adapter` | 2.49ms | 3.12ms | 4.75ms | 7.25ms | 2.43–2.50 |
| `postgres-pg` (default) | 1.10ms | 1.42ms | 2.87ms | **4.64ms** | 1.07–1.13 |
| `postgres-pg` (prepared) | **0.80ms** | **1.18ms** | 2.42ms | 4.80ms | 0.67–0.96 |

**Linux i7-8700:**

| Adapter | p50 | p95 | p99 | max | p50 spread |
| ------------------------- | ---------- | ---------- | ---------- | ---------- | ---------- |
| `prisma-pglite-bridge` | **0.71ms** | **0.81ms** | **1.23ms** | 6.83ms | 0.70–0.72 |
| `pglite-prisma-adapter` | 1.70ms | 3.54ms | 4.16ms | 5.43ms | 1.69–1.73 |
| `postgres-pg` (default) | 0.95ms | 1.04ms | 2.78ms | **4.93ms** | 0.95–0.96 |

Where the bridge **loses**, so you don't have to squint: on Intel,
*prepared* native Postgres still wins p50/p95 (the bridge takes p99),
and native posts the best worst-case (max) in both configs — but the
bridge now beats *default* native Postgres on every percentile there,
and holds its ~2.5x margin over the direct adapter. On the M3 Max the
bridge leads every percentile against every opponent, prepared-native
included, with non-overlapping p50 spreads; the Linux i7-8700 tells the
same story against default native Postgres (prepared-native wasn't
measured there). Across all three machines, native keeps the tightest
max. The prepared-statement asymmetry still holds: statement caching
buys the bridge ~0.1–0.4ms per query (WASM parse/plan is expensive)
but is also worth ~0.1ms to native Postgres — and unlike many
production setups (transaction-mode poolers break named statements),
the bridge can always run with it on (opt-in via
`preparedStatements: true`).

### Operation breadth — `micro` (p50, ratio vs bridge)

Re-measured 2026-07-05 (bridge 1.6.2, PGlite 0.5.3) with the statement
cache enabled in the harness, across all three machines. This is the
mixed picture — writes, transactions, and reads — that the read-path
headline can't show. Raw JSON:
[m3max](./results/2026-07-05-m3max-micro.json),
[intel](./results/2026-07-05-intel-micro.json),
[hetzner](./results/2026-07-05-hetzner-micro.json).

**Apple M3 Max:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| single create | **0.11ms** | 0.23ms (2.1x) | 0.25ms (2.3x) |
| 100 createMany | **6.62ms** | 7.68ms (1.2x) | 11.35ms (1.7x) |
| findMany 100 | **0.44ms** | 0.91ms (2.1x) | 0.71ms (1.6x) |
| nested create | **0.48ms** | 1.20ms (2.5x) | 0.79ms (1.7x) |
| deep include | **0.60ms** | 1.29ms (2.2x) | 0.70ms (1.2x) |
| interactive tx | 0.77ms | 1.17ms (1.5x) | **0.57ms** (0.7x) |
| update + find | **0.23ms** | 0.49ms (2.1x) | 0.29ms (1.3x) |

**Apple i9-9980HK:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| single create | **0.45ms** | 0.73ms (1.6x) | 0.56ms (1.3x) |
| 100 createMany | 15.38ms | 17.27ms (1.1x) | **15.21ms** (1.0x) |
| findMany 100 | **1.15ms** | 2.45ms (2.1x) | 1.16ms (1.0x) |
| nested create | **1.85ms** | 3.79ms (2.1x) | 2.10ms (1.1x) |
| deep include | 1.79ms | 3.56ms (2.0x) | **1.62ms** (0.9x) |
| interactive tx | 2.15ms | 3.16ms (1.5x) | **1.79ms** (0.8x) |
| update + find | **0.90ms** | 1.65ms (1.8x) | 1.10ms (1.2x) |

**Linux i7-8700:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| single create | **0.34ms** | 0.58ms (1.7x) | 0.39ms (1.1x) |
| 100 createMany | **11.82ms** | 13.42ms (1.1x) | 12.70ms (1.1x) |
| findMany 100 | 0.95ms | 1.81ms (1.9x) | **0.95ms** (1.0x) |
| nested create | **1.46ms** | 2.92ms (2.0x) | 1.85ms (1.3x) |
| deep include | **1.52ms** | 2.85ms (1.9x) | 1.80ms (1.2x) |
| interactive tx | **1.63ms** | 2.38ms (1.5x) | 1.69ms (1.0x) |
| update + find | **0.70ms** | 1.27ms (1.8x) | 0.87ms (1.2x) |

Against the direct adapter the bridge wins every operation on every
machine (1.1–2.5x). Against native Postgres the result is
operation- and architecture-dependent:

- **Simple writes and reads** go to the bridge or tie: `single
  create`, `createMany`, `findMany`, `nested create`, and
  `update + find` on all three machines.
- **Interactive transactions are native's.** `interactive tx` goes
  to native Postgres on both Apple machines (M3 Max 0.57 vs 0.77ms;
  Intel 1.79 vs 2.15ms) and is a dead heat on Linux. A `$transaction`
  here is several round-trips — read, conditional write, commit — and
  the bridge's per-message wire-protocol work is visible where a
  single query hides it.
- **Deep includes** go to native on Intel (1.62 vs 1.79ms) and to the
  bridge on the other two.

Micro runs at n=60 are noisier than the read-path probe — ratios near
1.0x move between runs; the stable signals are the
bridge-vs-direct-adapter margin and where native clearly wins
(transactions) or clearly loses (bulk and simple ops on Apple
Silicon).

### Multi-shape reads — `read-mix` (p50, ratio vs bridge)

`findmany-focused` above hammers one SQL shape, which maximally warms
a single prepared-statement cache entry — the bridge's best case
against native Postgres. Real request paths issue many shapes. This
scenario rotates nine distinct read shapes — point lookup, indexed
filter, filtered sort, column projection, one- and three-level
includes, `count`, `groupBy`, and a relation-filtered find — through
one *shared* statement cache every iteration, so no single entry is
specially favored. Measured 2026-07-05 (bridge 1.6.2, n=400,
warmup=40). Raw JSON:
[m3max](./results/2026-07-05-m3max-read-mix.json),
[intel](./results/2026-07-05-intel-read-mix.json),
[hetzner](./results/2026-07-05-hetzner-read-mix.json).

**Apple M3 Max:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| point lookup | **0.11ms** | 0.23ms (2.2x) | 0.14ms (1.3x) |
| indexed where | **0.24ms** | 0.57ms (2.4x) | 0.28ms (1.2x) |
| filter + sort | **0.23ms** | 0.46ms (2.0x) | 0.23ms (1.0x) |
| select projection | **0.16ms** | 0.36ms (2.3x) | 0.18ms (1.2x) |
| include workspace | **0.28ms** | 0.65ms (2.3x) | 0.34ms (1.2x) |
| deep include | **0.42ms** | 1.05ms (2.5x) | 0.54ms (1.3x) |
| count | **0.08ms** | 0.20ms (2.6x) | 0.12ms (1.6x) |
| groupBy status | **0.11ms** | 0.23ms (2.1x) | 0.13ms (1.2x) |
| nested filter | **0.26ms** | 0.57ms (2.2x) | 0.30ms (1.2x) |

**Apple i9-9980HK:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| point lookup | **0.43ms** | 0.74ms (1.7x) | 0.62ms (1.4x) |
| indexed where | **0.68ms** | 1.56ms (2.3x) | 0.98ms (1.4x) |
| filter + sort | **0.62ms** | 1.22ms (2.0x) | 0.84ms (1.4x) |
| select projection | **0.48ms** | 1.02ms (2.2x) | 0.72ms (1.5x) |
| include workspace | **0.93ms** | 1.85ms (2.0x) | 1.33ms (1.4x) |
| deep include | **1.43ms** | 3.07ms (2.1x) | 2.13ms (1.5x) |
| count | **0.31ms** | 0.63ms (2.0x) | 0.57ms (1.9x) |
| groupBy status | **0.35ms** | 0.67ms (1.9x) | 0.56ms (1.6x) |
| nested filter | **0.66ms** | 1.46ms (2.2x) | 1.09ms (1.6x) |

**Linux i7-8700:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| point lookup | **0.33ms** | 0.57ms (1.7x) | 0.43ms (1.3x) |
| indexed where | **0.53ms** | 1.16ms (2.2x) | 0.72ms (1.4x) |
| filter + sort | **0.48ms** | 0.93ms (1.9x) | 0.63ms (1.3x) |
| select projection | **0.37ms** | 0.78ms (2.1x) | 0.63ms (1.7x) |
| include workspace | **0.73ms** | 1.42ms (1.9x) | 0.98ms (1.3x) |
| deep include | **1.13ms** | 2.37ms (2.1x) | 1.58ms (1.4x) |
| count | **0.24ms** | 0.49ms (2.1x) | 0.38ms (1.6x) |
| groupBy status | **0.28ms** | 0.52ms (1.9x) | 0.39ms (1.4x) |
| nested filter | **0.52ms** | 1.13ms (2.2x) | 0.87ms (1.7x) |

The read advantage is not an artifact of single-shape cache warming:
the bridge leads *every* shape on *every* machine — typically 1.2–1.9x
over native Postgres (down to a tie on the fastest M3 Max shapes) and
~2x over the direct adapter — including aggregates (`count`,
`groupBy`) and three-level joins. Prisma emits a bounded set of
parameterized statements, so a diverse read mix stays fully cached and
the bridge's read-path win holds across it, not just in a hot loop.
It is writes and transactions (see `micro` above), not read diversity,
where native Postgres competes.

### Memory and cold start (2026-07-02)

Quiesced post-setup baseline RSS, sampled in-workload peak, and
pre-teardown retained growth during the leak-detect workload (1k
mixed ops); one child process per adapter × repeat:

**Apple M3 Max:**

| Adapter | baseline RSS | peak delta | retained delta | setup time |
| ------------------------- | ------ | ------ | ------ | ------- |
| `prisma-pglite-bridge` | 678MB | +109MB | +108MB | 865ms |
| `pglite-prisma-adapter` | 784MB | +78MB | +23MB | 867ms |
| `postgres-pg` client | **268MB** | +76MB | +45MB | **89ms** |
| `postgres-pg` server tree | 110MB | +12MB | — | — |

**Apple i9-9980HK:**

| Adapter | baseline RSS | peak delta | retained delta | setup time |
| ------------------------- | ------ | ------ | ------ | ------- |
| `prisma-pglite-bridge` | 1611MB | +158MB | +157MB | 2013ms |
| `pglite-prisma-adapter` | 1751MB | +195MB | +194MB | 2048ms |
| `postgres-pg` client | **287MB** | +103MB | +53MB | **109ms** |
| `postgres-pg` server tree | 111MB | +39MB | — | — |

Read this honestly: PGlite keeps the entire database (WASM engine +
data) inside your process — the baseline scales with your dataset,
and this scenario's seeded dataset costs RSS a Postgres client never
carries client-side. Postgres offloads it to a server process tree
(~110MB baseline here) whose numbers are sums of per-process RSS and
therefore double-count `shared_buffers` pages — treat them as an
upper bound of unique physical memory. Absolute RSS is not
comparable across machines (allocator and page-accounting
differences; note the ~2x baseline gap between the two) — compare
adapters within a machine. The in-process **RSS peak deltas are
noisy**: across repeated runs they swing 2–3x (per-repeat ranges are
in the raw JSON), so read them as "tens to ~200MB of transient
growth", not as a stable ranking — an earlier revision of this table
claimed an architecture-dependent bridge-vs-adapter divergence that
did not replicate. The noise is OS page accounting, not allocation:
the JS-level peak deltas are deterministic and identical for both
PGlite adapters (`peakDelta.heapUsed` +26MB, `arrayBuffers` +4MB in
every repeat, both machines — see the raw JSON), while RSS depends
on how much of the setup transient's freed-page pool the OS has
already reclaimed when the workload reuses it (baseline↔peak
anti-correlation r≈−0.8 on Apple Silicon) and on ambient memory
pressure. For adapter comparisons use the heap/arrayBuffers deltas;
baselines, the server tree, and setup times are the other
reproducible signals. On Apple Silicon, RSS
quiescence is best-effort (20s cap); treat single-digit-MB deltas as
within a ~±15MB noise floor. Setup time is the WASM cold-start
honesty item: ~0.9s (M3 Max) to ~2s (Intel) before the first query
for this scenario's seed, vs ~0.1s for a Postgres connection.

### What this means

For a test suite issuing ~1000 Prisma queries, the bridge saves
roughly one second per run versus the direct PGlite adapter — which
it beats on every operation and every machine — and it buys
zero-infrastructure Postgres at native-Postgres speed on the paths a
suite spends most of its time: reads (every shape, every machine) and
simple writes. Native Postgres still wins interactive transactions,
and prepared-native edges the read median on x86. It does not make
PGlite a production database, and none of these numbers describe
production Postgres over a real network — the value is operational
(no Docker, no server, instant snapshot/reset) plus a latency profile
that, outside transactions, no longer asks you to trade speed for it.

[electric-sql/pglite#1030]: https://github.com/electric-sql/pglite/pull/1030

### Per-test isolation cost

Separate from the query benchmarks above, this measures what a test
suite pays *per test* to get an isolated, seeded database — the cost
`createBridgeTest`'s `scope` trades between. It has its own entry
point, since it exercises the bridge's setup lifecycle rather than the
adapter matrix:

```bash
pnpm bench:isolation              # 20 iterations, table
pnpm bench:isolation -n 40 --json
```

It times the three strategies through the library's own code paths
with the realistic integration seed, after a warmup that compiles the
PGlite WASM module once — so these are steady-state per-test figures,
not first-test cost. `cold start` and `template load` create and tear
down an instance every test, so their figure is the full lifecycle;
`snapshot reset` reuses one bridge, so its figure is just the reset.
One-time costs are paid once per file.

macOS, n=20, post-warmup. Apple M3 Max, Node 24.18.0
([raw JSON](./results/2026-07-04-m3max-isolation-cost.json)):

| Strategy       | `scope`           | Per-test p50 |     p99 | One-time (per file) |
| -------------- | ----------------- | -----------: | ------: | ------------------: |
| cold start     | `test` (pre-1.6)  |        634ms |   803ms |                   — |
| snapshot reset | `file` / `worker` |         12ms |    23ms |               0.64s |
| template load  | `test` (1.6+)     |        147ms |   226ms |               0.68s |

Apple i9-9980HK, Node 24.14.1
([raw JSON](./results/2026-07-04-intel-isolation-cost.json)):

| Strategy       | `scope`           | Per-test p50 |     p99 | One-time (per file) |
| -------------- | ----------------- | -----------: | ------: | ------------------: |
| cold start     | `test` (pre-1.6)  |        1.88s |   3.43s |                   — |
| snapshot reset | `file` / `worker` |       42.3ms |  47.9ms |               2.51s |
| template load  | `test` (1.6+)     |        333ms |   364ms |               1.86s |

`snapshot reset` is the cheapest by far, but every test in the file
shares one single-session PGlite — fine serially, unsafe under
`test.concurrent`, and the right default. `template load` (the 1.6
`scope: 'test'`) gives each test its own independent instance — the
only `test.concurrent`-safe option — at ~4–6x less than the old
per-test cold start, and far more predictable: its p99 stays sub-second
on both machines while cold start's tail runs to ~0.8s on the M3 Max
and past 3s on Intel. The trade is memory: each live instance keeps its
own ~40MB in-memory data directory. Cold start is the most
variance-prone (it does the most work per test), so treat the ratio as
the signal and the absolute tail as indicative.

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
| `read-mix`             | Nine distinct read shapes rotated through one shared statement cache    |                     |
| `repeated-large-reads` | Repeated Prisma reads over one 1MB JSON row (`$queryRaw`, `findUnique`) |                     |
| `bytes-sweep`          | Bytea decoder across payload sizes, `Bytes` and `Bytes[]` columns       |                     |
| `text-array-sweep`     | TEXT[] parser across array shapes (tag-like through payload-like)       |                     |

Pick one with `--scenario <name>`, or `--scenario all` for the full set.
`findmany-focused`, `read-mix`, `repeated-large-reads`, `path-split`,
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

The in-process adapters (`bridge`, `pglite-prisma-adapter`) need no
configuration. The `postgres-pg` adapter benchmarks a real PostgreSQL
server, which the repo can start for you — no Docker, no manual setup.

### Native Postgres baseline

Start an embedded PostgreSQL 18 server in one terminal, run the benchmark
in another:

```sh
pnpm bench:pg-server                        # terminal 1 — starts PG, keeps running
pnpm bench --adapter postgres-pg -n 1000    # terminal 2
```

`bench:pg-server` writes `BENCH_POSTGRES_URL` and the postmaster PID
(`BENCH_POSTGRES_SERVER_PIDS`, which enables server-side RSS sampling)
into `.env.test`, then serves `postgres:password@127.0.0.1:5433/bench`
until Ctrl-C. The per-arch Postgres binary comes from `embedded-postgres`
and is built on a plain `pnpm install` (its `@embedded-postgres/*`
packages are approved in `allowBuilds`); if it is ever missing,
`pnpm rebuild embedded-postgres` rebuilds it. Add `BENCH_POSTGRES_PREPARED=1`
to the bench run to compare against prepared-statement Postgres.

To point at your own server instead, put its URL in `.env.test`
(`DATABASE_URL` is accepted as a fallback):

```dotenv
BENCH_POSTGRES_URL=postgresql://user:pass@localhost:5432/bench
BENCH_POSTGRES_SERVER_PIDS=12345   # optional, for server-side RSS sampling
```

### On a second machine over SSH

`scripts/bench-remote.sh <host> [bench args]` runs the suite on a remote
checkout and prints clean result JSON. For the native baseline there,
start `pnpm bench:pg-server` on the remote first — the same `pnpm install`
builds the Postgres binary for that architecture — then run the remote
bench.

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
