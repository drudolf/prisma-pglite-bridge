import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { PGliteBridge } from '../pglite-bridge.ts';
import { SessionLock } from './session-lock.ts';

const drainMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// ─── Unit tests for SessionLock ───

describe('SessionLock', () => {
  it('allows any bridge when idle', async () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');
    const b = Symbol('bridge');

    await lock.acquire(a); // should resolve immediately
    await lock.acquire(b); // should resolve immediately
  });

  it('blocks other bridges during a transaction', async () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');
    const b = Symbol('bridge');

    // Bridge A starts a transaction
    lock.updateStatus(a, 0x54); // 'T' = in transaction

    // Bridge B should be blocked
    let bResolved = false;
    const bPromise = lock.acquire(b).then(() => {
      bResolved = true;
    });

    await drainMicrotasks();
    expect(bResolved).toBe(false);

    // Bridge A commits — status back to idle
    lock.updateStatus(a, 0x49); // 'I' = idle

    await bPromise;
    expect(bResolved).toBe(true);
  });

  it('allows the owning bridge to continue during its transaction', async () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');

    lock.updateStatus(a, 0x54); // 'T'

    // Same bridge should not block
    await lock.acquire(a);
  });

  it('blocks during failed transaction state', async () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');
    const b = Symbol('bridge');

    lock.updateStatus(a, 0x45); // 'E' = failed transaction

    let bResolved = false;
    lock.acquire(b).then(() => {
      bResolved = true;
    });

    await drainMicrotasks();
    expect(bResolved).toBe(false);

    // Rollback brings status back to idle
    lock.updateStatus(a, 0x49);
    await drainMicrotasks();
    expect(bResolved).toBe(true);
  });

  it('release() unblocks waiting bridges', async () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');
    const b = Symbol('bridge');

    lock.updateStatus(a, 0x54);

    let bResolved = false;
    lock.acquire(b).then(() => {
      bResolved = true;
    });

    await drainMicrotasks();
    expect(bResolved).toBe(false);

    // Force release (e.g., bridge destroyed mid-transaction)
    lock.release(a);
    await drainMicrotasks();
    expect(bResolved).toBe(true);
  });

  it('release() unblocks waiting bridges on crash (no COMMIT)', async () => {
    const lock = new SessionLock();
    const bridgeA = Symbol('bridge');
    const bridgeB = Symbol('bridge');

    // Bridge A starts a transaction
    lock.updateStatus(bridgeA, 0x54); // 'T'

    // Bridge B is blocked
    let bResolved = false;
    const bPromise = lock.acquire(bridgeB).then(() => {
      bResolved = true;
    });

    await drainMicrotasks();
    expect(bResolved).toBe(false);

    // Bridge A is destroyed (crash) — release without COMMIT
    lock.release(bridgeA);

    await bPromise;
    expect(bResolved).toBe(true);
  });
});

// ─── Integration: concurrent transactions through pool ───

describe('session lock integration', () => {
  const getPGlite = setupPGlite({
    setup: async (pglite) => {
      await pglite.exec(`
        CREATE TABLE session_test (id serial PRIMARY KEY, val text);
      `);
    },
    reset: async (pglite) => {
      await pglite.exec('TRUNCATE TABLE session_test');
    },
  });
  let pool: pg.Pool;

  beforeAll(async () => {
    const sessionLock = new SessionLock();

    pool = new pg.Pool({
      Client: class extends pg.Client {
        constructor(config?: string | pg.ClientConfig) {
          const cfg = typeof config === 'string' ? { connectionString: config } : (config ?? {});
          super({
            ...cfg,
            user: 'postgres',
            database: 'postgres',
            stream: () => new PGliteBridge(getPGlite(), sessionLock),
          } as pg.ClientConfig);
        }
      } as typeof pg.Client,
      max: 2,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('concurrent transactions do not interleave', async () => {
    // Two transactions running concurrently — each should see only its own data
    const results = await Promise.all([
      pool.connect().then(async (client) => {
        await client.query('BEGIN');
        await client.query("INSERT INTO session_test (val) VALUES ('tx-a')");
        const { rows } = await client.query('SELECT val FROM session_test');
        await client.query('COMMIT');
        client.release();
        return rows.map((r: { val: string }) => r.val);
      }),
      pool.connect().then(async (client) => {
        await client.query('BEGIN');
        await client.query("INSERT INTO session_test (val) VALUES ('tx-b')");
        const { rows } = await client.query('SELECT val FROM session_test');
        await client.query('COMMIT');
        client.release();
        return rows.map((r: { val: string }) => r.val);
      }),
    ]);

    // Each transaction should have seen only its own insert (session lock
    // prevents interleaving). One ran first, saw 1 row. The other ran
    // second, saw its own insert plus the committed row from the first.
    // The key assertion: neither transaction saw the other's UNCOMMITTED data.
    const [aVals, bVals] = results;

    // One transaction ran first (saw only its own row), one ran second
    // (saw its own + committed from first). Either order is valid.
    const singleRow = aVals.length === 1 ? aVals : bVals;
    expect(singleRow).toHaveLength(1);
  });

  it('non-transactional queries are not blocked by other non-transactional queries', async () => {
    // Multiple concurrent non-transactional queries should all complete
    await getPGlite().exec("INSERT INTO session_test (val) VALUES ('seed')");

    const results = await Promise.all(
      Array.from({ length: 4 }, () => pool.query('SELECT val FROM session_test')),
    );

    for (const result of results) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.val).toBe('seed');
    }
  });

  it('transaction blocks other bridges until commit', async () => {
    const clientA = await pool.connect();
    await clientA.query('BEGIN');
    await clientA.query("INSERT INTO session_test (val) VALUES ('exclusive')");

    // Start a query on another connection — should be blocked until A commits
    let otherResolved = false;
    const otherPromise = pool.query('SELECT count(*)::int AS n FROM session_test').then((r) => {
      otherResolved = true;
      return r;
    });

    // Give time for the other query to attempt to run
    await new Promise((r) => setImmediate(r));
    expect(otherResolved).toBe(false); // Still blocked

    // Commit releases the session lock
    await clientA.query('COMMIT');
    clientA.release();

    const result = await otherPromise;
    expect(otherResolved).toBe(true);
    // The other query sees the committed data
    expect(result.rows[0]?.n).toBe(1);
  });

  it('rollback releases the session lock', async () => {
    const clientA = await pool.connect();
    await clientA.query('BEGIN');
    await clientA.query("INSERT INTO session_test (val) VALUES ('will-rollback')");
    await clientA.query('ROLLBACK');
    clientA.release();

    // Another query should work and see no data
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM session_test');
    expect(rows[0]?.n).toBe(0);
  });
});
