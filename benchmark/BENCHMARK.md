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
pnpm bench:orm                            # ORM native drivers vs the bridge (own entry point)
```

The first run generates schema SQL via `prisma migrate diff`, so Prisma's
CLI must be resolvable (`pnpm install` takes care of that).

## Reference results

Every table below is reproducible from the commands in this file —
re-run and diff. All latency tables (read path, operation breadth,
multi-shape reads, transactions) were refreshed 2026-07-06 on all
three machines; memory and cold start were re-measured the same day
on the two Apple machines.

### Methodology

- **Machines:** Apple M3 Max (16 cores, 128GB, macOS 26.5.1, Node
  24.18.0), Apple i9-9980HK (8 cores, macOS 26.3.1, Node 24.14.1),
  and Linux i7-8700 (6c/12t, Ubuntu 26.04, Node 24.18.0). All
  latency tables cover all three; memory and cold start cover the
  two Apple machines. Normal background load, not a quiesced lab —
  the *p50 spread* column (min–max of per-repeat p50s) shows run
  stability; treat cross-adapter ratios as the signal and absolute
  numbers as indicative. The tables show the second of two full
  same-day runs (2026-07-06) — the first caught the i9 under residual
  load from earlier test suites, the published one is the clean
  session. The two runs reproduced each other within 1–3% per
  operation on the M3 Max and Linux, and within ±20% on individual
  i9 operations, without a single ranking change.
- **Versions:** bridge 1.7.0 (measured pre-release at `a35e971`:
  prepared-statement caching and the lean fast-query path on — the
  1.7 defaults; the harness sets no opt-in flags),
  `@electric-sql/pglite` 0.5.4 (both PGlite adapters resolve the same
  copy — the tables below were measured on 0.5.3 and are published
  unchanged; a 2026-07-08 three-machine re-run on 0.5.4 reproduced
  them within noise with no ranking changes), `pglite-prisma-adapter`
  0.7.2, `@prisma/adapter-pg` 7.8.0, `pg` 8.22.0, Prisma 7.8.0.
  Native Postgres appears twice — default configuration and with
  `BENCH_POSTGRES_PREPARED=1` giving it the same statement-caching
  lever; the prepared rows were measured fresh on all three machines
  this time (previously retained from 2026-07-02 and never measured
  on Linux).
- **Real Postgres:** PostgreSQL 18.4 via `embedded-postgres`
  18.4.0-beta.17 — native binaries on both architectures (verified:
  no Rosetta), loopback TCP on port 5433, same machine. Note the
  server's version string reports the packager's x86_64 build host
  on both slices; the arm64 slice was confirmed native via process
  inspection.
- **Statistics:** percentiles computed per repeat, median across
  repeats. No outlier trimming. Latency: n=1000, warmup=100, r=5.
  Micro: n=60, warmup=10, r=3. Read-mix: n=400, warmup=40, r=1.
  Tx-focused: n=2000, warmup=200, r=1. Memory: r=3, with each repeat in a
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

Re-measured 2026-07-06 (bridge 1.7.0-pre, PGlite 0.5.3) with the
1.7 defaults: statement caching plus the lean fast-query path, no
opt-in flags. All four rows per machine are from the same session,
prepared-native included.

**Apple M3 Max:**

| Adapter | p50 | p95 | p99 | max | p50 spread |
| ------------------------- | ---------- | ---------- | ---------- | ---------- | ---------- |
| `prisma-pglite-bridge` | 0.33ms | **0.37ms** | **0.54ms** | 1.93ms | 0.33–0.34 |
| `pglite-prisma-adapter` | 0.88ms | 0.96ms | 1.90ms | 2.24ms | 0.87–0.89 |
| `postgres-pg` (default) | 0.40ms | 0.46ms | 1.05ms | 1.70ms | 0.39–0.40 |
| `postgres-pg` (prepared) | **0.32ms** | 0.39ms | 0.99ms | **1.53ms** | 0.32–0.33 |

**Apple i9-9980HK:**

| Adapter | p50 | p95 | p99 | max | p50 spread |
| ------------------------- | ---------- | ---------- | ---------- | ---------- | ---------- |
| `prisma-pglite-bridge` | 0.87ms | **1.07ms** | **1.73ms** | 5.44ms | 0.85–0.88 |
| `pglite-prisma-adapter` | 2.45ms | 3.24ms | 4.95ms | 6.45ms | 2.33–2.58 |
| `postgres-pg` (default) | 1.03ms | 1.29ms | 2.80ms | 5.17ms | 0.99–1.13 |
| `postgres-pg` (prepared) | **0.81ms** | 1.15ms | 2.52ms | **4.39ms** | 0.80–0.83 |

**i9 native-prepared drift (re-checked 2026-07-10):** two
back-to-back runs put `postgres-pg` (prepared) at
0.64–0.66ms p50 (spreads 0.63–0.73), well under the 0.81ms
tabled above, while the bridge (0.75–0.84ms) and the other
adapters reproduced their tabled p50s within spread. Native
latency drifts faster on the i9 — the run-to-run variance
machine — so prepared-native's read lead over the bridge is
wider at that snapshot. Environmental drift in the native
baseline, not a bridge change; the bridge's own read numbers
are unmoved.

**Linux i7-8700:**

| Adapter | p50 | p95 | p99 | max | p50 spread |
| ------------------------- | ---------- | ---------- | ---------- | ---------- | ---------- |
| `prisma-pglite-bridge` | **0.67ms** | **0.77ms** | **1.01ms** | 4.87ms | 0.67–0.69 |
| `pglite-prisma-adapter` | 1.69ms | 3.51ms | 4.10ms | 5.50ms | 1.68–1.73 |
| `postgres-pg` (default) | 0.95ms | 1.06ms | 2.76ms | 4.95ms | 0.94–0.96 |
| `postgres-pg` (prepared) | 0.69ms | 0.81ms | 2.40ms | **4.58ms** | 0.68–0.72 |

Where the bridge **loses**, so you don't have to squint: against
*prepared* native Postgres the read median splits by machine —
prepared-native wins it outright on the i9 (~0.06ms ahead,
non-overlapping p50 spreads), edges it by 0.01ms on the M3 Max, and
trails the bridge by 0.02ms on Linux (the last two within spread
overlap; all three directions reproduced across two same-day runs) —
and prepared-native keeps the tightest max on every machine. The
bridge takes the tail everywhere: p95 and p99 on all three machines
(Linux p99 by 2.4x). Against *default* native Postgres and the direct
adapter, the bridge wins every percentile on every machine (direct
adapter: ~2.4–2.9x). The 1.7 fast path is what closed the worst
case — the bridge's read max dropped from 3.4/7.9/6.8 to
1.9/5.4/4.9ms across the three machines. The prepared-statement
asymmetry still holds: statement caching buys the bridge ~0.1–0.4ms
per query (WASM parse/plan is expensive) but is also worth ~0.1–0.3ms
to native Postgres — and unlike many production setups
(transaction-mode poolers break named statements), the bridge can
always run with it on (the default since 1.7).

### Operation breadth — `micro` (p50, ratio vs bridge)

Re-measured 2026-07-06 (bridge 1.7.0-pre, PGlite 0.5.3) with the 1.7
defaults, across all three machines. This is the mixed picture —
writes, transactions, and reads — that the read-path headline can't
show.

**Apple M3 Max:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| single create | **0.09ms** | 0.21ms (2.2x) | 0.15ms (1.6x) |
| 100 createMany | 6.54ms | 7.68ms (1.2x) | **6.50ms** (1.0x) |
| findMany 100 | 0.40ms | 0.89ms (2.2x) | 0.40ms (1.0x) |
| nested create | **0.42ms** | 1.18ms (2.8x) | 0.58ms (1.4x) |
| deep include | **0.55ms** | 1.28ms (2.3x) | 0.69ms (1.3x) |
| interactive tx | 0.72ms | 1.13ms (1.6x) | **0.57ms** (0.8x) |
| update + find | **0.20ms** | 0.49ms (2.4x) | 0.29ms (1.4x) |

**Apple i9-9980HK:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| single create | **0.39ms** | 0.72ms (1.8x) | 0.48ms (1.2x) |
| 100 createMany | **12.37ms** | 14.64ms (1.2x) | 13.17ms (1.1x) |
| findMany 100 | **0.88ms** | 2.05ms (2.3x) | 1.00ms (1.1x) |
| nested create | **1.38ms** | 3.03ms (2.2x) | 2.08ms (1.5x) |
| deep include | **1.35ms** | 3.12ms (2.3x) | 1.54ms (1.1x) |
| interactive tx | **1.53ms** | 2.66ms (1.7x) | 1.76ms (1.2x) |
| update + find | **0.66ms** | 1.30ms (2.0x) | 1.05ms (1.6x) |

**Linux i7-8700:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| single create | **0.29ms** | 0.54ms (1.9x) | 0.38ms (1.3x) |
| 100 createMany | **12.13ms** | 13.96ms (1.2x) | 13.22ms (1.1x) |
| findMany 100 | **0.83ms** | 1.76ms (2.1x) | 0.94ms (1.1x) |
| nested create | **1.25ms** | 2.86ms (2.3x) | 1.79ms (1.4x) |
| deep include | **1.31ms** | 2.83ms (2.2x) | 1.74ms (1.3x) |
| interactive tx | **1.49ms** | 2.35ms (1.6x) | 1.63ms (1.1x) |
| update + find | **0.62ms** | 1.26ms (2.0x) | 0.86ms (1.4x) |

Against the direct adapter the bridge wins every operation on every
machine (1.2–2.8x). Against native Postgres:

- **Reads and per-row writes** go to the bridge on all three
  machines: `single create`, `nested create`, `update + find`,
  `findMany` (a tie on the M3 Max) — and, since 1.7, `deep include`
  on Intel too (previously native's win there).
- **Bulk inserts** (`100 createMany`) are a near-tie on the M3 Max
  and a bridge win on both Intel machines — the multi-row INSERT is
  engine-bound, not transport-bound.
- **The n=60 `interactive tx` row remains too noisy to call** (native
  leads it on the M3 Max here while the n=2000 `tx-focused` probe
  below shows the bridge ahead 1.5x on the same machine). Read
  transactions from `tx-focused`, not from this row.

Micro runs at n=60 are noisier than the read-path probe — ratios near
1.0x move between runs. The stable signals are the
bridge-vs-direct-adapter margin and the per-row read/write wins.

### Multi-shape reads — `read-mix` (p50, ratio vs bridge)

`findmany-focused` above hammers one SQL shape, which maximally warms
a single prepared-statement cache entry — the bridge's best case
against native Postgres. Real request paths issue many shapes. This
scenario rotates nine distinct read shapes — point lookup, indexed
filter, filtered sort, column projection, one- and three-level
includes, `count`, `groupBy`, and a relation-filtered find — through
one *shared* statement cache every iteration, so no single entry is
specially favored. Measured 2026-07-06 (bridge 1.7.0-pre, n=400,
warmup=40).

**Apple M3 Max:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| point lookup | **0.10ms** | 0.23ms (2.3x) | 0.13ms (1.4x) |
| indexed where | **0.23ms** | 0.56ms (2.4x) | 0.27ms (1.2x) |
| filter + sort | **0.21ms** | 0.45ms (2.1x) | 0.23ms (1.1x) |
| select projection | **0.15ms** | 0.35ms (2.4x) | 0.18ms (1.2x) |
| include workspace | **0.27ms** | 0.64ms (2.4x) | 0.34ms (1.3x) |
| deep include | **0.39ms** | 1.04ms (2.7x) | 0.54ms (1.4x) |
| count | **0.07ms** | 0.20ms (2.8x) | 0.12ms (1.6x) |
| groupBy status | **0.10ms** | 0.23ms (2.2x) | 0.13ms (1.3x) |
| nested filter | **0.25ms** | 0.56ms (2.3x) | 0.30ms (1.2x) |

**Apple i9-9980HK:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| point lookup | **0.35ms** | 0.74ms (2.1x) | 0.46ms (1.3x) |
| indexed where | **0.55ms** | 1.57ms (2.9x) | 0.75ms (1.4x) |
| filter + sort | **0.50ms** | 1.24ms (2.5x) | 0.64ms (1.3x) |
| select projection | **0.39ms** | 1.04ms (2.7x) | 0.54ms (1.4x) |
| include workspace | **0.75ms** | 1.88ms (2.5x) | 1.01ms (1.3x) |
| deep include | **1.14ms** | 3.08ms (2.7x) | 1.56ms (1.4x) |
| count | **0.25ms** | 0.64ms (2.6x) | 0.39ms (1.6x) |
| groupBy status | **0.29ms** | 0.67ms (2.4x) | 0.41ms (1.4x) |
| nested filter | **0.55ms** | 1.48ms (2.7x) | 0.85ms (1.6x) |

**Linux i7-8700:**

| Operation | bridge | direct adapter | native Postgres |
| -------------- | ------ | -------------- | --------------- |
| point lookup | **0.30ms** | 0.55ms (1.9x) | 0.42ms (1.4x) |
| indexed where | **0.49ms** | 1.14ms (2.3x) | 0.70ms (1.4x) |
| filter + sort | **0.44ms** | 0.90ms (2.1x) | 0.62ms (1.4x) |
| select projection | **0.34ms** | 0.76ms (2.2x) | 0.61ms (1.8x) |
| include workspace | **0.66ms** | 1.38ms (2.1x) | 0.95ms (1.4x) |
| deep include | **1.01ms** | 2.30ms (2.3x) | 1.52ms (1.5x) |
| count | **0.21ms** | 0.47ms (2.2x) | 0.36ms (1.7x) |
| groupBy status | **0.25ms** | 0.51ms (2.0x) | 0.35ms (1.4x) |
| nested filter | **0.48ms** | 1.10ms (2.3x) | 0.84ms (1.8x) |

The read advantage is not an artifact of single-shape cache warming:
the bridge leads *every* shape on *every* machine — typically 1.2–1.8x
over native Postgres (down to 1.1x on the fastest M3 Max shapes) and
~1.9–2.9x over the direct adapter — including aggregates (`count`,
`groupBy`) and three-level joins. Prisma emits a bounded set of
parameterized statements, so a diverse read mix stays fully cached and
the bridge's read-path win holds across it, not just in a hot loop.
Where native Postgres stays competitive is bulk writes and unindexed
scans (see `micro` and `tx-focused`), not read diversity.

### Interactive transactions — `tx-focused` (2026-07-06)

The `micro` suite runs `interactive tx` at only n=60, so its p99 is one
unlucky sample and its p50 wanders. This runs the same transaction
(`count` → conditional `create` → `findFirst(orderBy: createdAt desc)`)
at n=2000. That sorted read's cost depends on whether the sorted column
is indexed, so **both cases are reported**: the default hits the
`Batch.createdAt` index; `BENCH_TX_UNINDEXED=1` drops it first and runs
the identical transaction over a sequential scan.

**Indexed (default)** — `tx total`, p50 / p95 / p99 (ms):

| Machine | bridge | direct adapter | native Postgres |
| ------------------- | ------------------ | ------------------ | ------------------ |
| Apple M3 Max | **0.27 / 0.37 / 0.44** | 0.72 / 0.80 / 1.33 | 0.42 / 0.52 / 1.22 |
| Apple i9-9980HK | **1.22 / 1.63 / 2.28** | 2.38 / 2.96 / 4.21 | 1.53 / 1.96 / 3.40 |
| Linux i7-8700 | **0.91 / 1.16 / 1.30** | 1.81 / 2.00 / 3.29 | 1.18 / 1.33 / 1.52 |

**Unindexed (`BENCH_TX_UNINDEXED=1`)** — `tx total`, p50 / p95 / p99 (ms):

| Machine | bridge | direct adapter | native Postgres |
| ------------------- | ------------------ | ------------------ | ------------------ |
| Apple M3 Max | 0.58 / 0.82 / 0.87 | 1.03 / 1.28 / 1.71 | **0.53 / 0.68 / 0.77** |
| Apple i9-9980HK | **1.37 / 2.00 / 2.88** | 2.33 / 3.14 / 3.99 | 1.54 / 2.08 / 2.97 |
| Linux i7-8700 | **1.27 / 1.56 / 1.67** | 2.15 / 2.44 / 3.57 | 1.60 / 2.00 / 2.10 |

The decomposition shows exactly what moves. The bridge **wins the
`begin + commit` machinery on every machine, now by ~2x** — 0.05 vs
0.12ms (M3 Max), 0.25 vs 0.44ms (Intel), 0.18 vs 0.28ms (Linux): the
in-process Duplex turns BEGIN/COMMIT round-trips over faster than
loopback TCP, so there is no "per-round-trip protocol tax." The one
phase that swings is the sorted `findFirst` (p50, bridge / native):

| Machine | indexed | unindexed |
| ------------------- | ------------ | ------------ |
| Apple M3 Max | 0.07 / 0.09 | 0.38 / 0.23 |
| Apple i9-9980HK | 0.32 / 0.33 | 0.65 / 0.51 |
| Linux i7-8700 | 0.24 / 0.29 | 0.61 / 0.64 |

Indexed, `findFirst` is a tie — both engines do a top-1 index lookup —
and the bridge's machinery win carries `tx total` on all three
machines, by 1.3–1.6x. Unindexed, PGlite's WASM executor scans and
sorts slower than native's on both Apple machines; since 1.7 the wider
machinery win absorbs that deficit on the Intel Mac and on Linux
(where the scan phase itself is a wash), leaving the M3 Max — where
native's scan advantage is largest — as the one machine native still
takes.

So the honest reading: **the bridge now wins interactive transactions
on every machine when the sorted column is indexed, and wins two of
three even when it is not** — native's faster sequential scan keeps
the unindexed case only on the M3 Max. An unindexed `ORDER BY` is a
schema smell a production app would fix — and the index helps both
engines — so the indexed case is the realistic one. The WASM scan
deficit is the same engine characteristic that used to cost the bridge
the Intel `deep include` row; the bridge's transaction *machinery* is
never the cost.

**Durability is not the write differentiator either.** A 2026-07-05
check ran the write-heavy `micro` operations against native Postgres
with `BENCH_POSTGRES_SYNC_OFF=1` (fsync / synchronous_commit /
full_page_writes off) and it barely moved them — `100 createMany` p50
went 15.21 → 15.10ms (Intel) and 12.70 → 12.90ms (Linux), with no
improvement on the M3 Max. So neither side's bulk-write numbers hinge
on fsync: the 2026-07-06 tables show `100 createMany` as a
near-tie on both Apple machines and a modest bridge win on Linux —
the multi-row INSERT is engine work, not transport or durability.
The `postgres-pg` write columns are a fair baseline as run.

### Memory and cold start (2026-07-06)

Quiesced post-setup baseline RSS, sampled in-workload peak, and
pre-teardown retained growth during the leak-detect workload (1k
mixed ops); one child process per adapter × repeat. Re-measured
2026-07-06 at the 1.7 defaults (prepared statements + fast query
path): everything reproduced the 2026-07-02 run within the noise
bands described below — the 1.7 changes moved no memory number
beyond ambient RSS-accounting variance.

**Apple M3 Max:**

| Adapter | baseline RSS | peak delta | retained delta | setup time |
| ------------------------- | ------ | ------ | ------ | ------- |
| `prisma-pglite-bridge` | 684MB | +98MB | +97MB | 736ms |
| `pglite-prisma-adapter` | 741MB | +29MB | +15MB | 720ms |
| `postgres-pg` client | **262MB** | +90MB | +40MB | **45ms** |
| `postgres-pg` server tree | 105MB | +6MB | — | — |

**Apple i9-9980HK:**

| Adapter | baseline RSS | peak delta | retained delta | setup time |
| ------------------------- | ------ | ------ | ------ | ------- |
| `prisma-pglite-bridge` | 1603MB | +96MB | +95MB | 2037ms |
| `pglite-prisma-adapter` | 1662MB | +121MB | +120MB | 2096ms |
| `postgres-pg` client | **275MB** | +84MB | +35MB | **111ms** |
| `postgres-pg` server tree | 111MB | +35MB | — | — |

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
noisy**: across repeated runs they swing 2–3x, so read them as
"tens to ~200MB of transient
growth", not as a stable ranking — an earlier revision of this table
claimed an architecture-dependent bridge-vs-adapter divergence that
did not replicate. The noise is OS page accounting, not allocation:
the JS-level peak deltas are deterministic and identical for both
PGlite adapters (`peakDelta.heapUsed` +26MB, `arrayBuffers` +4MB in
every repeat, both machines), while RSS depends
on how much of the setup transient's freed-page pool the OS has
already reclaimed when the workload reuses it (baseline↔peak
anti-correlation r≈−0.8 on Apple Silicon) and on ambient memory
pressure. For adapter comparisons use the heap/arrayBuffers deltas;
baselines, the server tree, and setup times are the other
reproducible signals. On Apple Silicon, RSS
quiescence is best-effort (20s cap); treat single-digit-MB deltas as
within a ~±15MB noise floor. Setup time is the WASM cold-start
honesty item: ~0.7s (M3 Max) to ~2s (Intel) before the first query
for this scenario's seed, vs ≤0.1s for a Postgres connection.

### What this means

For a test suite issuing ~1000 Prisma queries, the bridge saves
roughly one second per run versus the direct PGlite adapter — which
it beats on every operation and every machine — and it buys
zero-infrastructure Postgres at (or past) native-Postgres speed on
the paths a suite spends its time: reads (every shape, every
machine), per-row writes, and — since 1.7 — indexed interactive
transactions on every machine. What native Postgres keeps: a
read-path p50 near-tie when given prepared statements (an outright
win on the i9), the tightest read worst-case, unindexed scans on
Apple Silicon, and bulk-insert parity on the M3 Max. It does not make PGlite a production database,
and none of these numbers describe production Postgres over a real
network — the value is operational (no Docker, no server, instant
snapshot/reset) plus a latency profile that no longer asks you to
trade speed for it.

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

macOS, n=20, post-warmup. Apple M3 Max, Node 24.18.0:

| Strategy       | `scope`           | Per-test p50 |     p99 | One-time (per file) |
| -------------- | ----------------- | -----------: | ------: | ------------------: |
| cold start     | `test` (pre-1.6)  |        634ms |   803ms |                   — |
| snapshot reset | `file` / `worker` |         12ms |    23ms |               0.64s |
| template load  | `test` (1.6+)     |        147ms |   226ms |               0.68s |

Apple i9-9980HK, Node 24.14.1:

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
| `tx-focused`           | One interactive `$transaction` at high n, decomposed into phases        |    recommended      |
| `repeated-large-reads` | Repeated Prisma reads over one 1MB JSON row (`$queryRaw`, `findUnique`) |                     |
| `bytes-sweep`          | Bytea decoder across payload sizes, `Bytes` and `Bytes[]` columns       |                     |
| `text-array-sweep`     | TEXT[] parser across array shapes (tag-like through payload-like)       |                     |

Pick one with `--scenario <name>`, or `--scenario all` for the full set.
`findmany-focused`, `read-mix`, `tx-focused`, `repeated-large-reads`,
`path-split`, `bytes-sweep`, and `text-array-sweep` are explicit-only —
none are included in `all`; target them directly (e.g.
`--scenario findmany-focused`) when hunting read-path, transaction,
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

## ORM benchmark (`benchmark/orm/`)

A separate harness (`pnpm bench:orm`) that skips Prisma entirely: for
each registered ORM it compares the ORM's **native PGlite driver**
(calling the PGlite JS API directly) against the same ORM driving
**`PgBridgePool` over the wire protocol**, on identical fresh PGlite
instances. A correctness gate (identical values from both paths,
committed transaction visible) runs before any timing.

```bash
pnpm bench:orm                            # all ORMs, N=300 warmup=30
pnpm bench:orm --orm drizzle -n 300 -w 30
pnpm bench:orm -r 3                       # whole-run repeats, p50 spread reported
```

The workload is fixed in `orm/run.ts` — single insert, findMany,
select-where, left join, and a read+write transaction — so results are
comparable across ORMs. An ORM module only translates those operations
into its own query-builder API (see `orm/types.ts`); to add one,
implement `OrmDefinition` in a sibling of `orm/drizzle.ts`, register it
in `run.ts`'s `ORMS` map, and add the ORM as a devDependency.

Reference results — Apple i9-9980HK, 2026-07-10, bridge at `f1b66a2`
(per-client statement caching on), PGlite 0.5.4, N=300, `-r 3`: p50 is
the median [min–max spread] of per-repeat p50s, p99 the median of
per-repeat p99s.

**drizzle** (`drizzle-orm` 0.45.2 — native: `drizzle-orm/pglite`):

| Operation | native p50 [spread] | wire p50 [spread] | native p99 | wire p99 |
| ------------- | ------ | ---------- | ------ | ---------- |
| single insert | 0.42ms [0.41–0.43] | **0.18ms** [0.17–0.18] | 0.76ms | 0.35ms |
| findMany | 1.36ms [1.18–1.40] | **0.40ms** [0.37–0.41] | 2.39ms | 0.75ms |
| select where | 0.48ms [0.45–0.49] | **0.19ms** [0.18–0.19] | 1.06ms | 0.32ms |
| join | 1.43ms [1.24–1.47] | **0.47ms** [0.44–0.47] | 2.86ms | 0.81ms |
| tx (r+w) | 1.30ms [1.24–1.35] | **0.51ms** [0.49–0.52] | 2.25ms | 0.77ms |

**knex** (`knex` 3.3.0, wire via its `connectionPool` option — native:
community `knex-pglite` 0.14.0):

| Operation | native p50 [spread] | wire p50 [spread] | native p99 | wire p99 |
| ------------- | ------ | ---------- | ------ | ---------- |
| single insert | 0.35ms [0.34–0.38] | **0.14ms** [0.13–0.14] | 0.78ms | 0.36ms |
| findMany | 1.23ms [1.18–1.26] | **0.31ms** [0.31–0.32] | 3.28ms | 0.89ms |
| select where | 0.40ms [0.38–0.43] | **0.15ms** [0.15–0.16] | 1.04ms | 0.41ms |
| join | 1.28ms [1.24–1.30] | **0.37ms** [0.36–0.38] | 3.43ms | 0.98ms |
| tx (r+w) | 1.31ms [1.26–1.44] | **0.47ms** [0.45–0.50] | 3.24ms | 1.16ms |

**kysely** (`kysely` 0.29.3 — native: the first-party built-in
`PGliteDialect`):

| Operation | native p50 [spread] | wire p50 [spread] | native p99 | wire p99 |
| ------------- | ------ | ---------- | ------ | ---------- |
| single insert | 0.39ms [0.37–0.39] | **0.20ms** [0.20–0.23] | 0.79ms | 0.33ms |
| findMany | 1.23ms [1.21–1.25] | **0.34ms** [0.31–0.38] | 2.50ms | 0.63ms |
| select where | 0.43ms [0.41–0.44] | **0.22ms** [0.22–0.25] | 0.78ms | 0.40ms |
| join | 1.29ms [1.27–1.30] | **0.48ms** [0.45–0.53] | 2.34ms | 0.79ms |
| tx (r+w) | 1.25ms [1.18–1.25] | **0.57ms** [0.57–0.66] | 2.26ms | 0.82ms |

**mikro-orm** (`@mikro-orm/*` 7.1.5 — native: the official
`@mikro-orm/pglite` driver; wire: a kysely `PostgresDialect` wrapping the
bridge pool via `driverOptions`; entity ORM, ops fork the EntityManager
per call):

| Operation | native p50 [spread] | wire p50 [spread] | native p99 | wire p99 |
| ------------- | ------ | ---------- | ------ | ---------- |
| single insert | 0.49ms [0.48–0.56] | **0.27ms** [0.26–0.30] | 0.84ms | 0.50ms |
| findMany | 2.56ms [2.53–2.63] | **1.50ms** [1.49–1.61] | 5.33ms | 3.38ms |
| select where | 0.69ms [0.69–0.84] | **0.44ms** [0.43–0.50] | 1.36ms | 1.30ms |
| join | 4.97ms [4.84–5.27] | **3.50ms** [3.49–3.51] | 10.25ms | 8.90ms |
| tx (r+w) | 1.87ms [1.86–2.19] | **1.10ms** [1.06–1.26] | 3.59ms | 2.44ms |

**typeorm** (`typeorm` 1.0.0 — native: community `typeorm-pglite` 0.3.4,
harness instance injected into its module-level singleton; wire: a
hand-rolled `driver` shim whose `Pool` constructor returns the existing
bridge pool, since TypeORM has no external-pool option):

| Operation | native p50 [spread] | wire p50 [spread] | native p99 | wire p99 |
| ------------- | ------ | ---------- | ------ | ---------- |
| single insert | 0.49ms [0.47–0.52] | **0.27ms** [0.26–0.28] | 0.73ms | 0.45ms |
| findMany | 1.40ms [1.28–1.44] | **0.47ms** [0.47–0.53] | 3.39ms | 1.01ms |
| select where | 0.53ms [0.50–0.56] | **0.30ms** [0.28–0.32] | 1.04ms | 0.58ms |
| join | 2.25ms [2.00–2.35] | **0.87ms** [0.87–1.01] | 4.46ms | 1.75ms |
| tx (r+w) | 1.53ms [1.43–1.64] | **0.73ms** [0.69–0.79] | 2.57ms | 1.46ms |

The wire path wins every operation for all five ORMs despite the extra
protocol layer — even against Kysely's first-party dialect and
MikroORM's official driver. **Why:** every native driver funnels into
PGlite's public `query()` API, which per call takes the WASM mutex and
issues Parse / Describe / Bind / Describe / Execute / Sync as ~6
separate protocol crossings plus JS-side result-message parsing; the
bridge sends the same extended-protocol conversation as one buffered
duplex write on the raw-stream path. Statement-name injection
(parse-skip) is a bonus on top, not the cause: it engages only for
object-form queries (drizzle, knex — kysely and typeorm issue
string-form queries, verified via empty `pg_prepared_statements`, and
still win), and a `statementCaching: false` control run left drizzle's
wire path winning 1.9–3.2× — caching contributes only ~4–27% of the
margin depending on the operation. FastQuery never engages on any wire
path (no caller `types`). The win therefore transfers to any ORM
driving a pg `Pool`, regardless of query form. The margin tracks how
much of an operation is driver time: roughly 2–4× at p50 for the query
builders, 1.8–3.0× for TypeORM and 1.4–1.8× for MikroORM, whose entity
hydration and unit-of-work bookkeeping dilute the driver share. Knex
additionally exercises the bridge's callback-form dispatch (its pg
dialect passes a positional callback).

The tables are `-r 3` whole-run repeats (fresh PGlite instances, pool,
and ORM per repeat) on the i9 — the machine the methodology notes flag
for run-to-run variance; the spread column is the min–max of per-repeat
p50s. An adversarial re-verification (2026-07-10, same machine)
additionally confirmed the ranking survives reversing the native/wire
run order (second-runner JIT advantage ≲5–10%, far below the margins)
and quantified the statement-caching share via a `statementCaching:
false` control run. The p99 columns are medians of per-repeat p99s over
a growing table and remain the noisiest numbers here — no native/wire
p99 inversion has been observed in any run, but read them as
indicative, not as reference values.

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
to the bench run to compare against prepared-statement Postgres, or start the
server with `BENCH_POSTGRES_SYNC_OFF=1` to disable durability
(fsync/synchronous_commit/full_page_writes) for a write comparison against a
bridge that has none.

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

Full aggregated results plus every raw run. Suitable for diffing
between branches or archiving out of tree. Top-level array of adapter×scenario
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
