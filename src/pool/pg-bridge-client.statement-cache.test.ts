import pg from 'pg';
import Cursor from 'pg-cursor';
import { afterEach, describe, expect, it } from 'vitest';
import { setupPGlite } from '../__tests__/pglite.ts';
import { SessionLock } from '../utils/session-lock.ts';
import { PgBridgeClient, type PgBridgeClientOptions } from './pg-bridge-client.ts';

// Gated-LRU statement cache with piggybacked wire Close (design:
// .claude/plans/gated-lru-statement-cache.md). A cacheable shape is named
// only on its K-th sighting (minUsages, default 2); promotion at capacity
// evicts the least-recently-used name and queues a wire-level Close('S')
// that is flushed at the next query submission point. Delivery guarantee:
// the duplex pipelines Close until the next Sync/Flush-terminated extended
// batch — a simple-protocol query submitted in between executes BEFORE
// pending Closes. Capacity/minUsages are internal knobs on
// PgBridgeClientOptions.statementCaching (the pool-level public option
// stays boolean), reachable here through the OptionsKey config.

// One shared PGlite for the whole describe instead of a fresh ~1.3s cold boot
// per test. Each test builds its own pool (its own SessionLock), so no lock
// state leaks between tests; the afterEach below returns the shared session to
// a clean slate. `reset: false` — this file resets in afterEach, not
// setupPGlite's default beforeEach, because the reset must run AFTER each
// test's pool has fully torn down.
const pglite = await setupPGlite({ reset: false });

// After pool.end() resolves, any in-flight duplex teardown (e.g. a Close
// prefix) can still be settling inside PGlite's runExclusive; a direct query
// serializes behind it — deterministic barrier, not a timing race. ROLLBACK is
// defensive (swallowed): guards the case where a test left an open transaction.
// DROP and DISCARD are NOT swallowed — a failure means the prior test left the
// shared session dirty and must fail loudly rather than silently corrupt the
// next test's starting state. DISCARD ALL CLOSEs suspended portals and
// DEALLOCATEs ALL named statements, so each test starts on a genuinely empty
// session.
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

