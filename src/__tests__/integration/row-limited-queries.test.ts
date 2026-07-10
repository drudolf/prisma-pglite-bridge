// Row-limited queries drive pg's portal-suspension flow: Parse, Bind,
// Describe, Execute(rows=N), Flush — Sync only follows CommandComplete.
// pg-cursor and pg-query-stream use the same flow through stock pg
// (PgBridgeClient passes Submittables straight through). Every test would
// hang forever if the pipeline regressed to a Sync-only flush, so each
// carries an explicit DEADLOCK_GUARD_MS timeout to fail fast instead. Pools
// are created per test so a deadlocked query cannot poison later tests.
import type pg from 'pg';
import Cursor from 'pg-cursor';
import { describe, expect, it } from 'vitest';

import { PgBridgePool } from '../../index.ts';

// A regressed pipeline makes these tests hang, not fail, so each carries an
// explicit timeout. Sized to clear the worst wall time under v8 coverage
// instrumentation plus parallel-fork contention — the first test pays
// PGlite's cold boot (~5s instrumented solo, more under load) — while
// staying under the 30s global testTimeout so a real deadlock still
// surfaces well before then.
const DEADLOCK_GUARD_MS = 20_000;

// pg's Query supports portal row limits via `rows` on the query config;
// @types/pg does not declare the field, so widen the type locally.
type RowLimitedQueryConfig = pg.QueryConfig & { rows: number };

const rowLimited = (text: string, rows: number): RowLimitedQueryConfig => ({ text, rows });

const withPool = async (max: number, fn: (pool: PgBridgePool) => Promise<void>): Promise<void> => {
  const pool = new PgBridgePool({ max });
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
};

describe('row-limited queries (portal suspension)', () => {
  it('resolves a rows-limited query across multiple portal suspensions', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const { rows } = await pool.query(rowLimited('select i from generate_series(1,7) g(i)', 2));
      expect(rows.map((r) => r.i)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });

  it('completes in a single round when the row limit exceeds the result size', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const { rows } = await pool.query(rowLimited('select i from generate_series(1,3) g(i)', 10));
      expect(rows.map((r) => r.i)).toEqual([1, 2, 3]);
    });
  });

  it('pages through a pg-cursor until exhaustion and closes it', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        const cursor = client.query(
          new Cursor<{ i: number }>('select i from generate_series(1,5) g(i)'),
        );
        const pages: number[][] = [];
        for (;;) {
          const page = await cursor.read(2);
          if (page.length === 0) break;
          pages.push(page.map((r) => r.i));
        }
        await cursor.close();
        expect(pages).toEqual([[1, 2], [3, 4], [5]]);
      } finally {
        client.release();
      }
    });
  });

  it('rejects a mid-rows error and keeps the client usable afterwards', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await expect(
          client.query(rowLimited('select 10 / (5 - i) as v from generate_series(1,7) g(i)', 2)),
        ).rejects.toThrow(/division by zero/);

        // The error-path RFQ was delivered, so the connection recovered.
        const { rows } = await client.query('select 1 as ok');
        expect(rows[0]?.ok).toBe(1);
      } finally {
        client.release();
      }
    });
  });

  it('runs a rows-limited query inside an explicit transaction', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          rowLimited('select i from generate_series(1,5) g(i)', 2),
        );
        expect(rows.map((r) => r.i)).toEqual([1, 2, 3, 4, 5]);
        await client.query('COMMIT');

        const { rows: after } = await client.query('select 1 as ok');
        expect(after[0]?.ok).toBe(1);
      } finally {
        client.release();
      }
    });
  });

  it('serializes a second client behind an open cursor in a max:2 pool', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(2, async (pool) => {
      const clientA = await pool.connect();
      const clientB = await pool.connect();
      try {
        const cursor = clientA.query(
          new Cursor<{ i: number }>('select i from generate_series(1,6) g(i)'),
        );
        const firstPage = await cursor.read(2);
        expect(firstPage.map((r) => r.i)).toEqual([1, 2]);

        // B must not clobber A's suspended unnamed portal: its query stays
        // pending until A's cursor is exhausted and closed. The 50ms gate is
        // an end-to-end smoke check with ~50x margin over an unblocked query;
        // the duplex unit tests assert the lock mechanism deterministically.
        let bSettled = false;
        const bPromise = clientB.query('select 41 + 1 as answer').then((result) => {
          bSettled = true;
          return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(bSettled).toBe(false);

        const rest: number[] = [];
        for (;;) {
          const page = await cursor.read(2);
          if (page.length === 0) break;
          rest.push(...page.map((r) => r.i));
        }
        await cursor.close();
        expect(rest).toEqual([3, 4, 5, 6]);

        const bResult = await bPromise;
        expect(bSettled).toBe(true);
        expect(bResult.rows[0]?.answer).toBe(42);
      } finally {
        clientA.release();
        clientB.release();
      }
    });
  });

  it('frees the session for other clients when a released client abandoned its cursor', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(2, async (pool) => {
      // Check out B up front: the abandoned client itself stays wedged
      // (pg-side readyForQuery never turns true — same as real Postgres),
      // so a later connect() could hand it back. The fix is about OTHER
      // clients not being blocked behind the abandoned portal's hold.
      const clientA = await pool.connect();
      const clientB = await pool.connect();
      try {
        const cursor = clientA.query(
          new Cursor<{ i: number }>('select i from generate_series(1,6) g(i)'),
        );
        const firstPage = await cursor.read(2);
        expect(firstPage.map((r) => r.i)).toEqual([1, 2]);

        // Abandon: release the client without closing the cursor. No Sync
        // will ever arrive for the suspended portal — the pool's release
        // hook must drop the portal hold or B would block forever.
        clientA.release();

        const { rows } = await clientB.query('select 41 + 1 as answer');
        expect(rows[0]?.answer).toBe(42);
      } finally {
        clientB.release();
      }
    });
  });
});
