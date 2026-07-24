import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { PgBridgePool } from './index.ts';

const pglite = await setupPGlite();

// Red-phase TDD spec for the FastQuery fast path in PgBridgeClient.
//
// `fastQueryPath` (default `true`) does not exist on PgBridgePoolOptions
// yet — the type errors and the failing describe-skip / plain-object
// assertions below are the expected red until the fast path lands. The
// fast path activates only for the exact shape @prisma/adapter-pg emits
// when statement caching names a query: non-empty `name`, string `text`,
// `rowMode: 'array'`, a `types.getTypeParser` function, values undefined
// or an Array, and none of binary/rows/portal/queryMode/callback/
// Submittable. Everything else stays on the stock pg path.
describe('PgBridgePool — fastQueryPath', () => {
  // Fast-shape query, adapter-pg style.
  const fastShapeQuery = () => ({
    name: 'fastq_shape',
    text: 'SELECT $1::int AS n',
    values: [7],
    rowMode: 'array' as const,
    types: pg.types,
  });

  it('skips Describe on the warm execution of a named array-mode query', async () => {
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        describeSpy.mockClear();
        const first = await client.query(fastShapeQuery());
        const second = await client.query(fastShapeQuery());

        expect(first.rows).toEqual([[7]]);
        expect(second.rows).toEqual([[7]]);
        // Cold execution describes once; the warm execution reuses the
        // cached fields and must not describe again.
        expect(describeSpy).toHaveBeenCalledTimes(1);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('keeps cold and warm result field metadata independently owned', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const first = await client.query(fastShapeQuery());
        const firstField = first.fields[0];
        if (firstField === undefined) throw new Error('cold FastQuery returned no fields');
        first.fields.push(firstField);
        firstField.name = 'poisoned';

        const second = await client.query(fastShapeQuery());

        expect.soft(second.fields).not.toBe(first.fields);
        expect.soft(second.fields[0]).not.toBe(firstField);
        expect(second.fields).toEqual([expect.objectContaining({ name: 'n', dataTypeID: 23 })]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('describes on every execution when fastQueryPath is disabled', async () => {
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite, fastQueryPath: false });
    try {
      const client = await pool.connect();
      try {
        describeSpy.mockClear();
        const first = await client.query(fastShapeQuery());
        const second = await client.query(fastShapeQuery());

        expect(first.rows).toEqual([[7]]);
        expect(second.rows).toEqual([[7]]);
        expect(describeSpy).toHaveBeenCalledTimes(2);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('returns a plain result object on the fast path, not a pg Result', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const result = await pool.query(fastShapeQuery());

      expect(result.constructor.name).not.toBe('Result');
      expect('rowAsArray' in result).toBe(false);
      // Exactly the FastQueryResult shape — no pg.Result internals.
      expect(result).toEqual({
        rows: [[7]],
        fields: [expect.objectContaining({ name: 'n', dataTypeID: 23 })],
        rowCount: 1,
        command: 'SELECT',
        oid: null,
      });
    } finally {
      await pool.end();
    }
  });

  it('returns a stock pg Result when fastQueryPath is disabled', async () => {
    const pool = new PgBridgePool({ pglite, fastQueryPath: false });
    try {
      const result = await pool.query(fastShapeQuery());

      expect(result.constructor.name).toBe('Result');
      expect('rowAsArray' in result).toBe(true);
      expect(result.rows).toEqual([[7]]);
    } finally {
      await pool.end();
    }
  });

  it('injects a name into unnamed DML once promoted and routes it through the fast path', async () => {
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        describeSpy.mockClear();
        // No `name` on a statementCaching pool → the generator names the
        // shape on its SECOND sighting (K=2 admission gate). The first
        // execution runs unnamed on the stock path (whose extended-protocol
        // flow Describes), the second is named and rides the fast path
        // (Describe populates #fieldsCache), the third is a warm fast query
        // that skips Describe entirely.
        const unnamed = {
          text: 'SELECT $1::int AS n',
          values: [7],
          rowMode: 'array' as const,
          types: pg.types,
        };
        const first = await client.query(unnamed);
        const second = await client.query(unnamed);
        const third = await client.query(unnamed);

        expect(describeSpy).toHaveBeenCalledTimes(2);
        expect(first.rows).toEqual([[7]]);
        expect(second.rows).toEqual([[7]]);
        expect(third.rows).toEqual([[7]]);
        expect(first.constructor.name).toBe('Result'); // below the gate — stock path
        expect(second.constructor.name).not.toBe('Result');
        expect(third.constructor.name).not.toBe('Result');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('re-sends Parse after DEALLOCATE ALL and succeeds (guards parsedStatements coupling)', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        // Cold execution — Parse is sent, statement lands in parsedStatements.
        await client.query(fastShapeQuery());
        parseSpy.mockClear();

        // Warm execution — pg skips Parse (parsedStatements guard).
        await client.query(fastShapeQuery());
        expect(parseSpy).not.toHaveBeenCalled();

        // Invalidate PGlite's copy of all named statements.
        await client.query('DEALLOCATE ALL');
        parseSpy.mockClear();
        describeSpy.mockClear();

        // Next execution must re-Parse. If #clearStatementCaches failed to
        // evict from pg's parsedStatements (e.g. due to a pg internal rename),
        // pg would skip Parse and PGlite would return error 26000.
        const result = await client.query(fastShapeQuery());
        expect(parseSpy).toHaveBeenCalledTimes(1);
        // The fields cache must be evicted too — a leftover #fieldsCache
        // entry would allow the Parse above but wrongly skip Describe.
        expect(describeSpy).toHaveBeenCalledTimes(1);
        expect(result.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('re-sends Parse only for the named statement after DEALLOCATE <name>', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const other = { ...fastShapeQuery(), name: 'fastq_keep' };
        // Prepare both statements, then warm them so Parse is skipped.
        await client.query(fastShapeQuery());
        await client.query(other);
        parseSpy.mockClear();

        // Deallocate one by name: PGlite forgets it, and #clearStatementCaches
        // must evict exactly that entry from parsedStatements/#fieldsCache.
        await client.query(`DEALLOCATE ${fastShapeQuery().name}`);

        // The deallocated statement re-Parses; the untouched one stays warm.
        const rePrepared = await client.query(fastShapeQuery());
        const stillWarm = await client.query(other);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(rePrepared.rows).toEqual([[7]]);
        expect(stillWarm.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('evicts a statement deallocated with different unquoted case (PG identifier folding)', async () => {
    // PostgreSQL folds unquoted identifiers to lowercase, so DEALLOCATE
    // FQ_FOLD deallocates fq_fold server-side. The eviction must fold the
    // captured name the same way, or pg's cache would keep fq_fold and the
    // next execution would skip Parse into a 26000.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const named = { ...fastShapeQuery(), name: 'fq_fold' };
        await client.query(named);

        await client.query('DEALLOCATE FQ_FOLD');

        parseSpy.mockClear();
        const result = await client.query(named);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(result.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('evicts a quoted statement name containing non-word characters', async () => {
    // Protocol-level statement names are byte-exact and may contain hyphens;
    // only a quoted identifier can DEALLOCATE them. The detection regex must
    // match the quoted form, or the eviction is skipped entirely and the
    // next execution skips Parse into a 26000.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const named = { ...fastShapeQuery(), name: 'fq-hyphen' };
        await client.query(named);

        await client.query('DEALLOCATE "fq-hyphen"');

        parseSpy.mockClear();
        const result = await client.query(named);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(result.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('cache survives a transient sibling — zero Parse after a sibling pool joins and leaves', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const poolA = new PgBridgePool({ pglite: local });

    // Swallow the expected shared-instance warning emitted when poolB joins.
    const swallowSharedWarning = (w: Error): void => {
      if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
    };
    process.on('warning', swallowSharedWarning);

    try {
      // Warm pool A past the K=2 admission gate — the second execution
      // names and Parses the SQL under the client's own unique name.
      await poolA.query({ text: 'SELECT 7 AS n', values: [] });
      await poolA.query({ text: 'SELECT 7 AS n', values: [] });

      // Sibling joins, queries, and leaves. Per-client names need no
      // coordination: pool B's connect must not fire DEALLOCATE ALL
      // (liveClientCounts was already 1), and its departure must not evict
      // or invalidate pool A's cache — no suspension, no epoch, no re-Parse.
      const poolB = new PgBridgePool({ pglite: local });
      try {
        await poolB.query('SELECT 1');
      } finally {
        await poolB.end();
      }

      parseSpy.mockClear();
      // Pool A's cache stayed warm through the sibling churn: the repeat
      // query sends ZERO Parse and succeeds.
      const result = await poolA.query({ text: 'SELECT 7 AS n', values: [] });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(result.rows).toEqual([{ n: 7 }]);
    } finally {
      process.off('warning', swallowSharedWarning);
      await poolA.end();
      await local.close();
    }
  });

  it('sequential multi-pool: second pool re-Parses cleanly after first pool ends', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const swallow = (w: Error): void => {
      if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
    };
    process.on('warning', swallow);
    try {
      // Pool A promotes the SQL under its own client-unique name while it
      // is the sole pool (two sightings past the K=2 gate).
      const poolA = new PgBridgePool({ pglite: local });
      try {
        await poolA.query({ text: 'SELECT 9 AS n', values: [] });
        await poolA.query({ text: 'SELECT 9 AS n', values: [] });
      } finally {
        await poolA.end(); // client removed → liveClientCounts 1→0
      }
      parseSpy.mockClear();

      // Pool B starts fresh: connect fires liveClientCounts 0→1 → DEALLOCATE ALL.
      const poolB = new PgBridgePool({ pglite: local });
      try {
        await poolB.query({ text: 'SELECT 9 AS n', values: [] });
        const result = await poolB.query({ text: 'SELECT 9 AS n', values: [] });
        // One fresh Parse under pool B's own name at promotion (PGlite was
        // clean after the genuine 0→1 DEALLOCATE ALL on pool B's connect;
        // the below-gate zero-values sighting runs the simple protocol —
        // no Parse at all).
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(result.rows).toEqual([{ n: 9 }]);
      } finally {
        await poolB.end();
      }
    } finally {
      process.off('warning', swallow);
      await local.close();
    }
  });

  it('concurrent multi-pool: both pools cache during the overlap under distinct client-unique names', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const swallow = (w: Error): void => {
      if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
    };
    process.on('warning', swallow);
    const shape = { text: 'SELECT 11 AS n', values: [] };
    try {
      const poolA = new PgBridgePool({ pglite: local });
      const poolB = new PgBridgePool({ pglite: local });
      try {
        // Cold phase DURING the overlap: each pool's client sights the SQL
        // twice — the below-gate zero-values sighting runs the simple
        // protocol (no Parse), the second promotes and Parses under its own
        // client-unique name. One Parse per pool, no 42P05, no caching
        // suspension.
        parseSpy.mockClear();
        const coldA = await poolA.query(shape);
        const coldA2 = await poolA.query(shape);
        const coldB = await poolB.query(shape);
        const coldB2 = await poolB.query(shape);
        expect(coldA.rows).toEqual([{ n: 11 }]);
        expect(coldA2.rows).toEqual([{ n: 11 }]);
        expect(coldB.rows).toEqual([{ n: 11 }]);
        expect(coldB2.rows).toEqual([{ n: 11 }]);
        expect(parseSpy).toHaveBeenCalledTimes(2);

        // Both statements coexist in the shared session under distinct names.
        const { rows } = await local.query<{ name: string }>(
          'SELECT name FROM pg_prepared_statements',
        );
        const names = rows.map((row) => row.name).filter((name) => name.startsWith('ppb_'));
        expect(names).toHaveLength(2);
        expect(new Set(names).size).toBe(2);
        for (const name of names) expect(name).toMatch(/^ppb_\d+_\d+$/);

        // Warm phase: both caches stay active while the pools overlap —
        // zero Parse, no 26000.
        parseSpy.mockClear();
        const warmA = await poolA.query(shape);
        const warmB = await poolB.query(shape);
        expect(warmA.rows).toEqual([{ n: 11 }]);
        expect(warmB.rows).toEqual([{ n: 11 }]);
        expect(parseSpy).not.toHaveBeenCalled();
      } finally {
        await poolA.end();
        await poolB.end();
      }
    } finally {
      process.off('warning', swallow);
      await local.close();
    }
  });

  it('liveClientCounts returns to zero after all pools end (DEALLOCATE ALL fires again)', async () => {
    const local = new PGlite();
    const swallow = (w: Error): void => {
      if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
    };
    process.on('warning', swallow);
    try {
      const poolA = new PgBridgePool({ pglite: local });
      const poolB = new PgBridgePool({ pglite: local });
      // Trigger connects on both pools.
      await poolA.query('SELECT 1');
      await poolB.query('SELECT 1');

      // Both pools end → two 'remove' events → liveClientCounts 2→1→0.
      await poolA.end();
      await poolB.end();

      // A new pool should see liveClientCounts = 0 → DEALLOCATE ALL fires on connect.
      // Verify through a Parse spy: after the cleanup, pool C's client sends
      // a fresh Parse under its own client-unique name.
      const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
      const poolC = new PgBridgePool({ pglite: local });
      try {
        await poolC.query({ text: 'SELECT 13 AS n', values: [] }); // below gate — simple protocol
        await poolC.query({ text: 'SELECT 13 AS n', values: [] });
        expect(parseSpy).toHaveBeenCalledTimes(1); // fresh promotion Parse after DEALLOCATE ALL
      } finally {
        await poolC.end();
      }
    } finally {
      process.off('warning', swallow);
      await local.close();
    }
  });

  it('keeps an unawaited stock query and a fast-shape query ordered on one client', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        // Object-form stock query (no name/rowMode → stock path) followed
        // WITHOUT awaiting by a fast-shape query: the client's submission
        // chain must keep mixed-path queries ordered — both resolve.
        const stockPromise = client.query({ text: 'SELECT 1 AS one' });
        const fastPromise = client.query(fastShapeQuery());

        const [stockResult, fastResult] = await Promise.all([stockPromise, fastPromise]);
        expect(stockResult.rows).toEqual([{ one: 1 }]);
        expect(fastResult.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  describe('activation predicate — every rejected leg runs the stock path', () => {
    const isStockResult = (result: unknown): boolean =>
      (result as { constructor: { name: string } }).constructor.name === 'Result';

    it('accepts positional values (two-argument form) on the fast path', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const client = await pool.connect();
        try {
          const { name: _ignored, ...cfg } = fastShapeQuery();
          const result = await client.query(
            { ...cfg, name: 'fq_positional', values: undefined },
            [7],
          );
          expect(isStockResult(result)).toBe(false);
          expect(result.rows).toEqual([[7]]);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });

    it('rejects a third non-callback argument', async () => {
      // Must go through client.query directly — pool.query wraps the promise
      // in a callback, collapsing the argument list before the predicate.
      const pool = new PgBridgePool({ pglite });
      try {
        const client = await pool.connect();
        try {
          const result = await (
            client.query as unknown as (a: unknown, b: unknown, c: unknown) => Promise<unknown>
          )({ ...fastShapeQuery(), name: 'fq_threearg' }, [7], undefined);
          expect(isStockResult(result)).toBe(true);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });

    it('rejects an empty statement name', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const result = await pool.query({ ...fastShapeQuery(), name: '' });
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('rejects an empty query text (stock pg owns EmptyQueryResponse semantics)', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        // values: [] — the empty statement takes no parameters, and binding
        // one fails identically on either path, masking the discriminator.
        const result = await pool.query({
          ...fastShapeQuery(),
          name: 'fq_emptytext',
          text: '',
          values: [],
        });
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('rejects a name-only re-execution (no text — a legitimate stock pattern)', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const client = await pool.connect();
        try {
          // Prepare via the fast path, then re-execute by name alone.
          const prepared = await client.query({ ...fastShapeQuery(), name: 'fq_reuse' });
          expect(isStockResult(prepared)).toBe(false);

          const reused = await client.query({
            name: 'fq_reuse',
            values: [7],
            rowMode: 'array' as const,
            types: pg.types,
          } as never);
          expect(isStockResult(reused)).toBe(true);
          expect((reused as { rows: unknown[] }).rows).toEqual([[7]]);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });

    it('rejects a missing rowMode', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const { rowMode: _ignored, ...cfg } = fastShapeQuery();
        const result = await pool.query({ ...cfg, name: 'fq_norowmode' } as never);
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('rejects non-array values (stock pg then reports its own error)', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        await expect(
          pool.query({ ...fastShapeQuery(), name: 'fq_badvalues', values: 'nope' } as never),
        ).rejects.toThrow(/Query values must be an array/);
      } finally {
        await pool.end();
      }
    });

    it('rejects a missing types object', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const { types: _ignored, ...cfg } = fastShapeQuery();
        const result = await pool.query({ ...cfg, name: 'fq_notypes' } as never);
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('rejects stock-pg disqualifiers such as an explicit queryMode', async () => {
      // `rows` (a row limit) would be the other natural disqualifier to
      // exercise, but stock pg drives row-limited queries with Flush, which
      // the duplex EQP-buffers until Sync — a pre-existing bridge
      // limitation independent of the fast path.
      const pool = new PgBridgePool({ pglite });
      try {
        const result = await pool.query({
          ...fastShapeQuery(),
          name: 'fq_qmode',
          queryMode: 'extended',
        } as never);
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });
  });

  // Plan "Honor query_timeout on the fast path" (finding #2). PgBridgeClient's
  // outer timer now covers explicit and default values without changing the
  // selected query implementation, so the fast path keeps a stable result
  // shape and its submission chain follows actual ReadyForQuery.
  describe('query_timeout', () => {
    const isStockResult = (result: unknown): boolean =>
      (result as { constructor: { name: string } }).constructor.name === 'Result';

    it('fast-path shape honors query_timeout', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const client = await pool.connect();
        try {
          // PGlite executes queries ON the JS thread, so a JS read-timeout
          // timer can never fire against WASM execution — neither this
          // query's own nor another client's pg_sleep (probe-verified: a
          // 20 ms timer stays dormant through a 200 ms pg_sleep, and the
          // gate-completion → next-query microtask chain never visits the
          // timer phase). The timeout only bites while the event loop is
          // genuinely FREE. Gate by holding pglite.runExclusive — the exact
          // mutex the duplex queues every protocol batch on (a transaction()
          // gate does NOT work: PGlite's transaction/query lock is separate
          // from runExclusive, probe-verified) — over a pure JS await: the
          // timed query's duplex op queues behind it with an idle loop, the
          // shared-instance contention the timeout exists to bound.
          //
          // Settle the client's submission chain first so this case isolates
          // an admitted query's deadline. Queued-budget coverage lives in the
          // PgBridgeClient submission-chain tests.
          await client.query('SELECT 1 AS warmup');
          let releaseGate!: () => void;
          const gateHeld = new Promise<void>((resolve) => {
            releaseGate = resolve;
          });
          const gate = pglite.runExclusive(async () => {
            await gateHeld;
          });
          // Let the gate acquire the mutex before the timed query.
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Adapter-shaped config carrying a 20 ms read timeout. The fast path
          // stays selected while PgBridgeClient's outer timer starts at the
          // public call and remains live as the gate holds the mutex. The
          // 300 ms sentinel turns a missing timer into a clean 'pending'
          // assertion failure instead of a test timeout.
          const slow = {
            name: 'fq_timeout_gated',
            text: 'SELECT 1',
            values: [],
            rowMode: 'array' as const,
            types: pg.types,
            query_timeout: 20,
          };
          const start = performance.now();
          const outcome = await Promise.race([
            client.query(slow).then(
              () => 'resolved' as const,
              (err: unknown) => err,
            ),
            new Promise<'pending'>((resolve) => {
              setTimeout(() => resolve('pending'), 300).unref();
            }),
          ]);
          const elapsed = performance.now() - start;
          releaseGate();
          await gate;
          expect(outcome).toBeInstanceOf(Error);
          expect((outcome as Error).message).toMatch(/query read timeout/i);
          // Generous upper bound (not a tight lower window) on rejection
          // latency; the gate was still held when the race settled, so only
          // the timer can have settled the query promise.
          expect(elapsed).toBeLessThan(150);

          // The same client still accepts a new query. This is NOT backend
          // cancellation — PGlite still ran the gated statement to completion,
          // and the bridge kept its internal chain behind that late drain.
          const followUp = await client.query({
            name: 'fq_timeout_followup',
            text: 'SELECT $1::int AS n',
            values: [7],
            rowMode: 'array' as const,
            types: pg.types,
          });
          expect(followUp.rows).toEqual([[7]]);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });

    it('a truthy query_timeout keeps the fast-path result shape', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const result = await pool.query({
          ...fastShapeQuery(),
          name: 'fq_timeout_truthy',
          query_timeout: 30_000,
        } as never);
        expect(isStockResult(result)).toBe(false);
        expect((result as object) instanceof pg.Result).toBe(false);
        expect((result as { rows: unknown[] }).rows).toEqual([[7]]);
      } finally {
        await pool.end();
      }
    });

    it('query_timeout: 0 stays on the fast path', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const client = await pool.connect();
        try {
          // Stock pg reads `config.query_timeout || connectionParameters
          // .query_timeout`, so 0 is unset when no pool fallback exists.
          // Direct truthy disqualifier checks keep this call on the fast path.
          // `query_timeout` is a Client-level option, not a pg QueryConfig
          // field, so the config type rejects it (`as never`) — mirroring the
          // very omission that let the fast path drop it. It is nonetheless the
          // one timeout route the bridge exposes.
          const result = await client.query({
            ...fastShapeQuery(),
            name: 'fq_timeout_zero',
            query_timeout: 0,
          } as never);
          // The fast path returns a plain result record; stock pg returns a
          // pg.Result instance. Both discriminators agree the fast path ran.
          expect(isStockResult(result)).toBe(false);
          expect((result as object) instanceof pg.Result).toBe(false);
          expect((result as { rows: unknown[] }).rows).toEqual([[7]]);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });
  });
});

// Backend regressions for the bounded DEALLOCATE identifier decoder (plan:
// .claude/plans/bounded-deallocate-identifier-decoder.md, tests 1–8; test 9's
// session-wide Describe assertion lives in the DEALLOCATE ALL test above).
// Every target rides the fast path so BOTH cache deletions stay observable:
// evicting parsedStatements alone would re-Parse but skip Describe on a
// leftover #fieldsCache entry — an invalidated name must show one fresh
// Parse AND one fresh Describe, a warm neighbor zero of each. Neighbors are
// asserted FIRST (ordering is load-bearing): a false eviction must surface
// there before the target's re-Parse can mask it.
describe('PgBridgePool — bounded DEALLOCATE decoder (backend regressions)', () => {
  // Protocol-named fast-shape statement, adapter-pg style. The name is a
  // PROTOCOL name — pg sends it byte-exact in Parse; only the SQL DEALLOCATE
  // text is subject to identifier lexing/folding.
  const namedShape = (name: string) => ({
    name,
    text: 'SELECT $1::int AS n',
    values: [7],
    rowMode: 'array' as const,
    types: pg.types,
  });

  const withClient = async (run: (client: pg.PoolClient) => Promise<void>): Promise<void> => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        await run(client);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  };

  it('DEALLOCATE "a""b" evicts exactly the escaped-quote name — neighbor stays warm, target re-Parses and re-Describes', async () => {
    // Plan test 1: "" decodes to one literal quote, so the target protocol
    // name is a"b. Pre-fix the detector misses the doubled quote entirely,
    // the eviction is skipped, and the target's warm repeat Binds into a
    // 26000.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const target = namedShape('a"b');
      const keep = namedShape('keep');
      await client.query(target);
      await client.query(keep);

      await client.query('DEALLOCATE "a""b"');

      // Neighbor FIRST: a false eviction would show up here as a fresh
      // Parse/Describe before the target's recovery could mask it.
      parseSpy.mockClear();
      describeSpy.mockClear();
      const warm = await client.query(keep);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warm.rows).toEqual([[7]]);

      // Target: one fresh Parse AND one fresh Describe — both the
      // parsedStatements and #fieldsCache entries were evicted.
      const revived = await client.query(target);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    });
  });

  it('unquoted DEALLOCATE MÜNZE evicts only mÜnze — the distinct münze neighbor stays warm', async () => {
    // Plan test 2 (Unicode collision tripwire): PGlite folds ASCII letters
    // only, so MÜNZE names mÜnze. Pre-fix the non-ASCII identifier is not
    // recognized at all (stale 26000 on mÜnze); a naive JS toLowerCase
    // widening would instead evict the LIVE münze — the warm-first neighbor
    // assertion catches exactly that false eviction.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const target = namedShape('mÜnze');
      const neighbor = namedShape('münze');
      await client.query(target);
      await client.query(neighbor);

      await client.query('DEALLOCATE MÜNZE');

      parseSpy.mockClear();
      describeSpy.mockClear();
      const warm = await client.query(neighbor);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warm.rows).toEqual([[7]]);

      const revived = await client.query(target);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    });
  });

  it('unquoted DEALLOCATE MYSTMT evicts only mystmt — the protocol-exact MYSTMT neighbor stays warm', async () => {
    // Plan test 3 (ASCII fold collision tripwire): SQL folds the unquoted
    // identifier to mystmt, but protocol names are byte-exact — a future
    // "helpful" case-insensitive local-key deletion would evict the live
    // MYSTMT statement too.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const target = namedShape('mystmt');
      const neighbor = namedShape('MYSTMT');
      await client.query(target);
      await client.query(neighbor);

      await client.query('DEALLOCATE MYSTMT');

      parseSpy.mockClear();
      describeSpy.mockClear();
      const warm = await client.query(neighbor);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warm.rows).toEqual([[7]]);

      const revived = await client.query(target);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    });
  });

  it('DEALLOCATE "MiXeD" is case-exact — mixed stays warm, only MiXeD re-Parses and re-Describes', async () => {
    // Plan test 4: quoted identifiers never fold. Already green today —
    // pinned against a future case-folding regression.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const target = namedShape('MiXeD');
      const neighbor = namedShape('mixed');
      await client.query(target);
      await client.query(neighbor);

      await client.query('DEALLOCATE "MiXeD"');

      parseSpy.mockClear();
      describeSpy.mockClear();
      const warm = await client.query(neighbor);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warm.rows).toEqual([[7]]);

      const revived = await client.query(target);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    });
  });

  it('bare DEALLOCATE PREPARE targets the statement named prepare — the bystander stays warm', async () => {
    // Plan test 5, backend-success case: PGlite probe-confirmed that bare
    // DEALLOCATE PREPARE validly deallocates a statement named prepare —
    // here the whole loop through the backend and the invalidation runs.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const target = namedShape('prepare');
      const bystander = namedShape('bystander');
      await client.query(target);
      await client.query(bystander);

      await client.query('DEALLOCATE PREPARE');

      parseSpy.mockClear();
      describeSpy.mockClear();
      const warm = await client.query(bystander);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warm.rows).toEqual([[7]]);

      const revived = await client.query(target);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    });
  });

  it('DEALLOCATE PREPARE foo targets only foo — prepare and the bystander stay warm', async () => {
    // Plan test 5, lookahead disambiguation: PREPARE is consumed as the
    // optional keyword because a complete target follows. Decoding it as
    // { name: 'prepare' } would falsely evict the LIVE prepare statement
    // after the backend deallocated foo.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const prepareStmt = namedShape('prepare');
      const foo = namedShape('foo');
      const bystander = namedShape('bystander');
      await client.query(prepareStmt);
      await client.query(foo);
      await client.query(bystander);

      await client.query('DEALLOCATE PREPARE foo');

      parseSpy.mockClear();
      describeSpy.mockClear();
      const warmPrepare = await client.query(prepareStmt);
      const warmBystander = await client.query(bystander);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warmPrepare.rows).toEqual([[7]]);
      expect(warmBystander.rows).toEqual([[7]]);

      const revived = await client.query(foo);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    });
  });

  it('DEALLOCATE PREPARE ALL is session-wide — every named statement re-Parses and re-Describes', async () => {
    // Plan test 5, session-wide arm of the matrix.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const first = namedShape('prepare');
      const second = namedShape('bystander');
      await client.query(first);
      await client.query(second);

      await client.query('DEALLOCATE PREPARE ALL');

      parseSpy.mockClear();
      describeSpy.mockClear();
      const revivedFirst = await client.query(first);
      const revivedSecond = await client.query(second);
      expect(parseSpy).toHaveBeenCalledTimes(2);
      expect(describeSpy).toHaveBeenCalledTimes(2);
      expect(revivedFirst.rows).toEqual([[7]]);
      expect(revivedSecond.rows).toEqual([[7]]);
    });
  });

  it('object-form DEALLOCATE "a""b" from a sibling client evicts the preparer through the registry', async () => {
    // Plan test 6: the decoder must still flow through the unchanged
    // query-shape extraction ({ text } object form) and the liveClients
    // registry — the eviction lands on the SIBLING that prepared the name.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      const target = namedShape('a"b');
      await a.query(target);

      await b.query({ text: 'DEALLOCATE "a""b"' });

      parseSpy.mockClear();
      describeSpy.mockClear();
      const revived = await a.query(target);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    } finally {
      a?.release();
      b?.release();
      await pool.end();
    }
  });

  it('a DEALLOCATE rejected by the backend (26000) evicts nothing — the stale entry still skips Parse', async () => {
    // Plan test 7 (backend success first): cache mutation lives exclusively
    // in the fulfilled arm. The raw-PGlite DEALLOCATE makes the client's
    // caches deliberately stale; the client's own repeat of the SAME command
    // must reject 26000 AND run no invalidation — proven by the next attempt
    // still skipping Parse (stale entry intact) into the same 26000. Zero
    // Parse distinguishes "no mutation" from an accidental local clearing,
    // which would heal the statement here and hide the defect.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    await withClient(async (client) => {
      const target = namedShape('a"b');
      await client.query(target);

      // Behind the client's back: the backend forgets a"b, both local
      // caches keep it.
      await pglite.query('DEALLOCATE "a""b"');

      await expect(client.query('DEALLOCATE "a""b"')).rejects.toMatchObject({ code: '26000' });

      parseSpy.mockClear();
      await expect(client.query(target)).rejects.toMatchObject({ code: '26000' });
      expect(parseSpy).not.toHaveBeenCalled();
    });
  });

  it('the identical >63-byte spelling deallocates, evicts, and re-Parses — truncation notice captured', async () => {
    // Plan test 8(a): pg keys parsedStatements by the full 64-byte protocol
    // name even though the server stores the 63-byte truncation. Deleting
    // the identical decoded spelling is exact — the next execution re-Parses
    // and re-Describes. The lexer's truncation NOTICE is captured and
    // asserted so this guard stays quiet.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const name64 = 'l'.repeat(64);
      const notices: string[] = [];
      const onNotice = (notice: { message?: string }): void => {
        notices.push(notice.message ?? '');
      };
      client.on('notice', onNotice);
      try {
        const shape = namedShape(name64);
        await client.query(shape);

        await client.query(`DEALLOCATE ${name64}`);
        expect(notices.some((message) => message.includes('will be truncated'))).toBe(true);

        parseSpy.mockClear();
        describeSpy.mockClear();
        const revived = await client.query(shape);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(describeSpy).toHaveBeenCalledTimes(1);
        expect(revived.rows).toEqual([[7]]);
      } finally {
        client.off('notice', onNotice);
      }
    });
  });

  it('a longer same-prefix alias is a fail-closed miss — 42P05 on prepare, neighbor warm, 63-byte entry stays stale', async () => {
    // Plan test 8(b): the server exposes ONE truncated identity, so the
    // 64-byte alias cannot be prepared next to its live 63-byte prefix
    // (42P05). DEALLOCATE through the alias succeeds server-side but decodes
    // to the full alias spelling — no such local key exists, so nothing is
    // evicted: the deliberate, documented alias miss. The neighbor must stay
    // warm (no broadened eviction) and the 63-byte entry stays locally
    // stale: repeat 26000 with ZERO Parse — never a false eviction.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const prefix63 = 'l'.repeat(63);
      const alias64 = `${prefix63}z`;
      const notices: string[] = [];
      const onNotice = (notice: { message?: string }): void => {
        notices.push(notice.message ?? '');
      };
      client.on('notice', onNotice);
      try {
        const shape63 = namedShape(prefix63);
        const neighbor = namedShape('keep');
        await client.query(shape63);
        await client.query(neighbor);

        // The server truncates the alias to the live prefix — Parse fails.
        await expect(client.query(namedShape(alias64))).rejects.toMatchObject({
          code: '42P05',
        });

        // Server-side success: the lexer truncates the identifier to the
        // prefix and deallocates it, warning as it goes.
        await client.query(`DEALLOCATE ${alias64}`);
        expect(notices.some((message) => message.includes('will be truncated'))).toBe(true);

        // Neighbor FIRST: the alias miss must not broaden into any eviction.
        parseSpy.mockClear();
        describeSpy.mockClear();
        const warm = await client.query(neighbor);
        expect(parseSpy).not.toHaveBeenCalled();
        expect(describeSpy).not.toHaveBeenCalled();
        expect(warm.rows).toEqual([[7]]);

        // The 63-byte entry is locally stale — the accepted fail-closed miss.
        await expect(client.query(shape63)).rejects.toMatchObject({ code: '26000' });
        expect(parseSpy).not.toHaveBeenCalled();
      } finally {
        client.off('notice', onNotice);
      }
    });
  });

  // Plan B, real-PGlite rows — DEALLOCATE / DEALLOCATE PREPARE with the target
  // quoted-adjacent (zero whitespace before the opening `"`). The backend
  // accepts every spelling here and deallocates the target, so the neighbor
  // must stay warm (zero Parse/Describe) and only the target re-Parses and
  // re-Describes once. Pre-fix the decoder requires whitespace after the
  // keyword, so it misses the command entirely: the SQL succeeds server-side
  // but local eviction is skipped, and the target's warm repeat Binds into a
  // persistent 26000 (the target revive below rejects instead of succeeding).
  const quotedAdjacencyRow = (
    label: string,
    targetName: string,
    sql: string,
  ): [label: string, targetName: string, sql: string] => [label, targetName, sql];

  it.each([
    quotedAdjacencyRow('direct adjacency, doubled-quote name', 'a"b', 'DEALLOCATE"a""b"'),
    quotedAdjacencyRow('PREPARE adjacency, hyphenated name', 'p-q', 'DEALLOCATE PREPARE"p-q"'),
    quotedAdjacencyRow('direct adjacency, quoted "ALL" targets one name', 'ALL', 'DEALLOCATE"ALL"'),
  ])(
    'quoted-adjacent %s evicts only the target — neighbor stays warm, target re-Parses and re-Describes',
    async (_label, targetName, sql) => {
      const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
      const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
      await withClient(async (client) => {
        const target = namedShape(targetName);
        const neighbor = namedShape('adjacency_neighbor');
        await client.query(target);
        await client.query(neighbor);

        await client.query(sql);

        // Neighbor FIRST: a broadened / wrong eviction surfaces here before
        // the target's recovery could mask it.
        parseSpy.mockClear();
        describeSpy.mockClear();
        const warm = await client.query(neighbor);
        expect(parseSpy).not.toHaveBeenCalled();
        expect(describeSpy).not.toHaveBeenCalled();
        expect(warm.rows).toEqual([[7]]);

        // Target: exactly one fresh Parse AND one fresh Describe, succeeding.
        // Pre-fix this rejects with 26000 (eviction skipped).
        const revived = await client.query(target);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(describeSpy).toHaveBeenCalledTimes(1);
        expect(revived.rows).toEqual([[7]]);
      });
    },
  );

  // Plan C, backend semantic pins — GREEN on both sides of the fix. They pin
  // the lexer/protocol agreement that 100% source coverage cannot establish:
  // C1 connects UTF-16 surrogate scanning to protocol UTF-8 encoding, C2 pins
  // VT and FF as accepted separators shared by the command paths.
  it('C1 supplementary-plane U+20000 protocol name — unquoted DEALLOCATE evicts only the target', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const target = namedShape('\u{20000}');
      const neighbor = namedShape('supp_neighbor');
      await client.query(target);
      await client.query(neighbor);

      await client.query('DEALLOCATE \u{20000}');

      parseSpy.mockClear();
      describeSpy.mockClear();
      const warm = await client.query(neighbor);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warm.rows).toEqual([[7]]);

      const revived = await client.query(target);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    });
  });

  it.each([
    ['VT', '\v', 't_vt', 'n_vt'],
    ['FF', '\f', 't_ff', 'n_ff'],
  ])(
    'C2 %s separator between DEALLOCATE and a regular name evicts only the target — neighbor stays warm',
    async (_label, sep, targetName, neighborName) => {
      // Regular (unquoted) names are chosen lowercase so PGlite's ASCII fold
      // leaves the SQL identifier byte-equal to the protocol name.
      const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
      const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
      await withClient(async (client) => {
        const target = namedShape(targetName);
        const neighbor = namedShape(neighborName);
        await client.query(target);
        await client.query(neighbor);

        await client.query(`DEALLOCATE${sep}${targetName}`);

        parseSpy.mockClear();
        describeSpy.mockClear();
        const warm = await client.query(neighbor);
        expect(parseSpy).not.toHaveBeenCalled();
        expect(describeSpy).not.toHaveBeenCalled();
        expect(warm.rows).toEqual([[7]]);

        const revived = await client.query(target);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(describeSpy).toHaveBeenCalledTimes(1);
        expect(revived.rows).toEqual([[7]]);
      });
    },
  );
});

