# Stats and diagnostics

Two paths for inspecting the bridge at runtime:

- [Stats collection](#stats-collection) — opt-in snapshot at the
  end of a test run; lowest friction.
- [Diagnostics channels](#diagnostics-channels) — live per-event
  stream via `node:diagnostics_channel`; more advanced, more
  flexible.

## Stats collection

For most developers, this is the easiest way to see how the bridge
performed in tests.

Enable `statsLevel` when creating the bridge, run your tests, then
call `await stats()` at the end. You get one snapshot with the main
things you usually care about: query counts, timing percentiles,
database size, and, at `'full'`, process RSS and session-lock wait
times.

This is the built-in, low-friction path for test diagnostics. It is
useful for CI cost insight, perf tuning, and understanding test-suite
behavior without wiring up a separate metrics pipeline. **Off by
default**; the hot path stays effectively zero-cost as long as no
external consumer subscribes to the public
[diagnostics channels](#diagnostics-channels).

```typescript
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const bridge = new PGliteBridge({ statsLevel: 'basic' }); // or 'full'
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });

afterAll(async () => {
  await prisma.$disconnect();
  await bridge.close(); // closes pool + pglite (bridge owns it)
  const s = await bridge.stats();
  if (s) console.log(s);
});
```

`stats()` returns `Promise<Stats | undefined>` — `undefined` when
`statsLevel` is `'off'` (or omitted). Safe to call before or after
`close()`; post-close reads return frozen values from the moment
`close()` was invoked.

If you need live per-query or per-lock-wait events instead of a final
snapshot, use the public [diagnostics channels](#diagnostics-channels)
described below. That path is more flexible, but also more advanced.

### Levels

**`'basic'`** — timing and counters:

- `durationMs` — bridge lifetime (frozen at `close()`, drain
  excluded)
- `queryCount`, `failedQueryCount` — WASM round-trips (a Prisma
  extended-query pipeline is one round-trip, not five). Lifetime
  counters.
- `totalQueryMs`, `avgQueryMs` — lifetime sum and mean of query
  durations
- `recentP50QueryMs`, `recentP95QueryMs`, `recentMaxQueryMs` —
  nearest-rank percentiles (no interpolation) over the most recent
  ~10,000 queries. On long-lived bridges these describe a different
  population than `avgQueryMs`.
- `resetDbCalls` — counts `resetDb()` attempts
- `dbSizeBytes` — `pg_database_size(current_database())`, cached
  at close

**`'full'`** — adds:

- `processRssPeakBytes` — process-wide RSS peak, read from
  `process.resourceUsage().maxRSS` (kernel-tracked, lossless) at
  the moment `stats()` is called. Contaminated if unrelated work
  shares the process — use as an ordering signal, not an absolute
  measurement. `undefined` on runtimes without
  `process.resourceUsage` (Bun, Deno, edge workers).
- `totalSessionLockWaitMs`, `sessionLockAcquisitionCount`,
  `avgSessionLockWaitMs`, `maxSessionLockWaitMs` — session-lock
  contention across pool connections

`statsLevel` is echoed on the returned object. Any field typed
`T | undefined` in the returned `Stats` is the exhaustive list of
fields that can be missing — `dbSizeBytes` if `pg_database_size`
rejects, `processRssPeakBytes` on runtimes without
`process.resourceUsage`. Every other field is always defined.

## Diagnostics channels

The bridge publishes per-query and per-lock-wait events to
[`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
channels. Built-in bridge stats are updated directly by the bridge
when `statsLevel` is `'basic'` or `'full'`; external consumers (OpenTelemetry, APM,
custom loggers) can subscribe directly without touching the bridge
API.

Publication is gated by `channel.hasSubscribers`, so when nobody
is listening the hot path pays no timing or payload cost.
Subscribing opts you in to that work.

```typescript
import diagnostics_channel from 'node:diagnostics_channel';
import {
  PGliteBridge,
  QUERY_CHANNEL,
  type QueryEvent,
} from 'prisma-pglite-bridge';

const { bridgeId } = new PGliteBridge({ /* ... */ });

const listener = (msg: unknown) => {
  const e = msg as QueryEvent;
  if (e.bridgeId !== bridgeId) return;
  myMetrics.record('db.query', e.durationMs, { ok: e.succeeded });
};
diagnostics_channel.channel(QUERY_CHANNEL).subscribe(listener);
```

Channels:

- `QUERY_CHANNEL` (`prisma-pglite-bridge:query`) — every
  whole-query boundary. Payload: `{ bridgeId: symbol; durationMs:
  number; succeeded: boolean }`. `succeeded` is `false` for both
  thrown errors and protocol-level `ErrorResponse` frames.
- `LOCK_WAIT_CHANNEL` (`prisma-pglite-bridge:lock-wait`) — every
  session-lock acquisition. Payload: `{ bridgeId: symbol;
  durationMs: number }`. `durationMs` is how long the acquirer
  waited before the lock was granted.

Filter on `bridgeId` to isolate events when multiple bridges
share a process. Read it from `bridge.bridgeId` (on
`PGliteBridge`) or `pool.bridgeId` (on `PgBridgePool`).
