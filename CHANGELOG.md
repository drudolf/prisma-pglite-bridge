# prisma-pglite-bridge

## 1.7.0

### Minor Changes

- [`a9071cb`](https://github.com/drudolf/prisma-pglite-bridge/commit/a9071cb472bc5c5d67c1da286b58035a9a6550d9) Thanks [@drudolf](https://github.com/drudolf)! - COPY support over the wire protocol: `COPY ... TO STDOUT` and `COPY ... FROM STDIN` now work through the pool (e.g. via `pg-copy-streams`). Previously any protocol-level copy-in was fatal — PGlite's WASM backend treats an exhausted input buffer mid-COPY as connection EOF and exits — so the duplex now captures the copy-in conversation: it answers the copy query with a synthetic `CopyInResponse`, buffers the client's `CopyData` stream (default cap 256 MiB, override via `PGliteDuplexOptions.copyAggregateCapBytes`), and executes the whole exchange as one atomic PGlite call on `CopyDone`/`CopyFail`.

  Scope and shape notes: server-side COPY errors (missing table, malformed rows) surface after the client finishes sending, since the query executes with the assembled payload; peak transient memory is ~2× the payload; a cap breach degrades to a catchable in-band error, never a teardown. Multi-statement simple queries containing `COPY ... FROM STDIN` are rejected with a synthesized error rather than forwarded (fail closed), and extended-protocol COPY is not supported — `pg-copy-streams` and psql-style clients drive COPY over the simple protocol, which is the supported path.

- [`c11d823`](https://github.com/drudolf/prisma-pglite-bridge/commit/c11d82307e4bbe0db200484aa1c661ad8b3df348) Thanks [@drudolf](https://github.com/drudolf)! - New fast path for adapter-pg-shaped queries: named statements executed with
  `rowMode: 'array'` and a caller-supplied `types` object now run through a
  lean pg Submittable that caches result-field metadata per statement and
  skips the Describe round-trip on repeat executions, instead of pg's stock
  Query/Result machinery. In the reference probe (two interleaved passes of
  n=1500, warmup 150, values pass-1/pass-2) point lookups dropped from
  108/98µs to 66/74µs (~30-35%) and the 100-row read's worst case tightened
  from ~9-11ms to ~1.3ms at the pool layer; p50 on 100-row reads improved
  ~7-9%. Result values are identical (verified by a dual-bridge parity suite
  covering DML, arrays, JSON, Decimal, NULL parameters, errors, and
  transactions); type conversion still runs through the caller's
  `types.getTypeParser` on every execution.

  Observable difference: fast-path results resolve to a plain
  `{ rows, fields, rowCount, command, oid }` object rather than a `pg.Result`
  instance. Every other query shape — unnamed statements, object row mode,
  Submittables, COPY, row-limited queries — uses the stock pg path unchanged.
  Opt out with the new `PgBridgePoolOptions.fastQueryPath: false`.

  Robustness details: `getTypeParser` is bound to its receiver, so
  `this`-dependent `types` objects (pg's own `TypeOverrides` class) work as
  query-level types; and a synchronous serialization failure during Bind (a
  circular value, a throwing `toPostgres`) rejects the query and leaves the
  client fully usable — the parsed statement stays cached, so a retry with
  valid values skips the re-Parse. Non-`Error` throws are wrapped in an
  `Error`.

- [`48d5ccc`](https://github.com/drudolf/prisma-pglite-bridge/commit/48d5ccc1d1408e0bb898e79db7e19cd4080b8d0e) Thanks [@drudolf](https://github.com/drudolf)! - Support multiple concurrent `PgBridgePool`s (and `PGliteBridge`s) on one PGlite instance. Connect-time session cleanup now runs only for the first live client counted across all pools, so neither a new pool nor a lazily created second client at `max > 1` deallocates a sibling's cached prepared statements (Postgres error 26000). Statement names are unique per pool client, so pools never contend for names (42P05) and named-statement caching stays fully active while pools overlap — no suspension, no handover resync; a surviving pool's cache stays warm through sibling churn. `PGliteBridgeSharedInstanceWarning` is now an advisory (serialization, transaction interleaving) instead of declaring the setup unsupported. Transactions from different pools can still interleave; coordinate explicitly if cross-pool isolation matters.

- [`acdfb09`](https://github.com/drudolf/prisma-pglite-bridge/commit/acdfb0961778ba5cfbc30385df8cbf0e754b244a) Thanks [@drudolf](https://github.com/drudolf)! - New `prisma-pglite-bridge/pool` entry: the Prisma-free subset of the root
  export — `PgBridgePool`, `PGliteDuplex`, `SessionLock`, `PgBridgeError`,
  and the diagnostics channels — through a module graph that never imports
  `@prisma/*` (enforced in CI by a dist purity gate and a no-Prisma install
  smoke test). Non-Prisma ORMs (drizzle, kysely, knex, typeorm, mikro-orm)
  wire their standard Postgres dialects to the pool and run on PGlite
  2.2–3.9× faster than the native PGlite drivers; recipes in the cookbook's
  "Other ORMs" section. Note: "Prisma-free" is import-graph-only — the
  package's Prisma dependencies still install (~5.6 MB) until 2.0.

- [`48d5ccc`](https://github.com/drudolf/prisma-pglite-bridge/commit/48d5ccc1d1408e0bb898e79db7e19cd4080b8d0e) Thanks [@drudolf](https://github.com/drudolf)! - Prepared-statement caching, on by default.

  Each pool client injects a stable, client-unique `ppb_<namespace>_<n>` name into each unnamed DML query — SELECT, INSERT, UPDATE, DELETE, WITH, MERGE, VALUES — so PGlite parses and plans each query shape once per client and skips the Parse round-trip on repeat executions (~7% lower read p50, ~18% lower p99 in the reference benchmark). Non-DML statements (DDL, SET, transaction control) run unnamed and never consume cache slots; the cache names the first 500 distinct texts per client (bounded and frozen, not LRU), and shapes beyond that run unnamed — correct, just uncached.

  This covers every extended-protocol query path through the pool, since the injection happens at the client layer: Prisma adapter traffic, object-form queries (`pool.query({ text, values })` — e.g. Drizzle), and string-form parameterized queries (`pool.query(text, values)` with a non-empty values array — e.g. Kysely and TypeORM; measured ~20% lower p50 on parse-heavy single-statement ops for that traffic). Parameterless string queries (`pool.query('SELECT 1')`) and empty-values calls stay on the simple protocol, unnamed. ORMs that emit many distinct texts (e.g. variable-arity `IN ($1, $2, …)` lists) consume cache slots faster — texts beyond the cap simply run unnamed — and ORMs that inline parameters into the SQL text (no bind values, e.g. MikroORM v7) send no repeat shapes and are unaffected.

  Statement names draw from a process-wide namespace counter, so no two clients — across pools, across client generations — ever prepare the same name into the shared PGlite session: name collisions (Postgres error 42P05) are impossible by construction, and caching is safe at any `max` and with any number of pools. User-supplied statement names (`query({ name: ... })`) bypass injection and remain single-client-only on the shared session.

  Also adds DEALLOCATE / DISCARD ALL interception: after a `DEALLOCATE ALL`, `DEALLOCATE <name>`, or `DISCARD ALL` query issued through any pool client resolves, the affected entries are evicted from **every** live client's plan cache on that PGlite instance (pg's internal `parsedStatements` guard and the fast-path fields cache), so the next execution for the same SQL re-sends Parse and gets a fresh plan instead of failing with Postgres error 26000. Deallocation targets follow PostgreSQL identifier rules — unquoted names fold to lowercase, quoted names match exactly.

  Supporting changes:

  - Opt out with `PgBridgePoolOptions.statementCaching: false` or `PGliteBridgeOptions.preparedStatements: false`. Disable it if you issue DDL mid-session that changes the result type of an already-cached query shape (fails with "cached plan must not change result type"; applying schema before Prisma traffic, as the setup helpers do, is safe). See docs/troubleshooting.md.
  - Pool clients are no longer evicted after 10s idle: `PgBridgePool` now defaults `idleTimeoutMillis` to `0` (never evict), so the statement cache survives idle gaps. An in-process client holds no socket or server resources. Configurable via the new `PgBridgePoolOptions.idleTimeoutMillis`.

- [`acdfb09`](https://github.com/drudolf/prisma-pglite-bridge/commit/acdfb0961778ba5cfbc30385df8cbf0e754b244a) Thanks [@drudolf](https://github.com/drudolf)! - Driver-agnostic testing helpers at `prisma-pglite-bridge/pool/vitest` and
  `prisma-pglite-bridge/pool/jest`: `setupPGlitePool` (one call — pool,
  schema `setup` callback, async-capable `client` factory, `seed`,
  snapshot, hooks) and `createPoolTest` (vitest fixtures `{ pool, client }`
  with the same `test`/`file`/`worker` scopes as `createBridgeTest`,
  including template-dump isolation for `test.concurrent`). Any ORM's
  migrator or raw DDL is the schema source; `dispose` runs the ORM's own
  teardown before the pool closes; `resetDb`/`snapshotDb` share the
  bridge's snapshot machinery and idle-pool gate (`POOL_NOT_IDLE`).

- [`3a566ee`](https://github.com/drudolf/prisma-pglite-bridge/commit/3a566ee089bc9e3ee96c306650e5b54a14d001f5) Thanks [@drudolf](https://github.com/drudolf)! - Require Node.js >= 22. The fast-query deferred is now built with the
  standard `Promise.withResolvers()` (Node 22+, `lib` ES2024) instead of a
  hand-rolled `new Promise` executor, dropping two definite-assignment
  assertions. Node 20 reached end-of-life in April 2026 and is no longer
  supported.

- [`294c395`](https://github.com/drudolf/prisma-pglite-bridge/commit/294c3952cb15e6f31decb1a4fb86a7c7c482e7fc) Thanks [@drudolf](https://github.com/drudolf)! - Fix a transaction-admission race in the shared-session lock (`max > 1` pools). Session ownership was previously granted only when a `ReadyForQuery` response was processed, so two clients could both be admitted against an unset owner: a sibling's query could execute inside another client's open transaction, the sibling's own `ReadyForQuery(T)` then stole session ownership, and — probe-verified — a successfully resolved `INSERT` could be silently destroyed by the transaction owner's rollback while the owner's own `ROLLBACK` blocked indefinitely. Ownership is now taken at admission: `SessionLock.acquire` claims the session before an operation's first byte reaches PGlite (FIFO queue otherwise), response processing never grants ownership, and the owner releases at its idle `ReadyForQuery`. Portal-suspension windows are covered by an explicit duplex-level suspension flag; `SessionLock.hold()` is no longer called by the bridge and is deprecated (kept as a behavior-identical shim for custom multi-duplex setups; removal in the next major). Released as a minor because the exported `SessionLock`'s ownership semantics and the lock-wait telemetry semantics change observably. Semantic note for telemetry consumers: `lockWaitMs` (and the `Stats` session-lock fields) now include time queued behind a sibling's in-flight operation, not only behind open transactions — expect nonzero lock waits under plain concurrent load. Performance note: admission gating adds roughly +30 µs per contended admission on the reference machine — about +9.5% p50 / +13% p99 on an adversarial microbenchmark (`pnpm bench:lock`: `max: 8`, eight concurrent ~0.3 ms point-lookups), around +2–3% at ~2 ms operations, and expected negligible at typical ORM operation sizes (additive-cost model; not directly measured at ORM workload sizes). `max: 1` pools (the default) are entirely unaffected: the pool constructs a `SessionLock` only when `max > 1`, and without one the duplex's acquire is a no-op.

- [`19b639c`](https://github.com/drudolf/prisma-pglite-bridge/commit/19b639c3927328e8c4adda461f249cbff993bcab) Thanks [@drudolf](https://github.com/drudolf)! - User-actionable failures now throw the new `PgBridgeError` (exported with
  the `PgBridgeErrorCode` union) carrying a machine-readable `code` —
  `UNSUPPORTED_PG_INTERNALS`, `POOL_NOT_IDLE`, `MIGRATIONS_UNAVAILABLE`,
  `MIGRATIONS_APPLY_FAILED` (with `cause`), `SNAPSHOT_INVALID`, and friends —
  so callers can discriminate bridge misconfiguration programmatically instead
  of parsing message strings. Messages are unchanged and `instanceof Error`
  still holds; note that `error.name` at these sites is now `'PgBridgeError'`
  instead of `'Error'`. Codes are stable within a major version. Argument-type
  validation keeps `TypeError`; protocol-integrity and pg-parity errors stay
  plain `Error`. All public throw paths now carry `@throws` documentation.

### Patch Changes

- [`04461a9`](https://github.com/drudolf/prisma-pglite-bridge/commit/04461a9bf9a4411f9c15a50f2d1b8579d24b82a9) Thanks [@drudolf](https://github.com/drudolf)! - Roll back an abandoned transaction even when the client is released with a finite query still in flight. The release-time cleanup now registers a link on the client's submission chain and judges state when the in-flight work settles: an abandoned transaction is rolled back before any next-checkout query (previously the SessionLock stayed owned and sibling clients blocked until teardown), an unawaited COMMIT no longer draws a spurious warning, an unawaited BEGIN is now recovered once it settles, and a teardown that wins the race hands off to the duplex backstop. Releases with a bare in-flight Submittable (an abandoned cursor) keep the previous skip behavior.

- [`f2f7930`](https://github.com/drudolf/prisma-pglite-bridge/commit/f2f7930e5e5c0f9f62584b182bb96a79ca334855) Thanks [@drudolf](https://github.com/drudolf)! - Remove transient per-query allocations from warmed prepared-statement admission by passing the already-captured SQL text directly to the internal statement-name generator and checking fast-query disqualifiers directly. The public API is unchanged; the internal generator remains unexported.

- [`a917397`](https://github.com/drudolf/prisma-pglite-bridge/commit/a917397969965a673d702a42426a36ff010d249c) Thanks [@drudolf](https://github.com/drudolf)! - Decode escaped and non-ASCII `DEALLOCATE` identifiers. The statement-cache eviction detector is now a bounded scanner instead of a regex: quoted identifiers with doubled-quote escapes (`DEALLOCATE "a""b"`) and non-ASCII identifiers (`DEALLOCATE MÜNZE`, folded ASCII-only to `mÜnze` exactly as PostgreSQL folds it) now evict the right cache entry instead of leaving that name failing with error 26000, and `DEALLOCATE PREPARE` disambiguation, exact long spellings, and `$`-identifiers are pinned by an exhaustive grammar table. Undecodable text still fails closed — the SQL runs unchanged and no cache entry is ever guessed at. Comments, multi-statement text, and `U&"..."` syntax remain outside the supported subset (documented).

- [`5088c2d`](https://github.com/drudolf/prisma-pglite-bridge/commit/5088c2d9a4913b2c3cffd54bf8ff3f04da84451a) Thanks [@drudolf](https://github.com/drudolf)! - Declare `connectionTimeoutMillis`, `idleTimeoutMillis`, and `fastQueryPath`
  on `PGliteBridgeOptions`. The bridge constructor already forwarded them to
  its pool at runtime via the options spread, but TypeScript users could not
  configure them without a cast. Type-surface fix only; runtime behavior is
  unchanged.

- [`c3ab8aa`](https://github.com/drudolf/prisma-pglite-bridge/commit/c3ab8aad2cfe68ed89ffa6973cdbeb3b97971e14) Thanks [@drudolf](https://github.com/drudolf)! - Match pg's `uncaughtException` channel when an asynchronous query callback throws, instead of surfacing an unhandled promise rejection.

- [`c4bb969`](https://github.com/drudolf/prisma-pglite-bridge/commit/c4bb9697df924461118bc90c2dc55e7dd6b09795) Thanks [@drudolf](https://github.com/drudolf)! - Internal: centralize the pg-internals seam — the `parsedStatements` type,
  `prepareValue`, the extended-protocol connection type, and the active-query
  accessor — into a single `pg-internals` module so a pg upgrade surfaces in one
  place. No behavior change.

- [`a9b8ba2`](https://github.com/drudolf/prisma-pglite-bridge/commit/a9b8ba2bb8c21d2cc8c5699acc8dd5f27da72743) Thanks [@drudolf](https://github.com/drudolf)! - `PgBridgeClient.query` no longer crashes on config-embedded callbacks
  (`query({ text, callback })`). The shape is now routed through the promise
  re-entry path like positional callbacks, returning `undefined` per stock pg's
  callback-mode contract; when both are supplied, the last positional callback
  wins, mirroring pg's `normalizeQueryConfig`. Previously the shape threw a
  synchronous `TypeError` whenever the submission chain was idle, after the
  query had already been enqueued.

- [`b8d4f81`](https://github.com/drudolf/prisma-pglite-bridge/commit/b8d4f8152e9f611a3f876dacd4f63be543a79f61) Thanks [@drudolf](https://github.com/drudolf)! - Internal conventions sweep: the three `process.emitWarning` type strings are
  typo-proofed by a `BridgeWarningType` union, the DEALLOCATE decoder's
  identifier scanners use `charAt` instead of index casts, the callback
  discovery uses one `isQueryCallback` type predicate instead of two inline
  casts, `SessionLock.hold()`'s deprecation names its removal target (2.0.0),
  and a once-called schema helper is inlined. No behavior change.

- [`2f3175b`](https://github.com/drudolf/prisma-pglite-bridge/commit/2f3175b6aa7ae3a1bb815f8cab143621610972d8) Thanks [@drudolf](https://github.com/drudolf)! - Detect `$` in unquoted `DEALLOCATE` identifiers (valid in PostgreSQL past the first character), so deallocating a statement named e.g. `dollar$statement` evicts the client-side plan caches instead of failing the statement's next execution with error 26000.

- [`3b46303`](https://github.com/drudolf/prisma-pglite-bridge/commit/3b46303f6f2629094ffbe95215da5fcacf20fc35) Thanks [@drudolf](https://github.com/drudolf)! - Fix a false-eviction race in the statement-cache invalidation path and recognize quoted-adjacent `DEALLOCATE` spellings. `query()` now snapshots a non-Submittable object query config into an owned record at call time (copying only the fields pg consumes, each read once), so the text the eviction decoder reads and the text the deferred submission sends are one captured value — a caller that mutated the config object after `query()` returned could previously make the local eviction target the wrong statement (or evict on a non-`DEALLOCATE` command entirely), leaving one name failing with error 26000 and another cached locally but gone server-side. The bridge also no longer reproduces pg's incidental in-place normalization of the caller's config object. The bounded decoder additionally accepts a quoted target immediately adjacent to `DEALLOCATE` or the optional `PREPARE` (`DEALLOCATE"name"`, `DEALLOCATE PREPARE"name"`), since a double quote is an unambiguous token boundary. Everything else still fails closed: comments, multi-statement text, `U&"..."` syntax, and long-name spellings that differ from the one used to prepare run unchanged with the local eviction skipped.

- [`5a8868f`](https://github.com/drudolf/prisma-pglite-bridge/commit/5a8868fefccf1b24c90ed7776ade2c8cab64516e) Thanks [@drudolf](https://github.com/drudolf)! - Deliver the abandoned-portal recovery Sync to pg instead of discarding its response, closing the composite-window wedge. Releasing a client with a suspended cursor inside an explicit transaction previously left the session lock held until `pool.end()` — the cleanup ROLLBACK sat behind a cursor that could never complete, and every sibling in the pool blocked (the documented "waits unboundedly" contract). The manufactured terminating Sync's response is now framed through to pg: the abandoned cursor completes, pg's queue unblocks, the cleanup ROLLBACK ends the transaction, and queued siblings drain. The same delivery fixes the non-transactional residual where an abandoned-cursor client stayed permanently wedged pg-side — a recycled client is now fully usable — and applies to `max: 1` pools too. A `COMMIT`/`ROLLBACK` the user queued behind the cursor before releasing wins over the cleanup (it runs in order; the cleanup detects the closed transaction and no-ops without a warning). A failed recovery delivery destroys the client's connection so a dead client can never retain session ownership.

- [`e228e00`](https://github.com/drudolf/prisma-pglite-bridge/commit/e228e000f3c41cdfd757468b6c56260a6ad344a8) Thanks [@drudolf](https://github.com/drudolf)! - Backend-framer hardening and allocation hygiene on the duplex hot path:

  - The framer always emits defensive copies now. The former zero-copy branch never fired on real PGlite chunks, and had it ever fired it would have emitted Buffer views aliasing memory the producer overwrites on the next flush — silent data corruption. Production copy counts are unchanged.
  - Each duplex reuses one backend framer (reset per protocol call) instead of allocating a framer, scratch buffers, and closures per query — ~10 fewer short-lived allocations per query. Hardening shipped with it: PGlite retains the `onRawData` callback after `execProtocolRawStream` returns, so out-of-call invocations are now dropped instead of pushing stray bytes through a stale framer into the client stream.
  - The RowDescription "char"-widening rewrite runs in a single scan (the redundant needs-rewrite pre-check is gone), and a protocol-invalid RowDescription shorter than 7 bytes now passes through untouched instead of tearing the connection down with a `RangeError`. Only reachable from a misbehaving backend — PGlite emits neither.

- [`a9b8ba2`](https://github.com/drudolf/prisma-pglite-bridge/commit/a9b8ba2bb8c21d2cc8c5699acc8dd5f27da72743) Thanks [@drudolf](https://github.com/drudolf)! - Malformed or absurdly large frontend message lengths now fail the
  connection instead of stalling it. Both framing phases (startup and
  regular messages) previously treated an impossible declared length as
  "incomplete, wait for more data", buffering unboundedly with success
  write callbacks — reachable from arbitrary TCP clients via
  `PGliteServer`. They now throw, mirroring the backend framer's
  malformed-length and 1 GiB sanity-cap checks, which tears the
  connection down cleanly.

- [`8d9e3e2`](https://github.com/drudolf/prisma-pglite-bridge/commit/8d9e3e20b32cd7c01712b24be2277f7c05fe7711) Thanks [@drudolf](https://github.com/drudolf)! - The duplex's simple-protocol text decoder now guards sub-minimal `Q` frames
  (5 bytes, no payload) explicitly instead of relying on `Buffer.from`
  clamping a negative length to zero. No observable behavior change; the
  crafted-frame passthrough is now pinned by a test.

- [`8fce4a1`](https://github.com/drudolf/prisma-pglite-bridge/commit/8fce4a164efe8644ccec64cf80b50eed3cf71a26) Thanks [@drudolf](https://github.com/drudolf)! - Honor `query_timeout` on the fast query path. A query matching the fast-path shape (named + `rowMode: 'array'` + caller-supplied `types`) previously dropped a truthy per-query timeout. The bridge now wraps both explicit and pool-default values in an outer timer without changing the fast-path result shape, and keeps successors behind the real completion after the caller times out. `query_timeout: 0`, matching pg, falls back to any pool-level default. The timeout bounds the caller's promise, not backend work: PGlite still finishes admitted statements. Because PGlite executes on the JS thread, the timer can fire only while the event loop is free, never against the query's own WASM execution.

- [`ca9c540`](https://github.com/drudolf/prisma-pglite-bridge/commit/ca9c540686a75a752b354951bc7893c75a62fee4) Thanks [@drudolf](https://github.com/drudolf)! - Reject FastQuery submit-time failures at ReadyForQuery instead of settling inside submit. A Bind serialization throw (circular value, throwing `toPostgres`) or a warm-path `types.getTypeParser` throw previously rejected the promise before the recovery Sync round-tripped, clearing the submission chain while pg's active-query slot still held the query — a `release()` issued during or after that rejection then skipped the abandoned-transaction rollback, leaking the open transaction and the SessionLock (siblings blocked indefinitely). Buffering the error until the recovery Sync's ReadyForQuery keeps the chain occupied through the window, so release-time cleanup engages normally.

- [`88ebe22`](https://github.com/drudolf/prisma-pglite-bridge/commit/88ebe22f3082479cf240172b67b076417ac870e2) Thanks [@drudolf](https://github.com/drudolf)! - Return an owned copy of `fields` from fast-path query results so caller
  mutations can no longer corrupt the per-client field-metadata cache and
  poison later executions of the same named statement.

- [`7ffeb78`](https://github.com/drudolf/prisma-pglite-bridge/commit/7ffeb783ae1511605f0fa4961416b9c450a80563) Thanks [@drudolf](https://github.com/drudolf)! - Contain type-parser failures in the FastQuery fast path. A throwing `types.getTypeParser` no longer wedges the client (the warm path recovers the already-sent Bind with a Sync; the cold path buffers the error until ReadyForQuery), and a throwing row parser no longer escapes the connection's dataRow event as an uncaughtException — all three cases now reject the query's promise, discard partial rows, and leave the client usable, matching stock pg semantics.

- [`f0f2987`](https://github.com/drudolf/prisma-pglite-bridge/commit/f0f2987b918762aef638095934e87c14bb3c544a) Thanks [@drudolf](https://github.com/drudolf)! - Internal: `FastQuery` now `implements pg.Submittable` (typing `submit`'s
  parameter as pg's real `Connection`), so the pool's fast-path submission uses a
  checked `as pg.Submittable` upcast instead of an unchecked `as unknown as`
  reinterpret — TypeScript now verifies the conformance. No behavior change.

- [`c7e445e`](https://github.com/drudolf/prisma-pglite-bridge/commit/c7e445e95b315364e058ee0d1aa0e4aa683386e1) Thanks [@drudolf](https://github.com/drudolf)! - Fix row-limited queries hanging forever: `Flush` now flushes the EQP pipeline as a portal boundary instead of being buffered until `Sync`. This unblocks pg's `rows: N` option, pg-cursor, and pg-query-stream, which drive portal suspension with Flush. During a suspension window the duplex holds the session lock so concurrent pool clients cannot clobber the suspended portal, and after a mid-portal error it issues a recovery Sync so the session stays usable (stock pg never sends one in rows mode). Note for stats/diagnostics consumers: a row-limited query now records one query event per Flush round-trip plus the terminating Sync, rather than a single event.

- [`dfed094`](https://github.com/drudolf/prisma-pglite-bridge/commit/dfed094ba727df7821bcc6957d8a5e58ddc1e56f) Thanks [@drudolf](https://github.com/drudolf)! - Statement caching now uses usage-gated LRU admission instead of a frozen cap. A query shape earns its `ppb_` name on its second sighting (one-shot statements never occupy cache slots), and past 500 distinct shapes the least-recently-used statement is evicted and freed with a wire-protocol `Close('S')` that rides the next query's message batch — no dedicated round trip, and unlike `DEALLOCATE` it works inside failed transactions. Previously the first 500 shapes kept their names forever and every shape after ran permanently unnamed (100% re-parse when a workload's hot set shifts past the cap). Statement names remain monotonic and never reused, so a delayed Close can never misdirect an execution. Below the cap the only change is one extra unnamed execution per shape at cold start; the policy matches what pgJDBC, Npgsql, pgx, asyncpg, psycopg3, and PgBouncer ship (LRU + piggybacked wire Close; pgJDBC/Npgsql/psycopg3 also gate admission).

- [`b6ba61a`](https://github.com/drudolf/prisma-pglite-bridge/commit/b6ba61a44c5e9c3a9b1a1199369d0ad7c88d5998) Thanks [@drudolf](https://github.com/drudolf)! - The construction-time pg-internals guard now also verifies
  `client.connectionParameters` (an object with an own `query_timeout`), the
  field the bridge suppresses and restores around managed submissions. A pg
  build lacking it now fails deterministically at client construction instead
  of misbehaving at query time, and the query-timeout path reads the field
  through the typed seam instead of a local cast.

- [`ffcd544`](https://github.com/drudolf/prisma-pglite-bridge/commit/ffcd5441cf4836abdb992804e5597a83be2a747c) Thanks [@drudolf](https://github.com/drudolf)! - Fail deterministically during pool-client construction when the installed
  `pg` 8.x package does not expose the private internals required by the enabled
  bridge features. The aggregated diagnostic replaces later query or cleanup
  failures and gives deduplication and version-floor guidance. The public API
  is unchanged.

  `pg` 8.16.3 (the `@prisma/adapter-pg` floor) is verified compatible: the
  check accepts both the `pg` <= 8.16 internal layout (own `queryQueue`, plain
  `activeQuery`) and the `pg` >= 8.17 layout (`_getActiveQuery()`), and the
  in-flight-query read now follows the same two layouts instead of the
  never-shipped `_activeQuery`-only shape.

- [`23d00fd`](https://github.com/drudolf/prisma-pglite-bridge/commit/23d00fdbf838b78115145ee479b63c5e39dc0dd6) Thanks [@drudolf](https://github.com/drudolf)! - Hardened three defensive edges found in review. The process-global
  statement-name namespace counter now self-heals when same-process code
  poisons its `Symbol.for` slot with a non-integer (previously every later
  namespace was corrupted by string concatenation). A frozen or
  non-writable-callback `DEALLOCATE` Submittable no longer throws after a
  successful admission — eviction arming fails closed and the statement runs
  unchanged. And the pool's live-slot release tolerates a missing
  shared-instance counter entry instead of storing `NaN` forever.

- [`2398881`](https://github.com/drudolf/prisma-pglite-bridge/commit/239888172ebb97d61f2f3472472c6cec2329a272) Thanks [@drudolf](https://github.com/drudolf)! - `resetDb()`, `snapshotDb()`, and `resetSnapshot()` now also throw when a
  pool checkout is still WAITING for dispatch, not only when a client is
  checked out. Previously an un-awaited query fired in the same tick was
  invisible to the guard (pg-pool defers dispatch by one tick), so the reset
  could interleave with it and the query's rows silently survived into the
  "fresh" database. Awaiting all pending queries before calling remains the
  documented contract — a query behind a caller-side async hop is invisible
  to every pool counter.

- [`8fce4a1`](https://github.com/drudolf/prisma-pglite-bridge/commit/8fce4a164efe8644ccec64cf80b50eed3cf71a26) Thanks [@drudolf](https://github.com/drudolf)! - Keep a pool counted toward the shared-instance overlap warning until it has actually drained. `end()` previously released the pool's slot synchronously, but pg-pool keeps checked-out clients alive until they are released — so a pool constructed on the same PGlite during that drain window missed the `PGliteBridgeSharedInstanceWarning` although real cross-pool interleaving was possible. A pool that ever held a client — or that still has an unsettled client teardown in flight — now releases its slot only after `end()`'s duplex-teardown barrier settles; a never-connected pool still releases synchronously (the constructor-failure cleanup path cannot await). The decision is latched to the first `end()` call, so repeated `end()` cannot release early.

- [`8cfa319`](https://github.com/drudolf/prisma-pglite-bridge/commit/8cfa3194f18f915b5f6edc447a2c95a5b20d1a8a) Thanks [@drudolf](https://github.com/drudolf)! - Honor the documented `connectionTimeoutMillis` option on `PgBridgePool`, so a
  checkout queued behind an exhausted pool rejects at its deadline and cannot
  later capture a released client.

- [`46a3b6d`](https://github.com/drudolf/prisma-pglite-bridge/commit/46a3b6d18e7754107b4f339ce17e3cbba8c4784a) Thanks [@drudolf](https://github.com/drudolf)! - `PgBridgePool.end()` now waits (bounded, ~10s drain limit) for every
  client duplex to finish tearing down before resolving — and only then
  closes a pool-owned PGlite. pg-pool's own `end()` resolves without
  waiting for client teardown, so an in-flight destroy-path ROLLBACK could
  previously race `pglite.close()` and spin the event loop on the dead
  WASM instance.

- [`123da7b`](https://github.com/drudolf/prisma-pglite-bridge/commit/123da7bb4662e3c3d2592df685aee4abd2b57359) Thanks [@drudolf](https://github.com/drudolf)! - `PgBridgePool` now rejects a non-positive-integer `max` with a `TypeError`. Previously `max: 0` fell through to pg-pool's `max || 10` fallback and silently ran ten clients without a shared SessionLock — no transaction isolation on the shared PGlite session.

- [`6df26f5`](https://github.com/drudolf/prisma-pglite-bridge/commit/6df26f56c1baa6dcae05c58f09ed2bfbe89fbd8f) Thanks [@drudolf](https://github.com/drudolf)! - Remove `sessionLock` and `protocolCleanupNeeded` from `PgBridgePoolOptions`. Both were accepted by the type but silently ignored — the pool always builds its own `SessionLock` and detects protocol-cleanup capability itself. Passing them is now a compile-time error.

- [`e1fff8b`](https://github.com/drudolf/prisma-pglite-bridge/commit/e1fff8ba073d2a4ab48062d9472c0d5eb11af82c) Thanks [@drudolf](https://github.com/drudolf)! - Stock-pg dispatch parity: a function passed as the first argument to `query()` is now treated as a query config (as stock pg does) instead of being consumed as a callback, and empty query text is no longer fast-path eligible — it runs through stock pg, which owns EmptyQueryResponse semantics.

- [`1ed9f18`](https://github.com/drudolf/prisma-pglite-bridge/commit/1ed9f181c22f9541144cedf72d172090e0bc2c2b) Thanks [@drudolf](https://github.com/drudolf)! - Internal: refactor `PgBridgeClient.query()` for readability — extract the
  callback-form handling into `#dispatchCallbackForm`, give the submission-chain
  locals intent-revealing names, and compute the DEALLOCATE-tap promise without
  re-assignment. No behavior change.

- [`648be5e`](https://github.com/drudolf/prisma-pglite-bridge/commit/648be5eb0a395cd39c3bc7364d4c5900211dae44) Thanks [@drudolf](https://github.com/drudolf)! - Preserve a configured `query_timeout` default when stock pg submission synchronously re-enters `PgBridgeClient.query()`. The bridge still suppresses pg's duplicate timer while admitting the outer query, but nested promise, callback, and fast-query calls now inherit the live public default instead of silently running without a timeout.

- [`119775b`](https://github.com/drudolf/prisma-pglite-bridge/commit/119775b7f1687d0a7bc8a5baa0e996cb9a25d6c0) Thanks [@drudolf](https://github.com/drudolf)! - Expose a pg-compatible `query_timeout` default on `PgBridgePool` and `PGliteBridge`. Ordinary query deadlines now start at the public call after checkout and include time spent behind the bridge submission chain. A query that expires before bridge admission is skipped instead of executing later; an admitted query still drains internally before successors run. Pool checkout and backend cancellation remain separate concerns.

- [`46a3b6d`](https://github.com/drudolf/prisma-pglite-bridge/commit/46a3b6d18e7754107b4f339ce17e3cbba8c4784a) Thanks [@drudolf](https://github.com/drudolf)! - Close the dangling implicit transaction when a pool client abandons a
  suspended pg-cursor portal: its release now manufactures the terminating
  Sync the client never sent, before the session lock is released. Without
  it, the next sibling query inherited the open implicit transaction and
  recorded ReadyForQuery `T` — so the sibling's perfectly clean release
  fired a misattributed `PGliteBridgeAbandonedTransactionWarning` and
  enqueued a needless ROLLBACK that could race pool teardown into a
  dead-WASM event-loop spin.

- [`88ebe22`](https://github.com/drudolf/prisma-pglite-bridge/commit/88ebe22f3082479cf240172b67b076417ac870e2) Thanks [@drudolf](https://github.com/drudolf)! - Preserve the submission chain when stock pg submission synchronously
  re-enters `query()` (a `toPostgres` hook or a warm fast-path type parser):
  the nested query's tail is no longer stomped by the outer query, so chained
  ordering and release-time abandoned-transaction cleanup see the in-flight
  work.

- [`2a063e3`](https://github.com/drudolf/prisma-pglite-bridge/commit/2a063e373177f033937eeb308c950d923437132a) Thanks [@drudolf](https://github.com/drudolf)! - Remove the contiguous pipeline fast path from `PGliteDuplex`. A counting
  probe preloaded into real consumer workloads (Prisma, Drizzle) measured
  zero contiguous batches — pg writes each protocol message as its own
  chunk from a freshly allocated buffer, so multi-part pipelines are never
  adjacent views of one backing buffer and the zero-copy path never
  triggered. Pipeline flushes now always use the copying concat path,
  removing the buffer-aliasing hazard of views over socket chunks. This
  supersedes the 1.1.0 note about avoiding concatenation for contiguous
  extended-query batches.

- [`46a3b6d`](https://github.com/drudolf/prisma-pglite-bridge/commit/46a3b6d18e7754107b4f339ce17e3cbba8c4784a) Thanks [@drudolf](https://github.com/drudolf)! - Roll back a transaction left open when a pool client is plain-released
  (no COMMIT/ROLLBACK). Because pool clients share one PGlite session, an
  abandoned open transaction previously kept the session lock owned —
  wedging every other pool client indefinitely — and leaked the open
  transaction into the recycled client's next checkout. It is now rolled
  back at release time, unblocking waiters and giving the next checkout a
  clean session, and a `PGliteBridgeAbandonedTransactionWarning` is emitted
  so the application bug (a missing COMMIT/ROLLBACK) is diagnosable.

- [`a9b8ba2`](https://github.com/drudolf/prisma-pglite-bridge/commit/a9b8ba2bb8c21d2cc8c5699acc8dd5f27da72743) Thanks [@drudolf](https://github.com/drudolf)! - `PGliteServer.close()` is now idempotent: repeat calls return the same
  promise, closing a server that never listened resolves cleanly, and a
  close racing an in-flight `listen()` waits the bind out instead of
  leaking the listener. `listen()` on a closed server now throws instead
  of returning the stale URL; a failed bind stays retryable.

- [`0582c63`](https://github.com/drudolf/prisma-pglite-bridge/commit/0582c638790467fb8700fe32be5fbae901a62be6) Thanks [@drudolf](https://github.com/drudolf)! - Internal: collocate the per-PGlite session-scope registries (`livePoolCounts`,
  `liveClientCounts`, `liveClients`) into a single `session-registry` module
  instead of splitting them across the pool and client modules, and give the pool
  `end()` teardown closure a clearer name. No behavior change.

- [`88ebe22`](https://github.com/drudolf/prisma-pglite-bridge/commit/88ebe22f3082479cf240172b67b076417ac870e2) Thanks [@drudolf](https://github.com/drudolf)! - `PgBridgePool.end()` now clears its internal teardown-drain timer once the
  drain completes, so a settled pool no longer leaves a stale 10-second timer
  pending.

- [`72c72cc`](https://github.com/drudolf/prisma-pglite-bridge/commit/72c72cc70c1cc4208d89e6900e60f563dcf3fff5) Thanks [@drudolf](https://github.com/drudolf)! - Harden snapshot capture: the internal `__tables` bookkeeping insert now binds
  schema/table names as query parameters instead of interpolating them through a
  hand-rolled SQL string-literal escaper, which is removed. Dynamic catalog
  values now go through bind parameters or the database's own
  `quote_ident()`/`quote_literal()` exclusively. No behavior change.

- [`e228e00`](https://github.com/drudolf/prisma-pglite-bridge/commit/e228e000f3c41cdfd757468b6c56260a6ad344a8) Thanks [@drudolf](https://github.com/drudolf)! - Snapshot and `resetDb()` robustness:

  - `snapshotDb()` now rebuilds under a staging schema inside a single transaction and swaps it into place at commit. A failed re-snapshot previously destroyed the existing snapshot first, silently degrading every later `resetDb()` from "restore seed" to "wipe to empty"; now the previous snapshot stays fully restorable. `snapshotDb`, `resetDb`, and `resetSnapshot` are also serialized against each other, so un-awaited overlapping calls can no longer interleave their SQL.
  - `resetDb()` now restores snapshots of tables with `GENERATED ALWAYS AS IDENTITY` and stored generated columns — explicit column lists (generated columns recompute) plus `OVERRIDING SYSTEM VALUE` where needed; previously such tables snapshotted fine but every restore threw. A source table or column dropped since `snapshotDb()` fails fast with an explicit error before anything is truncated, instead of a raw Postgres error (or a silently partial restore) mid-restore; column names in drift errors render via `quote_ident`.
  - The staging schema `_pglite_snapshot_new` (left behind only by a hard crash mid-rebuild on a persisted dataDir) is excluded from the user-table and sequence scans, so a subsequent `resetDb` neither truncates nor captures staged data.

- [`0fe80b5`](https://github.com/drudolf/prisma-pglite-bridge/commit/0fe80b512082b0394ab1e6eb61f3f3914414cf85) Thanks [@drudolf](https://github.com/drudolf)! - Internal: replace the pool's `as unknown as` casts over pg internals with
  sound typings. A `pg` module augmentation declares the extended-protocol
  connection seam that `@types/pg` omits (`parsedStatements`, `sendCopyFail`,
  and the one-arg `parse`/`bind`/`describe`/`execute`/`close` forms), so
  `FastQuery.submit` and the statement-cache eviction read it without a cast;
  pool-event clients narrow via `instanceof PgBridgeClient`. No behavior change.

- [`0599fb3`](https://github.com/drudolf/prisma-pglite-bridge/commit/0599fb3ebad7ded85279fc6cb811a6a3f25e5928) Thanks [@drudolf](https://github.com/drudolf)! - Internal: remove five `as`-casts that circumvented the type system in
  non-pool `src/`, replacing each with sound narrowing. Indexed reads in
  the copy-in SQL scanner use `String.charAt` (which returns `''` past the
  end instead of `undefined`); the statement-name LRU evicts its oldest
  entry via a first-entry `for…of` instead of casting
  `.keys().next().value`/`.get()`, which also drops a redundant re-lookup
  and no longer evicts from an empty map at `capacity: 0`; the EQP
  pipeline fast path narrows `messages[0]` with a definedness guard; and
  the server's `address()` read narrows Node's `AddressInfo | string |
null` union with a runtime guard that throws on the (unreachable)
  non-TCP cases. No behavior change on supported configurations.

- [`07aba33`](https://github.com/drudolf/prisma-pglite-bridge/commit/07aba3385701315025f00913f7f71ca96a5f10e4) Thanks [@drudolf](https://github.com/drudolf)! - Internal: remove the three reducible `as`-casts from the test helpers.
  `createBridgeContext` narrows `schema` with a guard instead of casting
  to `PushSchemaOptions`; the vitest fixtures read the client through a
  `takeClient` guard (shared by both fixtures) instead of asserting
  `clients.get(bridge) as TClient`. The one remaining cast — the
  invariant-`TestAPI` narrowing that hides the internal `template`
  fixture in `'test'` scope — is documented as irreducible and pinned by
  a new `expectTypeOf` test on the public fixture surface. No behavior
  change.

- [`a9b8ba2`](https://github.com/drudolf/prisma-pglite-bridge/commit/a9b8ba2bb8c21d2cc8c5699acc8dd5f27da72743) Thanks [@drudolf](https://github.com/drudolf)! - `recentP50QueryMs`, `recentP95QueryMs`, and `recentMaxQueryMs` now
  cover exactly the documented `QUERY_DURATION_WINDOW_SIZE` most recent
  queries. Previously they were computed over the whole retained
  buffer, which lazily trims at twice the window — so the effective
  window drifted between 1× and 2× depending on trim phase.

- [`0c56411`](https://github.com/drudolf/prisma-pglite-bridge/commit/0c564115d5553a13da9c6489b6f4bcc370dfefc4) Thanks [@drudolf](https://github.com/drudolf)! - Destroy the client connection when a Submittable's `submit()` throws at deferred admission. pg marks the query active and clears `readyForQuery` before calling `submit()`, so a throw left the client silently wedged — every later query queued forever, strictly worse than stock pg's synchronous throw. Destroying the duplex routes the error to the Submittable's `handleError` exactly once via pg's connection-error path, rejects queued successors instead of hanging them, and lets the pool evict the dead client.

- [`17a95a7`](https://github.com/drudolf/prisma-pglite-bridge/commit/17a95a745cc7174d8a242aa61247be52dfe7a554) Thanks [@drudolf](https://github.com/drudolf)! - Preserve call order when a Submittable follows chain-delayed queries. `query(submittable)` still returns the submittable synchronously, but its admission to pg's internal queue now waits for the pending submission chain, so it can no longer jump ahead of an earlier promise-form query on the same client. The chain is not extended past it: ordering after admission (including completion) remains pg's own FIFO contract, and an admission failure on an ended client is delivered through the submittable's error path.

- [`9c00d80`](https://github.com/drudolf/prisma-pglite-bridge/commit/9c00d8029dd76d2c3cc27029d0740a591d918222) Thanks [@drudolf](https://github.com/drudolf)! - Forward the full argument list through Submittable admission. Stock pg
  attaches a trailing positional callback to the submittable itself, which is
  how pg-pool's release callback reaches `pool.query(new pg.Query(...))` — the
  bridge dropped it, so the pool promise never settled, the client stayed
  checked out forever, and `pool.end()` hung. `pool.query(Submittable)` and
  `client.query(submittable, cb)` now behave like stock pg.

- [`ad0730f`](https://github.com/drudolf/prisma-pglite-bridge/commit/ad0730f05a0c46fb4464447ff3148ce1b6f05e1e) Thanks [@drudolf](https://github.com/drudolf)! - Evict statement caches when DEALLOCATE / DISCARD ALL is issued through a
  Submittable (`client.query(new pg.Query('DEALLOCATE ALL'))`). Previously the
  backend dropped its prepared statements while every live client's plan cache
  stayed warm, so subsequent named executions failed persistently with
  Postgres error 26000. Eviction fires exactly once on the query's real
  completion via pg's own channels (wrapped callback plus the `'end'` event),
  covering the fired-`query_timeout` case; errors evict nothing. Submittables
  exposing neither channel are a documented fail-closed exception.

- [`a8b1e03`](https://github.com/drudolf/prisma-pglite-bridge/commit/a8b1e03a8d24534ba45b2f7c69ef3ae90e8936d3) Thanks [@drudolf](https://github.com/drudolf)! - Internal: dispatch Submittable and FastQuery pool queries through pg's real
  `query` overload instead of an `as unknown as` view, and narrow the shared
  stock-query forwarder to an honest single signature. This removes the last
  type-erasing cast from the pool's `query()` path. No behavior change.

- [`e228e00`](https://github.com/drudolf/prisma-pglite-bridge/commit/e228e000f3c41cdfd757468b6c56260a6ad344a8) Thanks [@drudolf](https://github.com/drudolf)! - No leaked WASM instances on setup failure: `createBridgeContextFromDump` now closes the bridge and the loaded PGlite instance when a client factory or bridge option validation throws (the same contract `createBridgeContext` already had), and `new PGliteBridge()` closes its self-created PGlite when the Prisma adapter constructor throws — previously the half-constructed bridge left the instance open and unclosable. Caller-supplied instances are left open, as before.

- [`a4498c7`](https://github.com/drudolf/prisma-pglite-bridge/commit/a4498c73955e4302e84ea85247eade60ead52f4a) Thanks [@drudolf](https://github.com/drudolf)! - `PgBridgePool.end()` now waits for the duplex teardown of clients whose
  connect failed before pg-pool's `'connect'` event (checkout or readiness
  timeouts): teardown handles register at duplex creation inside the client
  constructor instead of on `'connect'`, so no destroy-path work can outlive
  the pool's close barrier.

- [`d039a07`](https://github.com/drudolf/prisma-pglite-bridge/commit/d039a0703b338c54e35829286f9fa3551e265986) Thanks [@drudolf](https://github.com/drudolf)! - Internal reorganization: the `vitest` and `jest` entry points moved from
  `src/vitest/index.ts` and `src/jest/index.ts` to `src/testing/vitest.ts`
  and `src/testing/jest.ts`, next to the runner-agnostic core they share.
  The published subpaths `prisma-pglite-bridge/vitest` and
  `prisma-pglite-bridge/jest` are unchanged.

- [`88ebe22`](https://github.com/drudolf/prisma-pglite-bridge/commit/88ebe22f3082479cf240172b67b076417ac870e2) Thanks [@drudolf](https://github.com/drudolf)! - Stop spreading caller-supplied `types` objects when wrapping array parsers:
  unrelated own getters are no longer read (or able to throw) during
  `query()`; the wrapper exposes only `getTypeParser`.

- [`9a4dea8`](https://github.com/drudolf/prisma-pglite-bridge/commit/9a4dea8ca759fd916631e1d975875b8aa31524f1) Thanks [@drudolf](https://github.com/drudolf)! - Internal: the `getTypeParser` carrier shape is now declared once
  (`TypesLike` in the fast-array-parser module) instead of twice — the
  duplicate `FastQueryTypes` alias is gone. No public surface change.

- [`deeec5c`](https://github.com/drudolf/prisma-pglite-bridge/commit/deeec5cca0a1d42fe1b170462a94d0e7fe7cd916) Thanks [@drudolf](https://github.com/drudolf)! - `PGliteBridge` now validates `max` before creating its owned PGlite
  instance. Previously an invalid `max` (`0`, negative, non-integer) threw the
  pool's TypeError only after `new PGlite()` had already started its eager
  WASM initialization, orphaning ~135 MB until garbage collection. The rejected
  configuration now throws before any PGlite exists.

## 1.6.2

### Patch Changes

- [`b18e65a`](https://github.com/drudolf/prisma-pglite-bridge/commit/b18e65a97fe0cd36183d2f02a59e35a882feaf23) Thanks [@drudolf](https://github.com/drudolf)! - New `schema` option on `PGliteBridge` (and, via the `bridge` option, the
  vitest/jest setup helpers). It is forwarded to `@prisma/adapter-pg` as its
  `schema` option, which sets the connection `search_path` so Prisma reads and
  writes in a non-`public` PostgreSQL schema. Omit it to keep `public`.

## 1.6.1

### Patch Changes

- [`5fcf648`](https://github.com/drudolf/prisma-pglite-bridge/commit/5fcf6484294606944e22c6bbf9298bcf13cf4848) Thanks [@drudolf](https://github.com/drudolf)! - Docs: correct the `createBridgeTest({ scope: 'test' })` speedup claim.
  Measured, it is several times faster per test (~5x on both Apple
  Silicon and x86, and far more predictable) rather than "an order of
  magnitude" — the earlier figure conflated the one-time WASM compile.
  Adds a reproducible per-test isolation-cost benchmark
  (`pnpm bench:isolation`) with committed two-machine reference numbers,
  and updates the README, cookbook, and BENCHMARK docs to match.

## 1.6.0

### Minor Changes

- [`b8a2378`](https://github.com/drudolf/prisma-pglite-bridge/commit/b8a2378e373407b774ab2f323c3bfe082fd37fb9) Thanks [@drudolf](https://github.com/drudolf)! - `createBridgeTest({ scope: 'test' })` is now several times faster per
  test (~5x measured, and far more predictable). Instead of paying a full PGlite cold start +
  migrations + seed on every test, it builds one template per file
  (cold start + migrations + seed, paid once), dumps it, and loads a
  fresh, independent PGlite instance from that template for each test.

  The one behavior change: your `seed` callback now runs once per file
  (against the template) instead of once per test, so any side effects
  it performs — database writes and otherwise — happen once per file.
  Every test still starts from the fully seeded state, stays fully
  isolated, and `test.concurrent` remains safe. Each live instance
  keeps its own in-memory data directory, so many concurrent tests
  trade memory for isolation.

- [`274cd2a`](https://github.com/drudolf/prisma-pglite-bridge/commit/274cd2ab042280d831ea6b09adb981e3a424f915) Thanks [@drudolf](https://github.com/drudolf)! - New `prisma-pglite-bridge/jest` entry point — the Jest counterpart to
  `prisma-pglite-bridge/vitest`'s `setupPGliteBridge`:

  ```typescript
  import { PrismaClient } from "@prisma/client";
  import { setupPGliteBridge } from "prisma-pglite-bridge/jest";

  const { prisma } = await setupPGliteBridge({
    client: (adapter) => new PrismaClient({ adapter }),
    migrations: true,
    seed: async (prisma) => {
      await prisma.tenant.create({ data: { name: "Acme" } });
    },
  });

  test("starts from the seeded snapshot", async () => {
    expect(await prisma.tenant.count()).toBe(1);
  });
  ```

  Same options and behavior as the vitest helper — one call sets up the
  bridge, schema, seed, and snapshot, and by default registers
  `beforeEach(resetDb)` + `afterAll(close)` — wired to Jest's hooks via
  `@jest/globals` (a new optional peer dependency). Requires Jest's native
  ESM mode so the top-level `await` resolves before the suite runs. Jest has
  no fixture (`test.extend`) equivalent, so there is no `createBridgeTest` on
  this entry; the hook-based helper is the whole surface.

- [`d94f364`](https://github.com/drudolf/prisma-pglite-bridge/commit/d94f364b0b3774bb0e3252b41b66a9f0ad10731c) Thanks [@drudolf](https://github.com/drudolf)! - New `createBridgeTest` in `prisma-pglite-bridge/vitest` — a
  test-context (fixture) variant of `setupPGliteBridge` built on
  `test.extend`:

  ```typescript
  import { PrismaClient } from "@prisma/client";
  import { createBridgeTest } from "prisma-pglite-bridge/vitest";

  const test = createBridgeTest({
    client: (adapter) => new PrismaClient({ adapter }),
    migrations: true,
    seed: async (prisma) => {
      await prisma.tenant.create({ data: { name: "Acme" } });
    },
  });

  test("starts from the seeded snapshot", async ({ prisma }) => {
    expect(await prisma.tenant.count()).toBe(1);
  });
  ```

  Tests declare what they need (`{ prisma, bridge }`, fully typed); every
  test taking `prisma` starts from the seeded snapshot; teardown is
  sequenced by vitest. The `scope` option spans the whole
  isolation/speed dial: `'file'` (default) — one bridge per test file;
  `'worker'` — one warm bridge across all files a worker runs, amortizing
  the WASM cold start, migrations, and seed per worker with vitest's
  default isolation left ON (previously this required `isolate: false`);
  `'test'` — a fresh bridge per test, the only configuration where
  `test.concurrent` is safe. The optional `vitest` peer floor moves to
  `^3.2.0` (fixture scopes).

## 1.5.0

### Minor Changes

- [`338da70`](https://github.com/drudolf/prisma-pglite-bridge/commit/338da70ab560e4987461d4a8c09c6642cb7ee9a0) Thanks [@drudolf](https://github.com/drudolf)! - New opt-in `preparedStatements` option on `PGliteBridge`: caches Prisma
  queries as named prepared statements so PGlite parses and plans each query
  shape once per session instead of on every execution (~7% lower read p50,
  ~18% lower p99 in the reference benchmark; WASM parse/plan is the single
  largest per-query cost). Unlike many production Postgres setups
  (transaction-mode poolers break named statements), the bridge can always
  run with it on — but it stays off by default so session semantics change
  only when you ask.

  Prepared statements survive `resetDb()`: the reset now issues the granular
  equivalent of `DISCARD ALL` without `DEALLOCATE ALL` (session variables,
  temp tables, cursors, advisory locks, and cached plans are still cleared).
  Tables are truncated, never dropped, so retained statements revalidate
  transparently and the cache stays warm across per-test resets.

  Also fixed: statements prepared through a destroyed pool client survived
  in PGlite's shared session and collided with replacement clients
  re-preparing the same names (42P05 "prepared statement already exists").
  Every fresh bridge connection now starts with a clean statement namespace,
  matching real-server semantics.

## 1.4.0

### Minor Changes

- [`fa5d308`](https://github.com/drudolf/prisma-pglite-bridge/commit/fa5d308a3818bb379bec984199ad296fcd9c41ec) Thanks [@drudolf](https://github.com/drudolf)! - New `prisma-pglite-bridge/vitest` entry point with `setupPGliteBridge` — a
  one-call Vitest setup that creates a bridge, applies migrations (or an inline
  schema), runs your seed, snapshots the state, and registers
  `beforeEach(resetDb)` + `afterAll(close)` hooks:

  ```typescript
  import { PrismaClient } from "@prisma/client";
  import { setupPGliteBridge } from "prisma-pglite-bridge/vitest";

  const { prisma } = await setupPGliteBridge({
    client: (adapter) => new PrismaClient({ adapter }),
    migrations: true,
    seed: async (prisma) => {
      await prisma.tenant.create({ data: { name: "Acme" } });
    },
  });
  ```

  `vitest` becomes an optional peer dependency; only the new entry point
  imports it.

## 1.3.0

### Minor Changes

- [`335ec35`](https://github.com/drudolf/prisma-pglite-bridge/commit/335ec3532719eff06ee497d9455c567864d43c00) Thanks [@drudolf](https://github.com/drudolf)! - `pushSchema` accepts a `schemaEngine` option to inject an alternative
  schema-engine WASM module (new exported type `SchemaEngineModule`) instead of
  dynamically importing `@prisma/schema-engine-wasm`. This decouples the bridge
  from the published package — e.g. for engine builds compiled directly from
  `prisma-engines` source. When omitted, behavior is unchanged.

### Patch Changes

- [`ff0ac79`](https://github.com/drudolf/prisma-pglite-bridge/commit/ff0ac798ad6defd1eb4a8ffe3b4f9faf0116afed) Thanks [@drudolf](https://github.com/drudolf)! - Skip the redundant PGlite protocol-message cleanup on PGlite >= 0.5.3, where
  electric-sql/pglite#1030 removed the raw-stream result accumulation the cleanup
  compensated for. The bridge reads its resolved PGlite version and only runs the
  cleanup on older runtimes, or when the version can't be determined.

## 1.2.0

### Minor Changes

- [`7235952`](https://github.com/drudolf/prisma-pglite-bridge/commit/7235952fac9813e827336ec3adb340cf31b4b05b) Thanks [@drudolf](https://github.com/drudolf)! - Allow PGlite 0.5.x: the `@electric-sql/pglite` peer range is now
  `^0.4.0 || ^0.5.0`. Validated against PGlite 0.5.1 (PostgreSQL 18.3) across
  the full test suite, including Prisma CLI compatibility — together with the
  PostgreSQL 18 introspection workaround and the `PGliteServer` catalog-OID
  fix shipped in this release.

### Patch Changes

- [`100bd85`](https://github.com/drudolf/prisma-pglite-bridge/commit/100bd85ce9c41928a53cb2275742210c7b063226) Thanks [@drudolf](https://github.com/drudolf)! - Shield the schema engine from PostgreSQL 18's `contype = 'n'` rows during
  `pushSchema`. PostgreSQL 18 represents NOT NULL constraints as `pg_constraint`
  rows, which the Prisma schema engine's constraint introspection does not
  handle and panics on — the `pushSchema` promise then never settles. The bridge
  now appends `'n'` to the engine's introspection denylist before the query
  runs; a semantic no-op on PostgreSQL ≤ 17. This unblocks running against
  PGlite 0.5.x (PostgreSQL 18.3).

- [`7235952`](https://github.com/drudolf/prisma-pglite-bridge/commit/7235952fac9813e827336ec3adb340cf31b4b05b) Thanks [@drudolf](https://github.com/drudolf)! - `PGliteServer` no longer widens system-catalog `"char"` columns (OID 18) to
  text (OID 25) in RowDescription frames. The widening is an
  `@prisma/adapter-pg` accommodation that belongs to the bridge path only;
  native clients (Prisma CLI engine, psql, GUIs) need the real OID. With the
  rewrite, the CLI's schema engine misread `pg_constraint.contype` as text and
  failed on PostgreSQL 18's NOT NULL constraint rows (`prisma db pull`,
  `prisma migrate dev`). The rewrite is now controlled by a new
  `rewriteSystemCatalogCharOids` option on `PGliteDuplex` (default `true`;
  the server passes `false`).

## 1.1.0

### Minor Changes

- [`1a123cb`](https://github.com/drudolf/prisma-pglite-bridge/commit/1a123cbe7b68a31f460ca19ad90c55f1c1e08525) Thanks [@drudolf](https://github.com/drudolf)! - Improve bridge performance and memory behavior under Prisma workloads.

  The bridge now periodically clears PGlite's internal parsed protocol
  message cache after bounded protocol traffic, which prevents retained
  RSS growth during repeated large reads while preserving the streaming
  wire-protocol path. The cleanup is best-effort and disables itself if a
  future PGlite version no longer supports the verified cleanup behavior.

  Also reduce per-query overhead by avoiding unnecessary pipeline
  concatenation when pg sends contiguous extended-query protocol batches,
  skipping RowDescription copies unless catalog `"char"` fields need
  rewriting, coalescing no-rewrite RowDescription frames with adjacent
  backend messages, and simplifying `PgBridgeClient` query submission so
  idle clients dispatch immediately with less promise-chain overhead.

## 1.0.0

### Major Changes

- [`381654a`](https://github.com/drudolf/prisma-pglite-bridge/commit/381654aae595885e1e2b11e3863227ec33286f2b) Thanks [@drudolf](https://github.com/drudolf)! - **Breaking:** Drop the `createPGliteBridge()` and `createPool()`
  factory functions. The bridge and pool are now class exports
  constructed directly:

  - `createPGliteBridge(options)` → `new PGliteBridge(options)`
  - `createPool(options)` → `new PgBridgePool(options)`

  The class constructors are synchronous; PGlite readiness is awaited
  internally on the first operation. `PgBridgePool` extends `pg.Pool`
  directly, so its return is the pool itself — not a `{ pool, close,
bridgeId }` wrapper. Use `pool.end()` to shut it down and read
  `pool.bridgeId` for diagnostics filtering.

  The accompanying option/return-type names also collapse:

  - `CreatePGliteBridge` (factory return type) → `PGliteBridge` (the class itself)
  - `CreatePoolOptions` / `PoolOptions` → `PgBridgePoolOptions`

  Also exposes `PGliteDuplexOptions` from the package barrel so all
  public input bags (`PGliteBridgeOptions`, `PgBridgePoolOptions`,
  `PGliteServerOptions`, `PGliteDuplexOptions`, `PushSchemaOptions`,
  `PushMigrationsOptions`) follow the same `*Options` convention.

  **Breaking — `pglite` is now optional and ownership is determined at
  construction:** `PGliteBridge` and `PGliteServer` no longer require a
  `pglite` argument. When omitted, each class creates its own in-memory
  `PGlite` and owns its lifecycle — `close()` shuts it down. When you
  supply a `pglite`, the class treats it as caller-owned and `close()`
  leaves it open. The `{ closePglite: false }` escape hatch on `close()`
  is removed; the decision is made once, at construction.

  `PgBridgePool` follows the same ownership rule: `pglite` is now
  optional and `end()` is overridden to close the instance when the
  pool created it. When you supply a `pglite`, `end()` leaves it open
  and you are responsible for closing it.

  **Migration:**

  ```ts
  // before
  import { createPGliteBridge, createPool } from "prisma-pglite-bridge";
  const bridge = await createPGliteBridge({ pglite });
  const { pool, close } = await createPool({ pglite });

  // after — no pglite needed for the common in-memory case:
  import { PGliteBridge, PgBridgePool } from "prisma-pglite-bridge";
  const bridge = new PGliteBridge(); // owns its own PGlite
  const pool = new PgBridgePool(); // owns its own PGlite
  // later: await pool.end();

  // after — caller-supplied PGlite (e.g. custom dataDir or extensions):
  const pglite = new PGlite({ extensions: { uuid_ossp } });
  const bridge = new PGliteBridge({ pglite }); // caller owns; bridge.close() leaves it open
  // later: await bridge.close(); await pglite.close();
  ```

### Patch Changes

- [`71f0a11`](https://github.com/drudolf/prisma-pglite-bridge/commit/71f0a117a1e7b9499c14c5e8f7f8149c21925a89) Thanks [@drudolf](https://github.com/drudolf)! - Internal refactor: regroup `src/` into a folder-per-class layout.
  Top-level `src/` now holds only the public barrel (`index.ts`)
  plus seven cohesive folders:

  - `duplex/`, `pglite-bridge/`, `pglite-server/`, `pool/`,
    `schema/`, `telemetry/`
  - `utils/` slimmed to true cross-cutting helpers
    (`session-lock`, `time`, `resolve-sync-to-fs`,
    `wait-pglite-ready`)

  Also rewrites `SnapshotManager` from a closure-based factory
  into a class, matching the rest of the codebase. Public API is
  unchanged.

- [`d4eed26`](https://github.com/drudolf/prisma-pglite-bridge/commit/d4eed267b259cb7b4dc1f90eeec58e1b39a21177) Thanks [@drudolf](https://github.com/drudolf)! - Throw with an actionable message when `bridge.snapshotDb()`,
  `bridge.resetDb()`, or `bridge.resetSnapshot()` is called while pool
  clients are still checked out. These operations run raw SQL on the
  PGlite instance bypassing the pool, so concurrent pool traffic could
  silently corrupt state or deadlock — the guard surfaces the misuse
  loudly. Working code that calls them outside Prisma traffic
  (`beforeAll`, between tests, before `$disconnect`) is unaffected.

## 0.7.0

### Minor Changes

- [`c79994d`](https://github.com/drudolf/prisma-pglite-bridge/commit/c79994d4845ba032bc1940631f70456c79724b6e) Thanks [@drudolf](https://github.com/drudolf)! - Add `PGliteDuplex#onClose`, a single-shot `Promise<void>` that
  resolves once the stream has fully torn down (post-`_final`
  rollback, post-`_destroy`). Mirrors the `'close'` event but is
  safe to await even after close has already happened, which makes
  it convenient for orchestrators that need to wait for in-flight
  duplexes during shutdown.

- [`342a762`](https://github.com/drudolf/prisma-pglite-bridge/commit/342a7625de202cc6273f31b46aaec71c8b219889) Thanks [@drudolf](https://github.com/drudolf)! - Add `hasMigrations(pglite)` and `hasSchema(pglite)` introspection
  helpers and expose `PGliteServer#pglite` as a public readonly field.

  `hasMigrations` returns `true` when `_prisma_migrations` exists
  and has at least one row with `finished_at IS NOT NULL`.
  `hasSchema` returns `true` when the `public` schema contains at
  least one user table — broader, fires for `pushSchema` and
  hand-rolled DDL too. Both await `pglite.waitReady` implicitly via
  `pglite.query(...)`, so they can be called immediately after
  `new PGlite(...)`.

  `PGliteServer` now exposes the supplied `pglite` as `server.pglite`
  (matching `bridge.pglite` on `PGliteBridge`). `listen()` also waits
  for `pglite.waitReady` internally instead of requiring callers to
  await it first, and surfaces the underlying rejection on failure.

  Useful as a "first run" guard for persistent `dataDir` setups:

  ```ts
  const server = new PGliteServer({ pglite: new PGlite("./data/pglite") });
  if (!(await hasMigrations(server.pglite))) {
    await pushMigrations(server.pglite, {
      migrationsPath: "./prisma/migrations",
    });
  }
  await server.listen();
  ```

- [`a6e84fa`](https://github.com/drudolf/prisma-pglite-bridge/commit/a6e84fabd5016faa9fb098c17f2e6784fb20cc2b) Thanks [@drudolf](https://github.com/drudolf)! - Rename the factory return type: what `createPGliteBridge()` resolves
  to is now exported as `CreatePGliteBridge` (was `PGliteBridge`). The
  `PGliteBridge` name is now reserved for the new class-form export.

  **Migration:** rename type imports of `PGliteBridge` (the factory
  return) to `CreatePGliteBridge`. Runtime behavior unchanged.

- [`5ca2c58`](https://github.com/drudolf/prisma-pglite-bridge/commit/5ca2c58d0bee0f8de928750acd3a1f57428d4430) Thanks [@drudolf](https://github.com/drudolf)! - Rename `CreatePGliteBridgeOptions` to `PGliteBridgeOptions`. The
  options interface for `createPGliteBridge` now matches the
  `PGliteBridge` return type — both share the `PGliteBridge` prefix.

  **Migration:** rename any imports of `CreatePGliteBridgeOptions`
  to `PGliteBridgeOptions`. Behavior is unchanged.

- [`5ca2c58`](https://github.com/drudolf/prisma-pglite-bridge/commit/5ca2c58d0bee0f8de928750acd3a1f57428d4430) Thanks [@drudolf](https://github.com/drudolf)! - Rename `createPool`'s module and options interface:
  `src/create-pool.ts` → `src/pool.ts`, `CreatePoolOptions` →
  `PoolOptions`. Aligns with the `create-pglite-bridge` →
  `pglite-bridge` rename.

  **Migration:** rename imports of `CreatePoolOptions` to
  `PoolOptions`. Behavior unchanged.

- [`7258c12`](https://github.com/drudolf/prisma-pglite-bridge/commit/7258c1280d9f825754207abd6e41f6ea966a87b4) Thanks [@drudolf](https://github.com/drudolf)! - Remove the `ppb` CLI. The `bin/ppb.ts` entry point and the
  published `ppb` binary are gone, along with the `citty` runtime
  dependency.

  **Migration:** spin up a `PGliteServer` and pass its URL to the
  Prisma CLI. The `prisma db push --url <url>` flow covers the same
  ground:

  ```ts
  import { PGlite } from "@electric-sql/pglite";
  import { PGliteServer } from "prisma-pglite-bridge";

  const server = new PGliteServer({ pglite: new PGlite() });
  const url = await server.listen();
  // run: prisma db push --url "$url"
  ```

- [`148391b`](https://github.com/drudolf/prisma-pglite-bridge/commit/148391b971374871e110272bb93eec177a12f46a) Thanks [@drudolf](https://github.com/drudolf)! - Drop the `SchemaTarget` indirection from `pushMigrations`,
  `pushSchema`, and `resetSchema`. Each function now takes the
  underlying handle directly:

  - `pushMigrations(pglite, options)` — was `pushMigrations(bridge, options)`
  - `pushSchema(adapter, options)` — was `pushSchema(bridge, options)`
  - `resetSchema(adapter)` — was `resetSchema(bridge)`

  `pushMigrations` runs raw SQL through `pglite.exec`, so it now
  asks for the `PGlite` instance. `pushSchema` and `resetSchema`
  go through the Prisma WASM engine, so they take the `PrismaPg`
  adapter directly. The wrapper that accepted either a bridge or
  a raw handle is gone.

  The snapshot manager now self-heals when the `_pglite_snapshot`
  schema is dropped externally (e.g. during a schema reset),
  removing the cross-module `resetSnapshot` carve-out previously
  needed in `resetSchema`.

  **Migration:**

  ```ts
  // before
  await pushMigrations(bridge, { migrationsPath: "./prisma/migrations" });
  await pushSchema(bridge, { schema });
  await resetSchema(bridge);

  // after
  await pushMigrations(pglite, { migrationsPath: "./prisma/migrations" });
  await pushSchema(bridge.adapter, { schema });
  await resetSchema(bridge.adapter);
  ```

- [`56354c1`](https://github.com/drudolf/prisma-pglite-bridge/commit/56354c1a0617166f5719e7a3de4c41392e0a49e7) Thanks [@drudolf](https://github.com/drudolf)! - Add `PGliteServer` — a TCP or Unix-socket listener that exposes a
  PGlite instance to standard Postgres clients (`psql`, Prisma CLI
  shadow DB, DBeaver, Studio). The constructor is synchronous; the
  network bind happens in an explicit async `listen()` (mirroring
  `net.Server`'s API), which awaits `pglite.waitReady` internally and
  resolves to a `postgres://` connection URL.

  ```ts
  import { PGlite } from "@electric-sql/pglite";
  import { PGliteServer } from "prisma-pglite-bridge";

  const server = new PGliteServer({ pglite: new PGlite() });
  const url = await server.listen();
  // → postgres://postgres@127.0.0.1:54321/postgres
  ```

  Pass `dataDir` (and optional `port`, default `5432`) for a Unix
  socket — the library binds the libpq-conventional path
  `<dataDir>/.s.PGSQL.<port>` so clients connect with just
  `host=<dataDir>`. Otherwise binds TCP loopback on `host`
  (default `127.0.0.1`) and `port` (default `0`, ephemeral).
  Each accepted socket gets its own `PGliteDuplex` sharing a single
  `SessionLock`, so transactions across connections serialize correctly.
  No auth — intended for development and the Prisma `migrate dev`
  shadow DB.

  Also: `PGliteDuplex` now rolls back any open transaction on `_final`,
  `_destroy`, and `Terminate`. Transaction detection lives on the duplex
  itself (via the last observed ReadyForQuery status), not on
  `SessionLock`, so cleanup runs for both locked pools (`max>1`, TCP
  server) and standalone duplexes (default `max=1` pool). Awaiting any
  in-flight `pglite.execProtocolRawStream` call before deciding closes
  the BEGIN-in-flight race where ownership had not yet been recorded.
  A client disconnect mid-transaction — Terminate, hard-disconnect, or
  `pool.release(err)` — no longer leaks `T` state into the next
  connection.

### Patch Changes

- [`3eb6388`](https://github.com/drudolf/prisma-pglite-bridge/commit/3eb638870a636f95fd79337ad435b25f264cf2ee) Thanks [@drudolf](https://github.com/drudolf)! - Add `cli-compat` test project covering `PGliteServer` end-to-end
  through real CLI binaries:

  - `psql` (skipped when not installed)
  - `prisma db push`, `db pull`, `db execute`
  - `prisma migrate dev` (multi-migration), `migrate deploy`,
    `migrate reset`, `migrate status` — Prisma 7, with the shadow
    database backed by a second `PGliteServer` instance

  Run with `pnpm test:cli-compat`. Tests are scoped to their own
  vitest project so the default suite stays fast.

- [`fa55dc6`](https://github.com/drudolf/prisma-pglite-bridge/commit/fa55dc64f44821d8db471561d1074cd197ad2d13) Thanks [@drudolf](https://github.com/drudolf)! - Internal refactor: split the 1109-line `pglite-duplex` module into a
  `src/duplex/` folder with focused units (constants, RowDescription
  rewrite, `FrontendMessageBuffer`, `BackendMessageFramer`,
  `PGliteDuplex`). Tests are co-located per unit. Public API is
  unchanged — `PGliteDuplex` is still exported from the package root.

- [`0c56668`](https://github.com/drudolf/prisma-pglite-bridge/commit/0c5666844549604b965029c88a2e46bb83b6f28e) Thanks [@drudolf](https://github.com/drudolf)! - Internal cleanup flagged by knip:

  - Drop `export` on six frontend message-type constants in
    `src/duplex/constants.ts` (`PARSE`, `BIND`, `DESCRIBE`,
    `EXECUTE`, `CLOSE`, `FLUSH`) — only used to build
    `EQP_MESSAGES` inside the same file.
  - Fold `src/duplex/pglite-duplex.ts` into `src/duplex/index.ts`,
    the only remaining content of the duplex barrel. Dead
    re-exports of `BackendMessageFramer` and `FrontendMessageBuffer`
    removed (consumers and tests already imported them directly
    from their unit files).

  Public API is unchanged — `PGliteDuplex` is still exported from
  the package root via `./duplex/index.ts`.

- [`5ca2c58`](https://github.com/drudolf/prisma-pglite-bridge/commit/5ca2c58d0bee0f8de928750acd3a1f57428d4430) Thanks [@drudolf](https://github.com/drudolf)! - Internal refactor: move `PgBridgeClient` from `src/` into
  `src/utils/`, alongside the related primitives (`bridge-stats`,
  `session-lock`). Public API is unchanged.

- [`5ca2c58`](https://github.com/drudolf/prisma-pglite-bridge/commit/5ca2c58d0bee0f8de928750acd3a1f57428d4430) Thanks [@drudolf](https://github.com/drudolf)! - Internal refactor: rename `BridgeClient` to `PgBridgeClient` (and the
  matching file, types, and options symbol). The class extends
  `pg.Client`; the `Pg` prefix marks it as the pg-flavored variant.
  The standalone `bridgeClientOptionsKey` export is now a
  `PgBridgeClient.OptionsKey` static property. Public API is unchanged
  — neither name was exported from the package root.

- [`5ca2c58`](https://github.com/drudolf/prisma-pglite-bridge/commit/5ca2c58d0bee0f8de928750acd3a1f57428d4430) Thanks [@drudolf](https://github.com/drudolf)! - Internal consistency: align `Pglite` identifiers with the canonical
  `PGlite` casing across test helpers, benchmark instrumentation, and
  local variables. No public API changes.

## 0.6.1

### Patch Changes

- [`d5901e8`](https://github.com/drudolf/prisma-pglite-bridge/commit/d5901e88d066f381d62df3ecc80c6212df5e0437) Thanks [@drudolf](https://github.com/drudolf)! - Fix `resetDb` failing with `relation "..._id_seq" does not exist` when a
  schema uses `SERIAL` / `@default(autoincrement())` on a mixed-case table.
  `snapshotDb` captured sequence names without `quote_ident`, so the
  `setval` regclass argument was case-folded to lowercase on reset.

## 0.6.0

### Minor Changes

- [`4701048`](https://github.com/drudolf/prisma-pglite-bridge/commit/4701048905957ee6321b6dda394d16fec02418ca) Thanks [@drudolf](https://github.com/drudolf)! - Add the `ppb` CLI with `db-push` and `db-reset` subcommands. Applies a
  Prisma schema to a PGlite database in-process via the
  `@prisma/schema-engine-wasm` engine — no native schema-engine binary,
  no Docker. Reads `DATABASE_URL` as a `pglite://` URL or accepts
  `--data-dir` directly.

- [`225ed69`](https://github.com/drudolf/prisma-pglite-bridge/commit/225ed69bebe8d35dba0fa2fe5a5704cd81ded887) Thanks [@drudolf](https://github.com/drudolf)! - Add `pushSchema` and `resetSchema` helpers that apply a Prisma schema to a
  PGlite database in-process via `@prisma/schema-engine-wasm` — no native
  schema-engine binary, no TCP. The WASM module is loaded lazily, so consumers
  who only use `createPGliteBridge` pay no init cost.

- [`870a878`](https://github.com/drudolf/prisma-pglite-bridge/commit/870a878de685fb6063747e656a338f88e5cfaa7b) Thanks [@drudolf](https://github.com/drudolf)! - Rename the public surface to better reflect what each piece returns.

  The factory function and its return type now use `Bridge` (since the
  returned bundle holds the Prisma adapter, the underlying PGlite
  instance, and lifecycle helpers — not just an adapter), while the
  underlying `Duplex` stream that replaces `pg.Client`'s socket is now
  named `Duplex`. Casing matches `@electric-sql/pglite`'s `PGlite`.

  Renames:

  - `createPgliteAdapter` → `createPGliteBridge`
  - `CreatePgliteAdapterOptions` → `CreatePGliteBridgeOptions`
  - `PgliteAdapter` (returned type) → `PGliteBridge`
  - `PGliteBridge` (Duplex stream class) → `PGliteDuplex`
  - `PgliteAdapterLeakWarning` (process warning type) → `PGliteBridgeLeakWarning`
  - `emitAdapterLeakWarning` (internal) → `emitBridgeLeakWarning`

  Migration:

  ```diff
  - import { createPgliteAdapter, PGliteBridge } from 'prisma-pglite-bridge';
  + import { createPGliteBridge, PGliteDuplex } from 'prisma-pglite-bridge';

  - const pgliteAdapter = await createPgliteAdapter({ pglite });
  + const bridge = await createPGliteBridge({ pglite });
  - const prisma = new PrismaClient({ adapter: pgliteAdapter.adapter });
  + const prisma = new PrismaClient({ adapter: bridge.adapter });
  ```

- [`788a855`](https://github.com/drudolf/prisma-pglite-bridge/commit/788a8552ab64acd4c585a29d43fa53000812017f) Thanks [@drudolf](https://github.com/drudolf)! - Split migration application out of `createPGliteBridge` into a new
  `pushMigrations(target, options)` helper, sibling to `pushSchema`.

  `createPGliteBridge` no longer accepts `sql`, `migrationsPath`, or
  `configRoot` — call `pushMigrations` on the returned bridge instead.
  The new helper avoids loading `@prisma/schema-engine-wasm`, so projects
  that only replay pre-generated migrations no longer trigger Node's
  `ExperimentalWarning: Importing WebAssembly module instances`.

  The returned `PGliteBridge` now exposes the underlying `pglite`
  instance for symmetry with `pushSchema` / `pushMigrations`.

  Breaking changes:

  - `createPGliteBridge({ sql | migrationsPath | configRoot })` is no
    longer supported. Migrate by chaining a `pushMigrations(bridge, {
... })` call after `createPGliteBridge`.
  - `Stats.schemaSetupMs` has been removed. `pushMigrations` returns
    `{ durationMs }` for callers who want to record the cost.

### Patch Changes

- [`cb44861`](https://github.com/drudolf/prisma-pglite-bridge/commit/cb44861d28d364c26ed7276195a55242bc399410) Thanks [@drudolf](https://github.com/drudolf)! - Unify the fast and slow RowDescription rewrite paths in
  `BackendMessageFramer` behind a single `emitRewrittenRowDescription(buf)`
  helper. Removes a redundant guard, an unsafe `as Buffer` cast, and a
  dead state-reset; behavior is unchanged.

- [`6501576`](https://github.com/drudolf/prisma-pglite-bridge/commit/65015764e63a7abf5e20a922cb080cef2e2408d6) Thanks [@drudolf](https://github.com/drudolf)! - Rewrite RowDescription frames to widen `"char"` (oid 18) → `text` (oid 25)
  so the official `@prisma/adapter-pg` can decode `pg_catalog` system columns
  (e.g. `pg_constraint.contype`). This unblocks running the WASM schema engine
  (`@prisma/schema-engine-wasm`) against the bridge — i.e. an in-process
  `prisma db push` path without TCP or a Prisma-version-coupled adapter.

## 0.5.3

### Patch Changes

- [`633421c`](https://github.com/drudolf/prisma-pglite-bridge/commit/633421c330229bd19a6ec43f1728880c9a5b7acb) Thanks [@drudolf](https://github.com/drudolf)! - Internal refactor: unify `runPipelineBatch` and `execAndPush` into a single `streamProtocol` method. The two methods were byte-identical except for one boolean (`suppressIntermediateReadyForQuery`). No behavior change.

## 0.5.2

### Patch Changes

- [`6c54b38`](https://github.com/drudolf/prisma-pglite-bridge/commit/6c54b38355292050b70f6513c65f3d6c6de97224) Thanks [@drudolf](https://github.com/drudolf)! - Serialize `pg.Client.query` submissions in the bridge's Client subclass so
  upstream fan-out (notably Prisma's readback phase on `create` with multi-
  relation `include`, or `Promise.all` inside an interactive `$transaction`)
  never trips pg's "client.query() while another query is executing"
  deprecation warning. Promise- and callback-form queries are chained through
  a per-Client submission queue; the Submittable form (pg.Query, cursors,
  streaming) is passed through unserialized to preserve its event contract.

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
