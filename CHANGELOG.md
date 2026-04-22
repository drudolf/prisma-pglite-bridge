# prisma-pglite-bridge

## 0.5.1

### Patch Changes

- [`fc1eb84`](https://github.com/drudolf/prisma-pglite-bridge/commit/fc1eb840c4a4c643e58c904937ff1135951b84c5) Thanks [@drudolf](https://github.com/drudolf)! - Fix false-positive `PgliteAdapterLeakWarning` when consumers
  destructure the return value of `createPgliteAdapter()` and keep only
  `adapter` (e.g. via `new PrismaClient({ adapter })`). The
  `FinalizationRegistry` now tracks the Prisma adapter instance itself
  rather than the wrapper object returned by `createPgliteAdapter()`, so
  the warning fires only when the adapter — and therefore the pool — is
  genuinely unreachable.

## 0.5.0

### Minor Changes

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Emit a `PgliteAdapterLeakWarning` process warning when a
  `PgliteAdapter` is garbage-collected without `close()` being called.
  A `FinalizationRegistry` tracks each adapter returned by
  `createPgliteAdapter` and unregisters it in `close()`; adapters that
  go unreachable with the registry still active surface a visible
  warning instead of silently leaking the pool and its background
  intervals. The check adds no hot-path overhead — it runs only when
  the adapter reference is collected.

- [`62cf845`](https://github.com/drudolf/prisma-pglite-bridge/commit/62cf845171d25253ef2aab8724118378e388ad49) Thanks [@drudolf](https://github.com/drudolf)! - **Breaking:** `createPgliteAdapter` and `createPool` now require a
  caller-supplied `pglite: PGlite` option. The adapter no longer
  constructs or owns the PGlite instance — callers create it with
  `new PGlite(...)` and pass it in, so the full PGlite option
  surface (dataDir, extensions, debug, loadDataDir, etc.) becomes
  available without the bridge having to re-expose every knob.

  Removed options: `dataDir`, `extensions`. The `max` option stays.

  Removed return fields: `pglite` (caller already owns it),
  `wasmInitMs` (caller owns PGlite construction timing). The
  `wasmInitMs` stats field is also removed from `Stats`.

  `close()` now shuts down the pool only — the PGlite instance is
  not closed, since the caller owns its lifecycle.

  Schema application is now explicit: `createPgliteAdapter` applies
  migration SQL only when `sql`, `migrationsPath`, or `configRoot`
  is provided. With no migration config, the PGlite instance is
  assumed to already hold the schema — this is the intended path
  for reopening a persistent `dataDir`. Previously the bridge
  auto-detected initialization via a `PG_VERSION` file check; that
  detection is no longer needed since the caller controls when
  migrations run.

  Migration example:

  ```diff
  - const { adapter } = await createPgliteAdapter({
  -   dataDir: './data',
  -   extensions: { uuid_ossp },
  - });
  + import { PGlite } from '@electric-sql/pglite';
  + const pglite = new PGlite('./data', { extensions: { uuid_ossp } });
  + const { adapter } = await createPgliteAdapter({
  +   pglite,
  +   migrationsPath: './prisma/migrations',
  + });
  ```

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Replace the sampled 500ms RSS interval with a kernel-tracked
  `process.resourceUsage().maxRSS` read at snapshot and freeze time.
  `processRssPeakBytes` now reports the true high-water mark rather
  than a lower-bound estimate, and `'full'`-level adapters no longer
  spin up a per-adapter interval timer. The `AdapterStats.stop()`
  method is removed — there is no longer any timer to clear.

  The field continues to reflect the whole Node process, not just
  one adapter; see the `Stats` JSDoc for how to interpret it.

- [`2aa36c2`](https://github.com/drudolf/prisma-pglite-bridge/commit/2aa36c2c956e2846d7f7fcbe75b136c7c15f6b6e) Thanks [@drudolf](https://github.com/drudolf)! - Add opt-in stats collection
  (`statsLevel: 'off' | 'basic' | 'full'`, default `'off'`).
  Retrieve via `await adapter.stats()` — returns `undefined` at
  `'off'`.

  - `'basic'` captures timing (`durationMs`, `schemaSetupMs`),
    counters (`queryCount`, `failedQueryCount`, `resetDbCalls`),
    `dbSizeBytes`, and a sliding-window query percentile set
    (`recentP50QueryMs`, `recentP95QueryMs`, `recentMaxQueryMs`) over
    the most recent ~10,000 queries.
    Lifetime totals (`queryCount`, `totalQueryMs`, `avgQueryMs`) are
    not windowed.
  - `'full'` adds `processRssPeakBytes` (process-wide, kernel-tracked
    via `process.resourceUsage().maxRSS`) and session-lock wait
    statistics.
  - `Stats` is a discriminated union (`StatsBasic | StatsFull`) keyed
    on `statsLevel`. Narrow via `if (s.statsLevel === 'full')` to
    read `'full'`-only fields.
  - Invalid `statsLevel` values throw at `createPgliteAdapter()` time.
  - Collection is wired through `node:diagnostics_channel`: the
    bridge publishes to `QUERY_CHANNEL`
    (`prisma-pglite-bridge:query`) and `LOCK_WAIT_CHANNEL`
    (`prisma-pglite-bridge:lock-wait`), and the built-in collector
    subscribes when `statsLevel` is not `'off'`. Both channel names
    and the `QueryEvent` / `LockWaitEvent` payload types are exported
    for external consumers (OpenTelemetry, APM, custom loggers).
  - `createPgliteAdapter()` and `createPool()` now return
    `adapterId: symbol` — filter published events by this id when
    multiple adapters share a process.
  - `'off'` has no internal collection and no `ErrorResponse`
    buffering. The hot path stays effectively zero-cost **unless
    an external consumer subscribes** to the public diagnostics
    channels — subscribing opts in to the timing and payload cost,
    gated by `channel.hasSubscribers`.
  - `close()` is re-entrant; `freeze()` seals the snapshot in a
    `finally` block so a `pg_database_size` rejection cannot leave
    subsequent `stats()` calls querying a closing PGlite.

- [`a134dbc`](https://github.com/drudolf/prisma-pglite-bridge/commit/a134dbcd65e89c45e9f11bb60c516a86536f0471) Thanks [@drudolf](https://github.com/drudolf)! - Add `syncToFs` option to `createPool` / `createPgliteAdapter`, defaulting to
  `'auto'`. For clearly in-memory PGlite instances (`new PGlite()` or a
  `memory://…` dataDir) the bridge now passes `syncToFs: false` on each
  wire-protocol call, avoiding per-query filesystem sync work that has no
  durability value on volatile storage. Persistent `dataDir` usage keeps the
  existing `syncToFs: true` behaviour. Pass an explicit `true` or `false` to
  override — required if you supply a custom persistent `fs` without a
  meaningful `dataDir`.

### Patch Changes

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Tighten `check:exports` by switching the `arethetypeswrong` profile
  from `node16` to `strict`. `strict` is a superset — it keeps all the
  `node16`/`nodenext` resolution checks and additionally flags
  unexpected module syntax (ESM entrypoint emitting CJS, or the
  reverse). Our dual CJS/ESM output from `tsdown` already passes it
  cleanly, so this only guards against future drift.

- [`f8ecc59`](https://github.com/drudolf/prisma-pglite-bridge/commit/f8ecc592f1cf300a6041b4398fd2aa6dc5489eb4) Thanks [@drudolf](https://github.com/drudolf)! - Stop the bridge drain loop when the input buffer holds an incomplete
  frame. The loop now compares input length before and after each
  iteration and breaks when nothing was consumed, instead of spinning
  until more data arrives via `_write`.

- [`81303e4`](https://github.com/drudolf/prisma-pglite-bridge/commit/81303e42cbdb6dbc5ad2b7573a6568335d615414) Thanks [@drudolf](https://github.com/drudolf)! - Perf: BackendMessageFramer now emits whole in-chunk messages as a single
  zero-copy slice instead of separate prefix + payload pushes. Restores
  v0.4.1-level throughput on read-heavy paths (e.g. findMany of 100+ rows)
  without giving up the streaming path for payloads that span multiple
  PGlite chunks.

- [`f8ecc59`](https://github.com/drudolf/prisma-pglite-bridge/commit/f8ecc592f1cf300a6041b4398fd2aa6dc5489eb4) Thanks [@drudolf](https://github.com/drudolf)! - Stream backend protocol framing instead of buffering full responses.
  A new `BackendMessageFramer` parses PGlite's wire-protocol output
  chunk-by-chunk and pushes payload bytes downstream as they arrive,
  suppressing intermediate `ReadyForQuery` frames inline. Previously
  the bridge concatenated every chunk for a query and post-processed
  the whole buffer, which scaled with response size. Large multi-row
  reads (e.g. `findMany`) now hold only the active frame in memory.

- [`f8ecc59`](https://github.com/drudolf/prisma-pglite-bridge/commit/f8ecc592f1cf300a6041b4398fd2aa6dc5489eb4) Thanks [@drudolf](https://github.com/drudolf)! - Reduce bridge backend chunk copies. When PGlite hands the framer a
  standalone `Uint8Array` — `byteOffset === 0` and
  `byteLength === buffer.byteLength`, so the chunk owns its full
  `ArrayBuffer` — the emitted payload slice is now a zero-copy
  `Buffer` view over that same backing store. Chunks that are views
  into a larger buffer, or backed by a `SharedArrayBuffer`, still get
  copied, so we never pin unrelated trailing bytes and never expose
  shared memory the WASM runtime may still mutate.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Fix `FrontendMessageBuffer.consume` fast-path condition. The guard
  `headRemaining >= length && length === headRemaining` reduced to
  `length === headRemaining`, so the zero-copy subarray path only
  fired on exact-match consumes. Partial consumes from a larger head
  chunk now also return a zero-copy view, removing an unnecessary
  allocation on the Prisma hot path when multiple backend messages
  arrive in a single chunk.

- [`a29a505`](https://github.com/drudolf/prisma-pglite-bridge/commit/a29a505a8d763a604bab284ab33bd8c39d6887f2) Thanks [@drudolf](https://github.com/drudolf)! - Default `max` for `createPool` / `createPgliteAdapter` is now `1` (was `5`).
  PGlite runs queries serially inside its WASM runtime, so extra pool
  connections added memory overhead without adding throughput. Benchmarks
  show 80–99% lower RSS growth across scenarios and equal-or-better
  wall-clock times. Users who previously set `max` explicitly are
  unaffected — and if you had bumped `max` hoping for parallelism,
  you can now drop the override and reclaim that memory. The only
  reason to raise `max` above 1 is to deliberately exercise
  pool wait-queue behaviour (e.g. session-lock contention tests).

- [`2e563ee`](https://github.com/drudolf/prisma-pglite-bridge/commit/2e563ee9773c0a0717d99907945554cc82d5b1f5) Thanks [@drudolf](https://github.com/drudolf)! - Drop redundant `as` type casts in the bridge's diagnostics publish
  paths and in the session-lock integration test. No runtime behavior
  change.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Export the `StatsBasic` and `StatsFull` variant types alongside the
  existing discriminated-union `Stats`. Consumers writing helpers that
  accept a specific level (`(s: StatsFull) => ...`) no longer have to
  widen through `Stats` or re-declare the interfaces locally.

- [`44ebdff`](https://github.com/drudolf/prisma-pglite-bridge/commit/44ebdff47ac12d83bfdf095f2e80b33b1842175a) Thanks [@drudolf](https://github.com/drudolf)! - Perf: `BackendMessageFramer` now coalesces contiguous complete backend
  messages that arrive in the same PGlite chunk and forwards them as a
  single downstream slice. This reduces per-message `push()`/`onMessage`
  churn on read-heavy queries without changing wire bytes or the
  cross-chunk streaming path.

- [`23e2773`](https://github.com/drudolf/prisma-pglite-bridge/commit/23e2773fab2ed45b1d8d706f83f31e163a35df0e) Thanks [@drudolf](https://github.com/drudolf)! - Fix: BackendMessageFramer fast path now requires `messageLength === 5`
  before treating a 0x5a-typed frame as ReadyForQuery, mirroring the slow
  path's guard. A non-conforming 0x5a frame (length ≠ 5) previously
  triggered spurious RFQ emission and dropped its payload; it is now
  forwarded verbatim.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Reject backend message length headers greater than 1 GiB in
  `BackendMessageFramer`. A corrupted or hostile byte stream claiming a
  4 GiB message would otherwise drive the framer to attempt the
  corresponding allocation; the cap throws fast with a descriptive
  error instead. PGlite's actual messages are far below this bound —
  valid traffic is unaffected.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Guard the `BackendMessageFramer` zero-copy path against
  `SharedArrayBuffer`-backed chunks. When PGlite hands the framer a
  `Uint8Array` whose backing store is a `SharedArrayBuffer`, the emitted
  slice is now a copy rather than a live view. Prevents the WASM runtime
  from mutating bytes that `pg` is still consuming. Current PGlite 0.4.x
  does not use shared memory, so behaviour is unchanged today; the guard
  is defensive against future PGlite builds that might use
  `WebAssembly.Memory({ shared: true })`.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Time out the `pg_database_size` query issued from `AdapterStats.freeze`
  and `AdapterStats.snapshot` after 5 seconds. A hung PGlite query
  previously left `freeze()` awaiting forever, which meant the RSS
  sampling interval was never cleared and the adapter's `close()` never
  resolved. The timeout rejects internally and is caught by the existing
  handler, so `dbSizeBytes` simply becomes `undefined` — the rest of
  `stats()` remains intact and `close()` always settles.

- [`06b8e13`](https://github.com/drudolf/prisma-pglite-bridge/commit/06b8e13c195f490291471faf571df1520e3dfcbe) Thanks [@drudolf](https://github.com/drudolf)! - Avoid O(n) Array.shift() in FrontendMessageBuffer.

  Replace repeated `chunks.shift()` calls with a `headIndex` cursor
  plus periodic compaction. Drained chunks are sliced off once they
  exceed a threshold, keeping the backing array bounded without
  re-indexing on every consume. `readInt32BE` also gains a fast
  path for the common case where all four bytes sit in the head
  chunk.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Guard `process.resourceUsage()` when reading `processRssPeakBytes`
  under `statsLevel: 'full'`. On runtimes that expose a `process`
  global without `resourceUsage` (Bun, Deno, edge workers) the field
  now returns `undefined` instead of throwing and taking the whole
  `stats()` call down with it. `StatsFull.processRssPeakBytes` is now
  typed as `number | undefined`, matching the field-level-undefined
  contract documented on the other `Stats` members. Consumers already
  reading this field on Node 20+ see no change — `resourceUsage()` is
  present there and the value is a real number.

- [`3bd43c9`](https://github.com/drudolf/prisma-pglite-bridge/commit/3bd43c964e7c209533c6c0789742c17dd5618581) Thanks [@drudolf](https://github.com/drudolf)! - Declare `@prisma/config` as an optional peer dependency. It is only
  needed when migration discovery reads from `prisma.config.ts`.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Run the full test suite before `npm publish` / `pnpm publish`. The
  `prepublishOnly` gate now runs `pnpm test && pnpm build && pnpm check:exports`,
  so a tarball can never be published from a red working copy even
  if a maintainer skipped the CI check.

- [`5d22c91`](https://github.com/drudolf/prisma-pglite-bridge/commit/5d22c9159006ab34eff28b242d4ec60bc284c727) Thanks [@drudolf](https://github.com/drudolf)! - Replace sentinel-table detection of already-initialized persistent
  `dataDir` databases with a filesystem check for PGlite's `PG_VERSION`
  marker. Removes the reserved `_pglite_bridge` schema, the collision
  error path, and ~100 lines of transactional sentinel logic. Behavior
  for ephemeral (in-memory) adapters is unchanged. For persistent
  `dataDir` adapters, a partially-applied migration now requires
  deleting the dataDir to recover rather than auto-recovering on the
  next open.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Embed the PGlite `dataDir` (when present) in the schema-apply error
  thrown by `createPgliteAdapter`. Persistent instances now surface as
  `PGlite(dataDir=/path/to/db)` in the message, so failures from
  multi-instance test runs point at the right database instead of the
  generic "PGlite" string.

- [`0242e9a`](https://github.com/drudolf/prisma-pglite-bridge/commit/0242e9a54a656dd066efd670ace0cf60398d7d22) Thanks [@drudolf](https://github.com/drudolf)! - Fix session-lock poisoning when a bridge is destroyed while waiting.

  `PGliteBridge._destroy` now calls `SessionLock.cancel()` instead of
  `release()`. Previously, a bridge torn down while queued in
  `waitQueue` stayed queued and was later granted ownership by
  `drainWaitQueue`, starving every subsequent waiter. `cancel()` also
  rejects the pending `acquire()` promise so the destroy error
  propagates to queued write callbacks.

- [`c94a637`](https://github.com/drudolf/prisma-pglite-bridge/commit/c94a6377b438b08e7fe0057e70d78d49c1ffd1b8) Thanks [@drudolf](https://github.com/drudolf)! - Tighten `SessionLock` and drop dead helpers.

  - `SessionLock.updateStatus` and `release` now return a `boolean`
    indicating whether ownership transitioned on that call.
  - Remove unused `createBridgeId` factory; call sites use
    `Symbol('bridge')` directly.
  - Remove unused `extractRfqStatus` helper — status is tracked via
    the `BackendMessageFramer.onReadyForQuery` callback.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Route every identifier interpolated into snapshot/reset SQL through
  `quote_ident` (SQL side for round-tripped values, a matching JS
  helper for internal constants) instead of hand-wrapping them with
  double quotes. User-table identifiers were already safely quoted;
  this tightens the remaining internal call sites — `_pglite_snapshot`,
  `_snap_N`, and the `snap_name` column round-trip — so the snapshot
  manager's SQL construction is uniform and defense-in-depth clean.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Document the source-of-trust requirement for schema SQL. Both
  `sql` and `migrationsPath` execute verbatim with no checksum or
  signature verification, so anyone who can influence either string
  controls the schema. The README now states this explicitly in
  Schema Resolution and repeats a short warning before the
  "Pre-generated SQL (fastest)" example.

- [`79623d8`](https://github.com/drudolf/prisma-pglite-bridge/commit/79623d8aaab1891a4a0eeb88a39164985fd4b8ae) Thanks [@drudolf](https://github.com/drudolf)! - Fix README drift in the `'full'` stats section. The
  `processRssPeakBytes` bullet still described the old 500ms-interval
  sampler; the surrounding prose claimed "all 'full'-only fields are
  guaranteed defined", contradicting the `number | undefined` type
  signature on runtimes without `process.resourceUsage`. Both are now
  corrected: RSS reads from `process.resourceUsage().maxRSS` at
  `stats()` time, and the exhaustive list of `undefined`-capable
  fields is stated explicitly.

- [`3c250f9`](https://github.com/drudolf/prisma-pglite-bridge/commit/3c250f934f80cec6aa376c0e15f9e71ce495653d) Thanks [@drudolf](https://github.com/drudolf)! - Use `undefined` instead of `null` for absent values across bridge,
  adapter, pool, and stats-collector internals. Node stream contracts
  (`Error | null` callbacks, `push(null)` EOS) are unchanged.

## 0.4.1

### Patch Changes

- [`38116f9`](https://github.com/drudolf/prisma-pglite-bridge/commit/38116f93ab77b47fb192d50c971c2e476845b6ce) Thanks [@drudolf](https://github.com/drudolf)! - Fix `SessionLock` wait queue to drain one bridge at a time instead of all at once. Prevents a race where multiple waiters bypass the lock simultaneously after a transaction completes.

- [`38116f9`](https://github.com/drudolf/prisma-pglite-bridge/commit/38116f93ab77b47fb192d50c971c2e476845b6ce) Thanks [@drudolf](https://github.com/drudolf)! - Harden transaction safety in `writeSentinel` and migration application with proper ROLLBACK on failure. Fix snapshot identifier quoting — store raw schema/table names and apply `quote_ident` only on retrieval, preventing double-quoting. Move sequence restore inside the `session_replication_role` try block.

## 0.4.0

### Minor Changes

- [`1006069`](https://github.com/drudolf/prisma-pglite-bridge/commit/10060690546e5b6b8b808f1819717ae384a84cb3) Thanks [@drudolf](https://github.com/drudolf)! - Replace catalog-guessing `isInitialized` with sentinel-based detection for persistent `dataDir` reopens. Uses a `_pglite_bridge.__initialized` marker table with transactional writes, pre-commit verification, and a legacy fallback for pre-sentinel databases. Fixes sequence-only and function-only schemas not being detected on reopen.

## 0.3.2

### Patch Changes

- [`c4c5a3e`](https://github.com/drudolf/prisma-pglite-bridge/commit/c4c5a3e869394d987f86cfda07d9f09966399fed) Thanks [@drudolf](https://github.com/drudolf)! - Export `SessionLock` from the public API for advanced multi-bridge use cases.

## 0.3.1

### Patch Changes

- [`6422d64`](https://github.com/drudolf/prisma-pglite-bridge/commit/6422d64b368d9807a5a6ecce9d7ddb1aa4142e7a) Thanks [@drudolf](https://github.com/drudolf)! - # Migrate build toolchain to tsdown and TypeScript 6

  Switch from tsup (esbuild) to tsdown (Rolldown) for bundling, and
  upgrade TypeScript from 5.9 to 6.0. Also updates Biome from 1.9 to
  2.4 and @types/node from 22 to 25.

## 0.3.0

### Minor Changes

- [`53e5465`](https://github.com/drudolf/prisma-pglite-bridge/commit/53e54654ec77bfb2d7aaaa2a649cef7487533fa0) Thanks [@drudolf](https://github.com/drudolf)! - # Add snapshotDb/resetSnapshot for fast test isolation

  `snapshotDb()` captures the current database state into a shadow schema.
  Subsequent `resetDb()` calls restore from the snapshot instead of
  truncating to empty, avoiding expensive re-seeding through the Prisma
  wire protocol.

  Also fixes sequence save/restore: `quote_ident` was producing bare
  identifiers that PostgreSQL interpreted as column references; switched
  to `quote_literal` and added a `last_value IS NOT NULL` filter for
  never-called sequences.

## 0.2.0

### Minor Changes

- [`8a42dc8`](https://github.com/drudolf/prisma-pglite-bridge/commit/8a42dc80d47bae61ff28f143ce7e8ccd5013c3b6) Thanks [@drudolf](https://github.com/drudolf)! - # Initial release

  In-process PGlite bridge for Prisma — replaces the TCP socket
  in `pg.Client` with a Duplex stream that speaks PostgreSQL wire
  protocol directly to PGlite's WASM engine. Zero Docker, zero
  database server.

  - `createPgliteAdapter()` — Prisma adapter with auto-discovered
    migrations, explicit path, or raw SQL
  - `createPool()` — lower-level `pg.Pool` backed by PGlite
  - `PGliteBridge` — Duplex stream for custom `pg.Client` setups
  - `resetDb()` — truncates user tables and resets session state
    for per-test isolation
  - Connection pooling with `SessionLock` to serialize transactions
  - Supports PGlite extensions and persistent `dataDir`
