/**
 * Contract between the pg-ecosystem compatibility runner (`run.ts`) and
 * each probe module. A probe exercises one ecosystem package (or raw
 * protocol feature) against `PgBridgePool` and reports what worked —
 * the runner owns instance lifecycle, timeouts, and the matrix report,
 * so probes stay small and additive.
 *
 * Unlike the test suite, a failing probe does not fail the run: the
 * harness REPORTS compatibility, it does not gate CI. Adding a probe:
 * implement `CompatProbe` in a sibling file, register it in `run.ts`'s
 * PROBES map, add the package as a devDependency.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgBridgePool } from '../../src/pool';

type ProbeOutcome = {
  status: 'pass' | 'fail';
  /** One line per verified behavior, or the failure point. */
  details: string[];
};

export type CompatProbe = {
  /** Registry key and matrix row, e.g. 'pg-cursor'. */
  name: string;
  /** What the probe exercises — one line for the matrix. */
  summary: string;
  run(ctx: { pool: PgBridgePool; pglite: PGlite }): Promise<ProbeOutcome>;
};

/** Race a step against a deadline — COPY-class failure modes WEDGE
 *  rather than throw, and a wedged step must not hang the harness. */
export const withTimeout = async <T>(ms: number, label: string, p: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
