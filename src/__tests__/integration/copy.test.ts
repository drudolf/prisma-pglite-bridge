// COPY ... FROM STDIN through PgBridgePool via pg-copy-streams. The duplex
// sniffs simple-protocol COPY-FROM-STDIN queries, synthesizes CopyInResponse,
// captures the client's CopyData stream, and executes the whole copy as one
// atomic PGlite call — forwarding the query unmodified kills the PGlite
// instance (WASM exit(1)). A regressed bridge therefore wedges or dies
// instead of failing an assertion, so every test carries an explicit
// DEADLOCK_GUARD_MS timeout, and pools are created per test so a dead
// instance cannot poison later tests.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PGlite } from '@electric-sql/pglite';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { describe, expect, it, vi } from 'vitest';

import { PgBridgePool } from '../../index.ts';

// Sized like row-limited-queries.test.ts: clears PGlite's cold boot under
// v8 coverage instrumentation plus parallel-fork contention while staying
// under the 30s global testTimeout so a wedge still surfaces as a failure.
const DEADLOCK_GUARD_MS = 20_000;

const withPool = async (max: number, fn: (pool: PgBridgePool) => Promise<void>): Promise<void> => {
  const pool = new PgBridgePool({ max });
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
};

/** Tab-separated `COPY ... FROM STDIN` text rows: `<n>\titem-<n>\n`. */
const tabRows = (count: number, offset = 0): string[] =>
  Array.from({ length: count }, (_, i) => `${offset + i + 1}\titem-${offset + i + 1}\n`);

