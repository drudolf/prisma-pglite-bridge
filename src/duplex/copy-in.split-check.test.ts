// Split-check: validates the copy-in ORACLE (the by-construction arbitraries
// helper), NOT production code, against real PGlite statement splitting. It
// imports no production module (no ./copy-in.ts), so a mutant of copy-in.ts can
// never be killed here — and every mutant-run would otherwise pay the WASM
// PGlite boot for nothing. It is therefore excluded from the mutation config
// (**/copy-in.split-check.test.ts) and runs only under normal `pnpm test`.
// See .claude/plans/mutation-testing-duplex-pool.md.
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SENTINEL, splitCheckScenarios } from './__tests__/copy-in-arbitraries.ts';

// ---------------------------------------------------------------------------
// PGlite split-check: validates the by-construction oracle's statement-split
// claims against the real backend. Every copy-in targets the guaranteed-
// missing sentinel relation so PG raises its ANALYSIS error and a COPY never
// reaches execution; preceding statements are side-effect-free SELECTs.
// ---------------------------------------------------------------------------

describe('PGlite split-check (oracle validation)', () => {
  const db = new PGlite();

  beforeAll(async () => {
    await db.waitReady;
  });

  afterAll(async () => {
    await db.close();
  });

  const scenarios = splitCheckScenarios().map((scenario) => [scenario.label, scenario] as const);

  it.each(scenarios)('%s', async (_label, scenario) => {
    if (scenario.expected.kind === 'all-succeed') {
      const results = await db.exec(scenario.text);
      // PGlite returns ONE empty result for a statement-free text (the
      // EmptyQueryResponse), so 0 expected statements map to 1 result.
      expect(results.length).toBe(Math.max(scenario.expected.statementCount, 1));
      return;
    }
    let caught: unknown;
    try {
      await db.exec(scenario.text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    if (scenario.expected.kind === 'copy-analysis-error') {
      expect(message).toContain(SENTINEL);
      expect(message).toContain('does not exist');
    } else {
      expect(message).toMatch(scenario.expected.pattern);
    }
  });

  it('the shared instance survived every probe', async () => {
    const { rows } = await db.query('SELECT 1 AS ok');
    expect(rows).toEqual([{ ok: 1 }]);
  });
});