describe('PgBridgeClient — gated statement cache with piggybacked Close', () => {
  type StatementCachingOption = NonNullable<PgBridgeClientOptions['statementCaching']>;

  const createCachingPool = async (statementCaching: StatementCachingOption) => {
    await pglite.waitReady;
    const poolConfig = {
      Client: PgBridgeClient,
      max: 1,
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
        statementCaching,
      },
    };
    const pool = new pg.Pool(poolConfig);

    return {
      close: () => pool.end(),
      pool,
    };
  };

  // Server-side probe through the shared PGlite session — a raw pg.Pool has
  // no connect-time cleanup, so the list is stable between pool queries.
  const listPpb = async (): Promise<string[]> => {
    const { rows } = await pglite.query<{ name: string }>(
      "SELECT name FROM pg_prepared_statements WHERE name LIKE 'ppb_%'",
    );
    return rows.map((row) => row.name);
  };

  /** Run a parameterized shape past the K=2 admission gate (two sightings)
   *  and return the freshly promoted server-side statement name. */
  const promote = async (client: pg.PoolClient, text: string): Promise<string> => {
    const before = new Set(await listPpb());
    await client.query({ text, values: [1] });
    await client.query({ text, values: [1] });
    const fresh = (await listPpb()).filter((name) => !before.has(name));
    expect(fresh).toHaveLength(1);
    return fresh[0] as string;
  };

  it('names a cacheable shape only on its second execution, then re-engages the fast path', async () => {
    const { pool, close } = await createCachingPool(true);
    try {
      const client = await pool.connect();
      try {
        const shape = () => ({
          text: 'SELECT $1::int AS n',
          values: [7],
          rowMode: 'array' as const,
          types: pg.types,
        });

        // First sighting runs below the gate: unnamed, stock pg path — and
        // no ppb_ statement lands in the session.
        const first = await client.query(shape());
        expect(first.rows).toEqual([[7]]);
        expect(first.constructor.name).toBe('Result');
        expect(await listPpb()).toEqual([]);

        // Second sighting promotes: named, FastQuery path (plain result
        // object), statement prepared server-side.
        const second = await client.query(shape());
        expect(second.rows).toEqual([[7]]);
        expect(second.constructor.name).not.toBe('Result');
        const names = await listPpb();
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/^ppb_\d+_\d+$/);

        // Warm executions stay on the fast path and return correct rows.
        const third = await client.query(shape());
        expect(third.rows).toEqual([[7]]);
        expect(third.constructor.name).not.toBe('Result');
        expect(await listPpb()).toEqual(names);
      } finally {
        client.release();
      }
    } finally {
      await close();
      // Barrier: serialise behind any in-flight duplex teardown before afterEach runs.
      await pglite.query('SELECT 1');
    }
  });

  it('evicts the LRU statement past capacity — the Close departs in the promoting batch', async () => {
    const { pool, close } = await createCachingPool({ capacity: 2, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(client, 'SELECT $1::int AS a');
        const nameB = await promote(client, 'SELECT $1::int AS b');
        // Third promotion exceeds capacity: A (least recently used) is
        // evicted and its Close prefixes the promoting query's own message
        // train — gone immediately, no follow-up query needed.
        const nameC = await promote(client, 'SELECT $1::int AS c');

        const names = await listPpb();
        expect(names).not.toContain(nameA);
        // Total ppb_ statements stay bounded at capacity.
        expect(names).toHaveLength(2);
        expect(names).toEqual(expect.arrayContaining([nameB, nameC]));
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.query('SELECT 1');
    }
  });

  it('re-admits an evicted shape through the gate under a strictly fresh name', async () => {
    const { pool, close } = await createCachingPool({ capacity: 2, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(client, 'SELECT $1::int AS a');
        await promote(client, 'SELECT $1::int AS b');
        await promote(client, 'SELECT $1::int AS c'); // evicts A, Close delivered

        // Refresh B's recency so the re-promotion below evicts C, not B.
        await client.query({ text: 'SELECT $1::int AS b', values: [2] });
        const afterFlush = await listPpb();
        expect(afterFlush).not.toContain(nameA);

        // Counters were dropped at promotion, so the evicted shape restarts
        // from zero sightings: the first re-execution stays below the gate
        // and creates no statement.
        const below = await client.query({ text: 'SELECT $1::int AS a', values: [2] });
        expect(below.rows).toEqual([{ a: 2 }]);
        expect((await listPpb()).filter((name) => !afterFlush.includes(name))).toEqual([]);

        // The second re-execution promotes under a strictly fresh name —
        // the evicted name is never reused.
        const rePromoted = await client.query({ text: 'SELECT $1::int AS a', values: [3] });
        expect(rePromoted.rows).toEqual([{ a: 3 }]);
        const fresh = (await listPpb()).filter((name) => !afterFlush.includes(name));
        expect(fresh).toHaveLength(1);
        expect(fresh[0]).not.toBe(nameA);
        expect(fresh[0]).toMatch(/^ppb_\d+_\d+$/);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.query('SELECT 1');
    }
  });

  it('delivers an eviction Close inside a failed transaction', async () => {
    const { pool, close } = await createCachingPool({ capacity: 1, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(client, 'SELECT $1::int AS a');
        // First sighting of the next shape stays below the gate.
        await client.query({ text: 'SELECT $1::int AS d', values: [1] });

        await client.query('BEGIN');
        await expect(client.query('SELECT nope FROM ppb_missing_table')).rejects.toThrow();

        // Second sighting promotes INSIDE the failed transaction: the
        // eviction Close for A prefixes the train, the Parse raises 25P02 —
        // but Close is session-level, not transactional, and is processed
        // anyway (pgx's documented reason for Close over DEALLOCATE).
        await expect(
          client.query({ text: 'SELECT $1::int AS d', values: [2] }),
        ).rejects.toMatchObject({ code: '25P02' });
        await client.query('ROLLBACK');

        expect(await listPpb()).not.toContain(nameA);

        // The session recovered; the shape promoted in the failed tx
        // executes under its name (re-Parsed — 25P02 aborted the Parse, so
        // pg never recorded it as parsed).
        const warm = await client.query({ text: 'SELECT $1::int AS d', values: [5] });
        expect(warm.rows).toEqual([{ d: 5 }]);
        expect(await listPpb()).toHaveLength(1);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.query('SELECT 1');
    }
  });

  it('tears down cleanly right after promotions — only live statements remain', async () => {
    const { pool, close } = await createCachingPool({ capacity: 1, minUsages: 2 });
    const client = await pool.connect();
    let nameA = '';
    let nameB = '';
    let nameC = '';
    try {
      nameA = await promote(client, 'SELECT $1::int AS a');
      nameB = await promote(client, 'SELECT $1::int AS b'); // evicts A
      nameC = await promote(client, 'SELECT $1::int AS c'); // evicts B
    } finally {
      client.release();
    }

    // Ending the pool right after an evicting promotion must neither
    // error nor hang (the test timeout is the hang tripwire).
    await close();

    // Read pg_prepared_statements BEFORE the afterEach DISCARD ALL runs —
    // DISCARD ALL would destroy the orphaned nameC and make the assertion
    // below vacuous. listPpb is a direct pglite query that serialises
    // through runExclusive, which is also the barrier for any in-flight
    // duplex teardown from the closed pool.
    const names = await listPpb();
    expect(names).not.toContain(nameA); // Close rode B's promoting batch
    expect(names).not.toContain(nameB); // Close rode C's promoting batch
    // C was live at teardown — never closed: the documented Non-goals
    // orphan (a dead client's named statements stay in the session).
    expect(names).toContain(nameC);

    // The shared session is unaffected by the orphan.
    const { rows } = await pglite.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it('delivers the eviction Close even when the promoting query fails at bind', async () => {
    const { pool, close } = await createCachingPool({ capacity: 1, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameB = await promote(client, 'SELECT $1::int AS b');
        // First sighting of the next shape stays below the gate.
        await client.query({
          text: 'SELECT $1::int AS e',
          values: [1],
          rowMode: 'array' as const,
          types: pg.types,
        });

        // Second sighting promotes (evicting B), but the bind value is
        // unserializable: prepareValue throws inside FastQuery's submit,
        // which recovers with a bare Sync (fast-query.ts catch). The Close
        // prefix and the Parse already went out in the same batch.
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await expect(
          client.query({
            text: 'SELECT $1::int AS e',
            values: [circular],
            rowMode: 'array' as const,
            types: pg.types,
          }),
        ).rejects.toThrow();

        // The client recovered: the shape executes warm under its promoted
        // name and new queries work. The bind failure settles the promise
        // before the recovery Sync's RFQ, so the warm query — serialized
        // behind that RFQ — is also the barrier that proves the batch
        // (Close prefix included) fully landed before the probe below.
        const warm = await client.query({
          text: 'SELECT $1::int AS e',
          values: [2],
          rowMode: 'array' as const,
          types: pg.types,
        });
        expect(warm.rows).toEqual([[2]]);
        expect(await listPpb()).not.toContain(nameB);
        const followUp = await client.query('SELECT 3 AS three');
        expect(followUp.rows).toEqual([{ three: 3 }]);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.query('SELECT 1');
    }
  });

  it('flushes an eviction Close safely into an active pg-cursor conversation', async () => {
    const { pool, close } = await createCachingPool({ capacity: 1, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(client, 'SELECT $1::int AS a');
        // First sighting of the next shape stays below the gate.
        await client.query({ text: 'SELECT $1::int AS n', values: [1] });

        const cursor = client.query(
          new Cursor<{ i: number }>('select i from generate_series(1,5) g(i)'),
        );
        const firstPage = await cursor.read(2);
        expect(firstPage.map((row) => row.i)).toEqual([1, 2]);

        // Second sighting mid-conversation: its submission point promotes
        // the shape, evicts A, and writes the Close onto the wire while the
        // cursor's portal is suspended; pg queues the query itself behind
        // the cursor. Generator names never travel through Submittables, so
        // the Close cannot target the cursor's statement.
        const interleaved = client.query({ text: 'SELECT $1::int AS n', values: [9] });

        const rest: number[] = [];
        for (;;) {
          const page = await cursor.read(2);
          if (page.length === 0) break;
          rest.push(...page.map((row) => row.i));
        }
        await cursor.close();
        expect(rest).toEqual([3, 4, 5]);

        const result = await interleaved;
        expect(result.rows).toEqual([{ n: 9 }]);
        expect(await listPpb()).not.toContain(nameA);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.query('SELECT 1');
    }
  });

  it('sends a no-op Close for an evicted name the user already deallocated', async () => {
    const { pool, close } = await createCachingPool({ capacity: 2, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(client, 'SELECT $1::int AS a');
        const nameB = await promote(client, 'SELECT $1::int AS b');

        // User deallocates A's name directly: the server frees it and the
        // dealloc intercept clears pg's parse-skip entry; the generator map
        // intentionally survives (existing contract).
        await client.query(`DEALLOCATE "${nameA}"`);
        expect(await listPpb()).toEqual([nameB]);

        // Promoting a third shape evicts A from the generator (still its
        // LRU) and Closes the already-freed name — a protocol no-op that
        // must not error or disturb the batch it rides.
        const nameC = await promote(client, 'SELECT $1::int AS c');
        const names = await listPpb();
        expect(names).toHaveLength(2);
        expect(names).toEqual(expect.arrayContaining([nameB, nameC]));

        // B still executes warm under its kept name; A re-enters through
        // the gate and promotes under a fresh name — the old one never
        // returns.
        const warm = await client.query({ text: 'SELECT $1::int AS b', values: [4] });
        expect(warm.rows).toEqual([{ b: 4 }]);
        await client.query({ text: 'SELECT $1::int AS a', values: [5] }); // sighting 1 — below gate
        expect(await listPpb()).toHaveLength(2);
        await client.query({ text: 'SELECT $1::int AS a', values: [6] }); // sighting 2 — fresh promotion
        const finalNames = await listPpb();
        expect(finalNames).toHaveLength(2);
        expect(finalNames).toContain(nameB);
        expect(finalNames).not.toContain(nameA);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.query('SELECT 1');
    }
  });
});
