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

        // Next execution must re-Parse. If #clearStatementCaches failed to
        // evict from pg's parsedStatements (e.g. due to a pg internal rename),
        // pg would skip Parse and PGlite would return error 26000.
        const result = await client.query(fastShapeQuery());
        expect(parseSpy).toHaveBeenCalledTimes(1);
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
});