describe('COPY FROM STDIN / TO STDOUT (pg-copy-streams)', () => {
  it('loads 100 rows and accepts a second COPY on the same client', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE copy_rows (n int, label text)');

        await pipeline(
          Readable.from(tabRows(100)),
          client.query(copyFrom('COPY copy_rows (n, label) FROM STDIN')),
        );
        const first = await client.query('SELECT count(*)::int AS c FROM copy_rows');
        expect(first.rows[0]?.c).toBe(100);

        // The client returns to normal query flow after the copy.
        const { rows } = await client.query('select 1 as ok');
        expect(rows[0]?.ok).toBe(1);

        // Capture state resets: a second COPY on the same client works.
        await pipeline(
          Readable.from(tabRows(50, 100)),
          client.query(copyFrom('COPY copy_rows (n, label) FROM STDIN')),
        );
        const second = await client.query('SELECT count(*)::int AS c FROM copy_rows');
        expect(second.rows[0]?.c).toBe(150);
      } finally {
        client.release();
      }
    });
  });

  it("loads CSV rows when the options contain a quoted ';' delimiter", {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE copy_rows (n int, label text)');

        // The quoted semicolon must not be mistaken for a statement separator.
        await pipeline(
          Readable.from(['1;one\n', '2;two\n']),
          client.query(
            copyFrom("COPY copy_rows (n, label) FROM STDIN WITH (FORMAT csv, DELIMITER ';')"),
          ),
        );

        const count = await client.query('SELECT count(*)::int AS c FROM copy_rows');
        expect(count.rows[0]?.c).toBe(2);
        const { rows } = await client.query('SELECT label FROM copy_rows WHERE n = 2');
        expect(rows[0]?.label).toBe('two');
      } finally {
        client.release();
      }
    });
  });

  it('commits rows loaded inside an explicit transaction', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE copy_rows (n int, label text)');

        await client.query('BEGIN');
        await pipeline(
          Readable.from(tabRows(10)),
          client.query(copyFrom('COPY copy_rows (n, label) FROM STDIN')),
        );
        await client.query('COMMIT');

        const count = await client.query('SELECT count(*)::int AS c FROM copy_rows');
        expect(count.rows[0]?.c).toBe(10);
      } finally {
        client.release();
      }
    });
  });

  it('dumps rows through COPY TO STDOUT (regression pin — works today)', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE copy_rows (n int, label text)');
        await client.query(
          "INSERT INTO copy_rows SELECT i, 'item-' || i FROM generate_series(1, 5) g(i)",
        );

        const dump = client.query(copyTo('COPY copy_rows (n, label) TO STDOUT'));
        let text = '';
        for await (const chunk of dump) {
          text += chunk;
        }
        const lines = text.split('\n').filter(Boolean);
        expect(lines.length).toBe(5);
        expect(lines[0]).toBe('1\titem-1');
      } finally {
        client.release();
      }
    });
  });

  it('dumps rows through COPY TO STDOUT after a completed COPY FROM STDIN on the same client', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE copy_rows (n int, label text)');
        await pipeline(
          Readable.from(tabRows(3)),
          client.query(copyFrom('COPY copy_rows (n, label) FROM STDIN')),
        );

        const dump = client.query(copyTo('COPY copy_rows (n, label) TO STDOUT'));
        let text = '';
        for await (const chunk of dump) {
          text += chunk;
        }
        expect(text.split('\n').filter(Boolean).length).toBe(3);
      } finally {
        client.release();
      }
    });
  });

  it('surfaces a server-side COPY error as a stream error and keeps the client usable', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        // The synthetic CopyInResponse is sent before the backend sees the
        // query, so the error surfaces only after the upload completes —
        // assert the rejection, never its timing.
        await expect(
          pipeline(
            Readable.from(['1\n']),
            client.query(copyFrom('COPY copy_missing (n) FROM STDIN')),
          ),
        ).rejects.toThrow(/does not exist/);

        const { rows } = await client.query('select 1 as ok');
        expect(rows[0]?.ok).toBe(1);
      } finally {
        client.release();
      }
    });
  });

  it('rejects malformed data, rolls the COPY back, and keeps the client usable', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE copy_rows (n int)');

        await expect(
          pipeline(
            Readable.from(['1\n', 'not-a-number\n']),
            client.query(copyFrom('COPY copy_rows (n) FROM STDIN')),
          ),
        ).rejects.toThrow(/invalid input syntax/);

        const count = await client.query('SELECT count(*)::int AS c FROM copy_rows');
        expect(count.rows[0]?.c).toBe(0);
        const { rows } = await client.query('select 1 as ok');
        expect(rows[0]?.ok).toBe(1);
      } finally {
        client.release();
      }
    });
  });

  it('surfaces a mid-stream client abort without wedging and leaves the table empty', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      // The CopyFail-triggered ErrorResponse may also be routed to the
      // client once the copy stream is already destroyed — swallow it so an
      // unhandled 'error' event cannot crash the worker.
      client.on('error', () => {});
      try {
        await client.query('CREATE TABLE copy_rows (n int, label text)');

        const ingest = client.query(copyFrom('COPY copy_rows (n, label) FROM STDIN'));
        const errors: Error[] = [];
        ingest.on('error', (err: Error) => errors.push(err));

        ingest.write('1\tone\n');
        // Let the CopyInResponse arrive so the abort is a genuine mid-copy
        // CopyFail rather than a pre-copy teardown.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        ingest.destroy(new Error('client abort'));

        // The abort surfaces as a stream error instead of a wedge.
        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 5_000 });

        const { rows } = await client.query('select 1 as ok');
        expect(rows[0]?.ok).toBe(1);
        const count = await client.query('SELECT count(*)::int AS c FROM copy_rows');
        expect(count.rows[0]?.c).toBe(0);
      } finally {
        client.release();
      }
    });
  });

  it('rejects a multi-statement COPY FROM STDIN without killing the PGlite instance', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    // Own PGlite so the fail-closed contract is observable: the query must
    // be rejected with a catchable error and the instance must stay alive.
    const pglite = new PGlite();
    await pglite.waitReady;
    const pool = new PgBridgePool({ max: 1, pglite });
    try {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE copy_rows (n int)');

        await expect(client.query('COPY copy_rows (n) FROM STDIN; SELECT 1')).rejects.toThrow(
          /COPY/i,
        );

        const { rows } = await client.query('select 1 as ok');
        expect(rows[0]?.ok).toBe(1);
      } finally {
        client.release();
      }
      expect(pglite.closed).toBe(false);
    } finally {
      await pool.end();
      if (!pglite.closed) {
        await pglite.close().catch(() => {});
      }
    }
  });

  it('runs a parameterized object-form query after a completed COPY', {
    timeout: DEADLOCK_GUARD_MS,
  }, async () => {
    await withPool(1, async (pool) => {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE copy_rows (n int, label text)');
        await pipeline(
          Readable.from(tabRows(2)),
          client.query(copyFrom('COPY copy_rows (n, label) FROM STDIN')),
        );

        // Statement-caching interplay: the EQP path must be unaffected by a
        // preceding captured COPY conversation.
        const { rows } = await client.query({
          text: 'SELECT label FROM copy_rows WHERE n = $1',
          values: [2],
        });
        expect(rows[0]?.label).toBe('item-2');
      } finally {
        client.release();
      }
    });
  });
});
