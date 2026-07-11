import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { PgBridgePool } from './index.ts';

// One shared PGlite for the whole file instead of a fresh ~1s cold boot per
// test. Each test builds its own pool (its own SessionLock), so no lock state
// leaks between tests. The afterEach below returns the shared session to a
// clean slate: ROLLBACK (swallowed — no-op when idle), DROP all public tables
// (loud), DISCARD ALL (loud — also DEALLOCATEs named statements and CLOSEs
// suspended portals). The barrier query after pool.end() drains any in-flight
// teardown ROLLBACK before the reset runs.
const pglite = await setupPGlite({ reset: false });

const endPool = async (pool: PgBridgePool): Promise<void> => {
  await pool.end().catch(() => {});
  // Teardown barrier: a _destroy ROLLBACK may still be settling inside
  // PGlite's runExclusive; serializing behind it is deterministic, not a race.
  await pglite.query('SELECT 1').catch(() => {});
};

afterEach(async () => {
  await pglite.query('ROLLBACK').catch(() => {});
  const { rows } = await pglite.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'",
  );
  for (const { t } of rows) {
    await pglite.exec(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  await pglite.exec('DISCARD ALL');
});

// Per-client statement-name scoping (ADR 002): every PgBridgeClient names
// statements in its own process-unique namespace (`ppb_<namespace>_<n>`), so
// bridge-injected Parses can never collide across clients, pools, or client
// generations — no epoch, no suspension, no coordination. Session-wide
// DEALLOCATE/DISCARD through any pool client evicts matching entries from
// EVERY live client's pg parse cache via the live-client registry.
describe('PgBridgePool — per-client statement names', () => {
  const swallowSharedWarning = (w: Error): void => {
    if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
  };

  it('two unawaited queries after a sibling departs stay cached — reusing the first shape succeeds', async () => {
    // Defect 1 regression: the removed #prefixDeallocAll machinery wrapped
    // BOTH queries of one synchronous tick with a DEALLOCATE ALL after a
    // sibling pool departed; the second wipe destroyed the first query's
    // just-Parsed statement, so a third query reusing that shape failed
    // with 26000. Per-client names need no post-departure cleanup at all.
    process.on('warning', swallowSharedWarning);
    const poolA = new PgBridgePool({ pglite });
    let a: pg.PoolClient | undefined;
    try {
      a = await poolA.connect();
      // Establish the client and its cache before the sibling churn.
      await a.query({ text: 'SELECT 1 AS one', values: [] });

      const poolB = new PgBridgePool({ pglite });
      try {
        await poolB.query('SELECT 1');
      } finally {
        await endPool(poolB);
      }

      // Two queries in one synchronous tick, unawaited — in-contract usage:
      // the submission chain keeps same-client queries ordered.
      const first = a.query({ text: 'SELECT 21 AS x', values: [] });
      const second = a.query({ text: 'SELECT 22 AS y', values: [] });
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.rows).toEqual([{ x: 21 }]);
      expect(secondResult.rows).toEqual([{ y: 22 }]);

      // Reuse the FIRST query's shape: its cached statement must still exist.
      const third = await a.query({ text: 'SELECT 21 AS x', values: [] });
      expect(third.rows).toEqual([{ x: 21 }]);
    } finally {
      a?.release();
      process.off('warning', swallowSharedWarning);
      await endPool(poolA);
    }
  });

  it('DISCARD ALL through the pool evicts the cache — the repeat query re-Parses and succeeds', async () => {
    // Defect 2 regression: DISCARD ALL includes DEALLOCATE-ALL semantics,
    // but the old detection matched only DEALLOCATE — PGlite forgot the
    // statements while pg's parse-skip cache kept them, permanently
    // poisoning the client (every warm shape failed 26000 thereafter).
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const shape = { text: 'SELECT 32 AS n', values: [] };
        await client.query(shape); // below the K=2 gate — unnamed
        await client.query(shape); // promoted — named + Parsed
        parseSpy.mockClear();
        await client.query(shape);
        expect(parseSpy).not.toHaveBeenCalled(); // warm — cache active

        await client.query('DISCARD ALL');

        parseSpy.mockClear();
        const result = await client.query(shape);
        expect(parseSpy).toHaveBeenCalledTimes(1); // re-Parse, not skip → 26000
        expect(result.rows).toEqual([{ n: 32 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('zombie-client connect race: a successor pool queries the same SQL while the old client is still ending', async () => {
    // Defect 3 regression: pg-pool resolves pool.end()'s promise BEFORE
    // client.end()'s callback fires, so a successor pool's first client can
    // connect while liveClientCounts still counts the zombie — the 0→1
    // DEALLOCATE ALL is skipped. Under the removed shared generator the same
    // SQL mapped to a name PGlite still held → 42P05. Per-client names make
    // the skipped cleanup benign (a bounded leak, not an error). Reproduced
    // deterministically by delaying the dying client's end() by 300 ms.
    const poolA = new PgBridgePool({ pglite });
    const clients: pg.Client[] = [];
    poolA.on('connect', (client) => {
      clients.push(client as unknown as pg.Client);
    });
    try {
      const shape = { text: 'SELECT 31 AS n', values: [] };
      await poolA.query(shape); // below the K=2 gate — unnamed
      await poolA.query(shape); // pool A Parses its name into the session

      const dying = clients[0];
      if (dying === undefined) throw new Error('pool A client was not captured');
      // Delay the client's teardown. pg-pool calls client.end(cb) — keep the
      // callback (and promise form) working, just 300 ms later.
      const originalEnd = dying.end.bind(dying) as (...endArgs: unknown[]) => unknown;
      dying.end = ((...endArgs: unknown[]) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            void Promise.resolve(originalEnd(...endArgs)).then(() => resolve());
          }, 300);
        })) as pg.Client['end'];
      const removed = new Promise<void>((resolve) => {
        poolA.once('remove', () => resolve());
      });

      const endP = poolA.end();

      // Successor pool queries the SAME SQL immediately, while the zombie
      // client's delayed end() is still pending.
      const poolB = new PgBridgePool({ pglite });
      try {
        const result = await poolB.query(shape);
        expect(result.rows).toEqual([{ n: 31 }]); // no 42P05
      } finally {
        await endP;
        await removed; // zombie fully torn down before PGlite closes
        await endPool(poolB);
      }
    } finally {
      await pglite.query('SELECT 1').catch(() => {});
    }
  });

  it('a racing warm query hit by a concurrent DEALLOCATE ALL fails clean (26000 at worst) and self-heals', async () => {
    // Design test 8 (tribunal-mandated; gates the preparedStatements default
    // flip): client B's warm named query already in flight when client A's
    // DEALLOCATE ALL lands may fail — but only with a clean, transient
    // 26000. Registry eviction runs when the DEALLOCATE resolves, so B's
    // NEXT repeat query re-Parses and succeeds.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      const shape = { text: 'SELECT 51 AS n', values: [] };
      await b.query(shape); // below the K=2 gate — unnamed
      await b.query(shape); // warm B's cache — Parse is skipped from here on

      // Fire the dealloc first, then B's warm query in the same tick, so
      // the DEALLOCATE has the best chance to land before B's Bind.
      const deallocP = a.query('DEALLOCATE ALL');
      const racingSettled = Promise.allSettled([b.query(shape)]);
      await deallocP;
      const [outcome] = await racingSettled;

      if (outcome.status === 'fulfilled') {
        // B's Bind won the race — the query simply succeeds.
        expect(outcome.value.rows).toEqual([{ n: 51 }]);
      } else {
        // The ONLY acceptable failure: a clean 26000 — no corruption, no hang.
        expect((outcome.reason as { code?: string }).code).toBe('26000');
      }

      // Self-healing: eviction already propagated to B, so its next repeat
      // query re-Parses and succeeds.
      parseSpy.mockClear();
      const healed = await b.query(shape);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(healed.rows).toEqual([{ n: 51 }]);
    } finally {
      a?.release();
      b?.release();
      await endPool(pool);
    }
  });

  it("evicts a statementCaching: false client's user-named statements on a sibling's DEALLOCATE ALL", async () => {
    // Design test 9 (tribunal-mandated): clients register in the live-client
    // registry regardless of statementCaching — a non-caching client still
    // holds user-named entries in pg's parse-skip cache that must be evicted
    // when a sibling wipes the shared session.
    process.on('warning', swallowSharedWarning);
    const nonCaching = new PgBridgePool({ pglite, statementCaching: false });
    const caching = new PgBridgePool({ pglite });
    let nc: pg.PoolClient | undefined;
    let c: pg.PoolClient | undefined;
    try {
      nc = await nonCaching.connect();
      c = await caching.connect();

      const named = { name: 'user_stmt', text: 'SELECT 61 AS n' };
      const cold = await nc.query(named);
      expect(cold.rows).toEqual([{ n: 61 }]);

      await c.query('DEALLOCATE ALL');

      // Without registry propagation pg would skip Parse for user_stmt and
      // PGlite would answer 26000. Eviction forces a clean re-Parse.
      const repeat = await nc.query(named);
      expect(repeat.rows).toEqual([{ n: 61 }]);
    } finally {
      nc?.release();
      c?.release();
      process.off('warning', swallowSharedWarning);
      await endPool(nonCaching);
      await endPool(caching);
    }
  });

  it('DISCARD ALL under max: 2 evicts both clients — both repeat queries re-Parse and succeed', async () => {
    // Design test 10 (tribunal-mandated): session-wide invalidation reaches
    // every live client of the pool, not only the issuer.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      const shape = { text: 'SELECT 71 AS n', values: [] };
      await a.query(shape);
      await a.query(shape); // past the K=2 gate — named + Parsed
      await b.query(shape);
      await b.query(shape); // both clients warm, distinct names

      await a.query('DISCARD ALL');

      parseSpy.mockClear();
      const repeatA = await a.query(shape);
      const repeatB = await b.query(shape);
      expect(repeatA.rows).toEqual([{ n: 71 }]);
      expect(repeatB.rows).toEqual([{ n: 71 }]);
      // Both clients re-Parsed their own name — the eviction reached the
      // non-issuing client too.
      expect(parseSpy).toHaveBeenCalledTimes(2);
    } finally {
      a?.release();
      b?.release();
      await endPool(pool);
    }
  });

  it('max: 2 caching — both clients cache the same SQL under distinct names: 2 cold Parses, 0 warm', async () => {
    // Design test 5: with per-client namespaces, multiple clients in one
    // pool cache the same SQL safely — no 42P05, no silent disable.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      const shape = { text: 'SELECT 81 AS n', values: [] };

      parseSpy.mockClear();
      const coldA = await a.query(shape);
      const coldA2 = await a.query(shape);
      const coldB = await b.query(shape);
      const coldB2 = await b.query(shape);
      expect(coldA.rows).toEqual([{ n: 81 }]);
      expect(coldA2.rows).toEqual([{ n: 81 }]);
      expect(coldB.rows).toEqual([{ n: 81 }]);
      expect(coldB2.rows).toEqual([{ n: 81 }]);
      // One Parse per client: the below-gate zero-values execution runs the
      // simple protocol (no Parse), the promoting execution Parses the
      // client-unique name.
      expect(parseSpy).toHaveBeenCalledTimes(2);

      // The same SQL landed under two distinct client-unique names.
      const { rows } = await pglite.query<{ name: string }>(
        'SELECT name FROM pg_prepared_statements',
      );
      const names = rows.map((row) => row.name).filter((name) => name.startsWith('ppb_'));
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      for (const name of names) expect(name).toMatch(/^ppb_\d+_\d+$/);

      parseSpy.mockClear();
      const warmA = await a.query(shape);
      const warmB = await b.query(shape);
      expect(warmA.rows).toEqual([{ n: 81 }]);
      expect(warmB.rows).toEqual([{ n: 81 }]);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      a?.release();
      b?.release();
      await endPool(pool);
    }
  });
});

