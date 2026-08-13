/**
 * Vitest failure-hook wiring for the on-failure query trail (design:
 * .claude/plans/query-trail-design.md §5). Shared, Prisma-free, so both the
 * pool and bridge helper entries can install it without breaking pool purity.
 *
 * On a test failure the hook reads the captured entries and meta
 * SYNCHRONOUSLY — before any fixture teardown (`resetDb`, pool close) can run
 * — formats them (human by default, JSONL under
 * `PGLITE_BRIDGE_TRAIL_FORMAT=json`), and writes the result to stderr with the
 * failing test's name. Passing tests print nothing. Capture and printing are
 * both suppressed by `queryTrail: false` and by the `PGLITE_BRIDGE_QUERY_TRAIL=0`
 * env kill switch (which wins over the helper option).
 */
import { onTestFailed } from 'vitest';
import type { QueryTrailEntry, QueryTrailMeta, QueryTrailOptions } from '../pool/query-trail.ts';
import { formatQueryTrail } from '../pool/query-trail-format.ts';

/** The trail surface the fixtures expose — satisfied by both `PgBridgePool`
 *  and `PGliteBridge`. */
export interface QueryTrailSource {
  queryTrail(): readonly QueryTrailEntry[];
  clearQueryTrail(): void;
  queryTrailMeta(): QueryTrailMeta;
}

/** The pool/bridge-level `queryTrail` option form — a boolean or the config
 *  object (`{ maxEntries, maxParamChars, redactParams }`). */
export type PoolTrailOption = boolean | QueryTrailOptions | undefined;

/** The helper's resolved trail decision: the value to write into the
 *  pool/bridge `queryTrail` option ({@link PoolTrailOption} — an object is
 *  passed through UNCHANGED so its settings survive), and whether capture is
 *  on for this run (drives the per-test clear + failure-hook wiring). */
export interface ResolvedTrail {
  effective: PoolTrailOption;
  on: boolean;
}

/**
 * Resolve the effective `queryTrail` value for a helper-managed pool/bridge,
 * honouring the design precedence (highest wins): `PGLITE_BRIDGE_QUERY_TRAIL=0`
 * env kill switch → explicit helper option → pool/bridge option → helper
 * default ON.
 *
 * The subtlety this pins (and the review's CWE-665 finding): the helper must
 * NOT clobber a user's object-form pool option with a bare boolean — a
 * `queryTrail: { redactParams: true }` on the pool has to survive so its
 * settings take effect. So:
 *  - env `'0'` → off, regardless of anything;
 *  - helper option explicitly `false` → off, regardless of the pool option;
 *  - helper option explicitly `true` → on, preserving a pool OBJECT's settings
 *    (a non-object pool value becomes a plain `true`);
 *  - helper option unset → the pool/bridge option governs (object or boolean)
 *    if present;
 *  - nothing set anywhere → helper default ON (plain `true`).
 */
export const resolveHelperTrail = (
  helperOption: boolean | undefined,
  poolOption: PoolTrailOption,
): ResolvedTrail => {
  if (process.env.PGLITE_BRIDGE_QUERY_TRAIL === '0') return { effective: false, on: false };
  if (helperOption === false) return { effective: false, on: false };
  if (helperOption === true) {
    // Explicit helper-on wins, but a pool OBJECT keeps its settings.
    const effective: PoolTrailOption = typeof poolOption === 'object' ? poolOption : true;
    return { effective, on: true };
  }
  // Helper option unset: the pool/bridge option governs when present.
  if (poolOption !== undefined) return { effective: poolOption, on: poolOption !== false };
  // Nothing set anywhere: helper default ON.
  return { effective: true, on: true };
};

/**
 * Register `onTestFailed` for the current test: on failure, read the trail
 * synchronously and print it to stderr under the failing test's name. Call
 * from a fixture AFTER the per-test `clearQueryTrail()`, so the printed trail
 * carries only the failing test's own traffic. No-op registration when the
 * trail is disabled — the caller gates on {@link resolveHelperTrail} first.
 */
export const registerTrailFailureHook = (source: QueryTrailSource): void => {
  /* v8 ignore start — the callback fires only on a REAL test failure, which the fast in-process suite (passing helper tests) never triggers; its behavior is pinned end-to-end by the hermetic child-vitest failure runs in query-trail.*-vitest.test.ts, whose separate-process coverage the parent does not collect */
  onTestFailed((context) => {
    // Read BEFORE teardown: entries + meta are in-memory arrays; a later
    // resetDb/close would clear them.
    const entries = source.queryTrail();
    const meta = source.queryTrailMeta();
    const format = process.env.PGLITE_BRIDGE_TRAIL_FORMAT === 'json' ? 'json' : 'human';
    process.stderr.write(
      `${formatQueryTrail(entries, meta, { testName: context.task.name, format })}\n`,
    );
  });
  /* v8 ignore stop */
};
