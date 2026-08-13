---
"prisma-pglite-bridge": minor
---

On-failure query trail. When a test fails, the `vitest` and `pool/vitest`
fixture helpers (`createBridgeTest`, `createPoolTest`) now print the
failing test's SQL to stderr — every query, its params, its error,
transaction boundaries — captured at the SQL boundary, scoped to that
test, on by default with zero configuration. Passing tests print nothing;
nothing is ever written to disk. The `<2%` p50 / `<0.05 ms` absolute
overhead budget is met (`pnpm bench:trail`), which is why capture defaults
on in the helpers.

New `queryTrail?: boolean | QueryTrailOptions` option on `PgBridgePool`
and `PGliteBridge` (default off at the raw layer; `{ maxEntries,
maxParamChars, redactParams }`), with `queryTrail()` / `queryTrailMeta()`
/ `clearQueryTrail()` accessors on both for the Jest/standalone path. The
`formatQueryTrail` formatter (human or JSONL) and its
`QueryTrailEntry`/`QueryTrailMeta`/`QueryTrailOptions`/`QueryTrailKind`/
`QueryTrailError`/`QueryTrailHandle`/`FormatQueryTrailOptions` types plus
`TRAIL_FORMAT_VERSION` are exported from both the root and `/pool` entries.
Two env switches: `PGLITE_BRIDGE_QUERY_TRAIL=0` disables capture and
printing suite-wide (kill switch, only ever disables), and
`PGLITE_BRIDGE_TRAIL_FORMAT=json` emits the failure printout as JSONL for
agents. `redactParams: true` renders every param `<redacted>` for CI
environments with durable, shared logs. Bridge-internal teardown
`ROLLBACK`s and per-test reset/seed traffic are deliberately excluded.