// String-form parameterized queries — `query(text, values)` with a NON-EMPTY
// values array — get the same per-client statement-name injection as the
// object form when statement caching is on: sightings across both forms
// count toward one K=2 admission gate, and once promoted pg skips Parse on
// repeat executions via its parsedStatements guard. The rest of the string-form
// dispatch is deliberately untouched: `query(text)` and `query(text, [])`
// stay unnamed on the simple protocol, non-cacheable text is never named,
// and a statementCaching: false pool sees no normalization at all.
describe('PgBridgePool — string-form parameterized statement caching', () => {
  // Session-side proof of naming: injected names show up in
  // pg_prepared_statements on the same client. The introspection query
  // itself is string-form WITHOUT values, so it never appears in the list.
  const listBridgeStatements = async (client: pg.PoolClient): Promise<string[]> => {
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM pg_prepared_statements WHERE name LIKE 'ppb_%'",
    );
    return rows.map((row) => row.name);
  };

  it('caches string-form parameterized DML and skips Parse on the warm execution', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        parseSpy.mockClear();
        const belowGate = await client.query('SELECT $1::int AS n', [7]);
        const cold = await client.query('SELECT $1::int AS n', [7]);
        const warm = await client.query('SELECT $1::int AS n', [7]);

        expect(belowGate.rows).toEqual([{ n: 7 }]);
        expect(cold.rows).toEqual([{ n: 7 }]);
        expect(warm.rows).toEqual([{ n: 7 }]);
        // Two Parses total across three executions: the first sighting ran
        // as an unnamed extended query (below the K=2 gate), the second
        // named and parsed the statement, the third skipped Parse via pg's
        // parsedStatements guard — a cached plan, not a re-preparation.
        expect(parseSpy).toHaveBeenCalledTimes(2);

        // The statement is cached under a bridge-injected name.
        const names = await listBridgeStatements(client);
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/^ppb_\d+_\d+$/);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('reuses one cached statement across the string form and the object form', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        parseSpy.mockClear();
        // Same text, fresh values array per call: the name generator keys on
        // the SQL text, so both forms count toward ONE admission gate and
        // map to ONE statement name — the string form is the below-gate
        // sighting, the object form promotes and Parses, and a third call
        // (back on the string form) rides the shared cache with zero
        // further Parses.
        const viaString = await client.query('SELECT $1::int AS n', [8]);
        const viaObject = await client.query({ text: 'SELECT $1::int AS n', values: [8] });
        const warm = await client.query('SELECT $1::int AS n', [8]);

        expect(viaString.rows).toEqual([{ n: 8 }]);
        expect(viaObject.rows).toEqual([{ n: 8 }]);
        expect(warm.rows).toEqual([{ n: 8 }]);
        expect(parseSpy).toHaveBeenCalledTimes(2);
        expect(await listBridgeStatements(client)).toHaveLength(1);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('leaves a parameterless string-form query unnamed (simple protocol)', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const first = await client.query('SELECT 1 AS one');
        const second = await client.query('SELECT 1 AS one');

        expect(first.rows).toEqual([{ one: 1 }]);
        expect(second.rows).toEqual([{ one: 1 }]);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('leaves a string-form query with an empty values array unnamed (deliberate guard)', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        // values: [] means "simple protocol, no parameters" in pg — the
        // bridge must not promote it to a named extended-protocol query.
        const first = await client.query('SELECT 2 AS two', []);
        const second = await client.query('SELECT 2 AS two', []);

        expect(first.rows).toEqual([{ two: 2 }]);
        expect(second.rows).toEqual([{ two: 2 }]);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('runs a multi-statement string with an empty values array unnamed', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        // pg resolves multi-statement simple-protocol queries with an array
        // of results. Pinned here: it neither errors nor gets a name — an
        // EQP Parse would reject the multi-statement text outright.
        const result = await client.query('SELECT 1; SELECT 2', []);

        expect(Array.isArray(result)).toBe(true);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('leaves non-DML parameterized text unnamed (EXPLAIN)', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        // Extended protocol (values present) but not CACHEABLE_SQL — the
        // name generator must decline, on the string form like any other.
        const first = await client.query('EXPLAIN SELECT $1::int', [1]);
        const second = await client.query('EXPLAIN SELECT $1::int', [1]);

        expect(first.rows.length).toBeGreaterThan(0);
        expect(second.rows.length).toBeGreaterThan(0);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('names nothing on a statementCaching: false pool (string form included)', async () => {
    const pool = new PgBridgePool({ pglite, statementCaching: false });
    try {
      const client = await pool.connect();
      try {
        const first = await client.query('SELECT $1::int AS n', [7]);
        const second = await client.query('SELECT $1::int AS n', [7]);

        expect(first.rows).toEqual([{ n: 7 }]);
        expect(second.rows).toEqual([{ n: 7 }]);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('passes a null parameter through the string form', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const result = await client.query('SELECT $1::text AS v', [null]);
        expect(result.rows).toEqual([{ v: null }]);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });

  it('DEALLOCATE ALL evicts a string-form-cached statement — re-issue re-Parses', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        // Two cold executions carry the shape past the K=2 admission gate —
        // the second caches the statement under a bridge-injected name.
        await client.query('SELECT $1::int AS n', [7]);
        await client.query('SELECT $1::int AS n', [7]);

        // Session-wide wipe: PGlite forgets the statement. The eviction
        // machinery must drop pg's parse-skip entry for the string-form-
        // injected name too, or the re-issue would skip Parse straight
        // into Postgres error 26000.
        await client.query('DEALLOCATE ALL');

        parseSpy.mockClear();
        const reIssued = await client.query('SELECT $1::int AS n', [7]);
        expect(reIssued.rows).toEqual([{ n: 7 }]);
        expect(parseSpy).toHaveBeenCalledTimes(1);

        // The re-issue re-cached under a bridge-injected name.
        const names = await listBridgeStatements(client);
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/^ppb_\d+_\d+$/);
      } finally {
        client.release();
      }
    } finally {
      await endPool(pool);
    }
  });
});