// Plan A1/A2 — a caller mutates an object query-config AFTER query() returns
// but BEFORE the bridge's deferred submission runs. The invalidation the
// continuation applies and the SQL the backend executes must both be the ONE
// text captured at call time, matching stock pg's synchronous Query
// construction. Pre-fix query() decodes at call time but defers submission
// through a closure over the mutable args array, so the two diverge. These
// use the existing Parse/Describe spies and pg_prepared_statements to prove
// EXACT server and local state, not just an error code.
describe('PgBridgePool — mutable-config invalidation race', () => {
  const namedShape = (name: string) => ({
    name,
    text: 'SELECT $1::int AS n',
    values: [7],
    rowMode: 'array' as const,
    types: pg.types,
  });

  const withClient = async (run: (client: pg.PoolClient) => Promise<void>): Promise<void> => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        await run(client);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  };

  it('A1 wrong-target race: the captured DEALLOCATE text drives both backend and eviction', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const foo = namedShape('foo');
      const bar = namedShape('bar');
      const bystander = namedShape('bystander');
      // Prepare and warm all three so a later Parse/Describe is meaningful.
      await client.query(foo);
      await client.query(bar);
      await client.query(bystander);

      // A busy predecessor keeps the submission chain populated, so the
      // DEALLOCATE below is deferred and its args array is still mutable.
      const predecessor = client.query('SELECT pg_sleep(0.05)');
      const config = { text: 'DEALLOCATE foo' };
      const deallocated = client.query(config);
      // Mutate the config after query() returned but before deferred
      // submission — stock pg snapshots at call time, so this must not change
      // which statement the backend deallocates.
      config.text = 'DEALLOCATE bar';
      await Promise.all([predecessor, deallocated]);

      // Exact server state BEFORE reviving anything: foo must be gone and bar
      // must remain (the captured `DEALLOCATE foo` is authoritative). Pre-fix
      // the backend ran `DEALLOCATE bar`, so this reports the inverse.
      const { rows } = await pglite.query<{ name: string }>(
        'SELECT name FROM pg_prepared_statements ORDER BY name',
      );
      const names = rows.map((row) => row.name);
      expect(names).toContain('bar');
      expect(names).not.toContain('foo');

      // bar stayed warm on both sides: zero Parse/Describe, and it still runs.
      parseSpy.mockClear();
      describeSpy.mockClear();
      const warmBar = await client.query(bar);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warmBar.rows).toEqual([[7]]);

      // foo was deallocated: exactly one fresh Parse and Describe, succeeding.
      const revivedFoo = await client.query(foo);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revivedFoo.rows).toEqual([[7]]);

      // The bystander was never in scope and stays warm throughout.
      parseSpy.mockClear();
      describeSpy.mockClear();
      const warmBystander = await client.query(bystander);
      expect(parseSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
      expect(warmBystander.rows).toEqual([[7]]);
    });
  });

  it('A2 non-DEALLOCATE mutation cannot false-evict: the captured DEALLOCATE still runs', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    await withClient(async (client) => {
      const foo = namedShape('foo');
      await client.query(foo);
      await client.query(foo); // warm

      const predecessor = client.query('SELECT pg_sleep(0.05)');
      const config = { text: 'DEALLOCATE foo' };
      const deallocated = client.query(config);
      // Change the deferred query to unrelated successful SQL. The backend
      // must still execute the captured DEALLOCATE, not the SELECT.
      config.text = 'SELECT 1 AS mutated';
      const result = (await deallocated) as pg.QueryResult<{ mutated: number }>;
      await predecessor;

      // The captured command ran: a DEALLOCATE, not the mutated SELECT.
      expect(result.command).toBe('DEALLOCATE');

      // Server no longer holds foo (it was deallocated).
      const { rows } = await pglite.query<{ name: string }>(
        'SELECT name FROM pg_prepared_statements',
      );
      expect(rows.map((row) => row.name)).not.toContain('foo');

      // foo re-Parses and re-Describes exactly once and succeeds. Pre-fix the
      // backend ran the mutated SELECT (server keeps foo) while the
      // continuation still evicted foo locally, so this revive re-Parses into
      // a 42P05 against the still-live server statement.
      parseSpy.mockClear();
      describeSpy.mockClear();
      const revived = await client.query(foo);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(revived.rows).toEqual([[7]]);
    });
  });
});
