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
import type { QueryTrailEntry, QueryTrailMeta } from '../pool/query-trail.ts';
import { formatQueryTrail } from '../pool/query-trail-format.ts';

/** The trail surface the fixtures expose — satisfied by both `PgBridgePool`
 *  and `PGliteBridge`. */
export interface QueryTrailSource {
  queryTrail(): readonly QueryTrailEntry[];
  clearQueryTrail(): void;
  queryTrailMeta(): QueryTrailMeta;
}

/** Whether the helper should capture and print at all: the env kill switch
 *  wins over the helper option (`env > helper option`); the helper option only
 *  disables when explicitly `false`, defaulting ON. */
export const trailEnabled = (option: boolean | undefined): boolean =>
  option !== false && process.env.PGLITE_BRIDGE_QUERY_TRAIL !== '0';

/**
 * Register `onTestFailed` for the current test: on failure, read the trail
 * synchronously and print it to stderr under the failing test's name. Call
 * from a fixture AFTER the per-test `clearQueryTrail()`, so the printed trail
 * carries only the failing test's own traffic. No-op registration when the
 * trail is disabled — the caller gates on {@link trailEnabled} first.
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
