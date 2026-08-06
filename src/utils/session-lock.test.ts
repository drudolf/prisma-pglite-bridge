import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { PgBridgePool } from '../pool';
import { SessionLock } from './session-lock.ts';

const drainMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// ReadyForQuery status bytes.
const IDLE = 0x49; // 'I'
const IN_TRANSACTION = 0x54; // 'T'
const FAILED = 0x45; // 'E'

// ─── Unit tests for SessionLock (admission-reservation semantics) ───
//
// Rewritten for the session-lock admission-reservation change (design:
// .claude/plans/session-lock-admission-reservation.md §B). The OLD suite
// pinned the pre-fix semantics — acquire passing everyone while owner is
// unset, and updateStatus('T'|'E') taking/stealing ownership. This suite
// pins the NEW contract:
//   - acquire on a free lock TAKES ownership (a resolved acquire IS the
//     execution right); re-entrant for the owner; FIFO queue otherwise.
//   - updateStatus NEVER assigns ownership: 'I' from the owner releases +
//     drains; 'T'/'E' never mutate (no steal, no late-response resurrection).
//   - hold() remains as a deprecated compatibility shim; bridge production
//     paths have no callers because admission subsumes it.
// The acquire-takes and no-steal/no-resurrect rows pin the landed behavior.

describe('SessionLock', () => {
  it('acquire on a free lock TAKES ownership', async () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');

    await lock.acquire(a);
    // Post-fix: a resolved acquire on a free lock means a now owns the session.
    expect(lock.isOwner(a)).toBe(true);
  });

  it('re-entrant acquire resolves immediately for the current owner', async () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');

    await lock.acquire(a); // takes ownership
    // A second acquire by the owner must resolve synchronously — multi-batch
    // operations (cursor continuations, mid-transaction queries) must not
    // self-deadlock.
    let reentered = false;
    const reentry = lock.acquire(a).then(() => {
      reentered = true;
    });
    await drainMicrotasks();
    expect(reentered).toBe(true);
    await reentry;
    expect(lock.isOwner(a)).toBe(true);
  });

  it('a second bridge acquiring a held lock queues until the owner releases on idle', async () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');
    const b = Symbol('bridge');

    await lock.acquire(a); // a owns

    let bResolved = false;
    const bPromise = lock.acquire(b).then(() => {
      bResolved = true;
    });

    await drainMicrotasks();
    expect(bResolved).toBe(false);

    // Owner idle → release + drain grants b.
    lock.updateStatus(a, IDLE);

    await bPromise;
    expect(bResolved).toBe(true);
    expect(lock.isOwner(b)).toBe(true);
  });

  it('FIFO: two waiters behind an owner drain one at a time in arrival order on each idle RFQ', async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('first-waiter');
    const c = Symbol('second-waiter');

    await lock.acquire(a); // a owns

    const order: symbol[] = [];
    const bPromise = lock.acquire(b).then(() => order.push(b));
    const cPromise = lock.acquire(c).then(() => order.push(c));

    await drainMicrotasks();
    expect(order).toEqual([]);

    // a idles → b (first in arrival order) is granted, c still waits.
    lock.updateStatus(a, IDLE);
    await bPromise;
    expect(order).toEqual([b]);
    expect(lock.isOwner(b)).toBe(true);
    await drainMicrotasks();
    // c must not barge in while b holds.
    expect(order).toEqual([b]);

    // b idles → c is granted.
    lock.updateStatus(b, IDLE);
    await cPromise;
    expect(order).toEqual([b, c]);
    expect(lock.isOwner(c)).toBe(true);
  });

  it('updateStatus IDLE from a non-owner does not release the current owner', async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('other');

    await lock.acquire(a); // a owns
    // A stray IDLE attributed to a non-owner must not release a's ownership.
    lock.updateStatus(b, IDLE);
    expect(lock.isOwner(a)).toBe(true);
    expect(lock.isOwner(b)).toBe(false);
  });

  it("updateStatus('T') with a FOREIGN owner does not steal ownership", async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('interleaver');

    await lock.acquire(a); // a owns

    // Pre-fix this reassigned owner to b (the steal). Post-fix it is inert:
    // a keeps ownership, b never gains it.
    lock.updateStatus(b, IN_TRANSACTION);
    expect(lock.isOwner(a)).toBe(true);
    expect(lock.isOwner(b)).toBe(false);
  });

  it("updateStatus('E') with a FOREIGN owner does not steal ownership", async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('interleaver');

    await lock.acquire(a); // a owns

    lock.updateStatus(b, FAILED);
    expect(lock.isOwner(a)).toBe(true);
    expect(lock.isOwner(b)).toBe(false);
  });

  it("updateStatus('T') with NO owner does not assign ownership (late-response-after-cancel guard)", () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');

    // A late 'T' response framing after a cancel cleared the owner must not
    // resurrect a claim on the now-free session.
    lock.updateStatus(a, IN_TRANSACTION);
    expect(lock.isOwner(a)).toBe(false);
  });

  it("updateStatus('E') with NO owner does not assign ownership", () => {
    const lock = new SessionLock();
    const a = Symbol('bridge');

    lock.updateStatus(a, FAILED);
    expect(lock.isOwner(a)).toBe(false);
  });

  it("updateStatus('T'|'E') by the current owner is an inert confirmation", async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');

    await lock.acquire(a); // a owns
    lock.updateStatus(a, IN_TRANSACTION);
    expect(lock.isOwner(a)).toBe(true);
    lock.updateStatus(a, FAILED);
    expect(lock.isOwner(a)).toBe(true);

    // The transaction ends at the first owner-idle RFQ.
    lock.updateStatus(a, IDLE);
    expect(lock.isOwner(a)).toBe(false);
  });

  it('release() by the owner drains the next waiter; release() by a non-owner returns false', async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('waiter');

    await lock.acquire(a); // a owns

    let bResolved = false;
    const bPromise = lock.acquire(b).then(() => {
      bResolved = true;
    });

    await drainMicrotasks();
    expect(bResolved).toBe(false);

    // A non-owner release is a no-op.
    expect(lock.release(b)).toBe(false);
    await drainMicrotasks();
    expect(bResolved).toBe(false);
    expect(lock.isOwner(a)).toBe(true);

    // The owner release unblocks the waiting bridge and grants it ownership.
    expect(lock.release(a)).toBe(true);
    await bPromise;
    expect(bResolved).toBe(true);
    expect(lock.isOwner(b)).toBe(true);
  });

  it('cancel() rejects only the cancelling id’s waiters and leaves others to drain', async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('cancelled');
    const c = Symbol('survivor');

    await lock.acquire(a); // a owns

    let bResolved = false;
    let bRejected = false;
    const bPromise = lock.acquire(b).then(
      () => {
        bResolved = true;
      },
      () => {
        bRejected = true;
      },
    );

    let cResolved = false;
    const cPromise = lock.acquire(c).then(() => {
      cResolved = true;
    });

    await drainMicrotasks();
    expect(bResolved).toBe(false);
    expect(cResolved).toBe(false);

    // Cancel b's waiter; a then idles → c (not b) is granted.
    lock.cancel(b);
    lock.updateStatus(a, IDLE);

    await bPromise;
    await cPromise;
    expect(bRejected).toBe(true);
    expect(bResolved).toBe(false);
    expect(cResolved).toBe(true);
    expect(lock.isOwner(c)).toBe(true);
  });

  it('cancel() on the current owner releases and drains the next waiter', async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('waiter');

    await lock.acquire(a); // a owns

    let bResolved = false;
    const bPromise = lock.acquire(b).then(() => {
      bResolved = true;
    });

    expect(lock.cancel(a)).toBe(true);

    await bPromise;
    expect(bResolved).toBe(true);
    expect(lock.isOwner(b)).toBe(true);
  });

  // ─── Mid-queue destroy cases (tribunal-named, common path under reservation) ───

  it('mid-queue destroy (a): cancelling the MIDDLE waiter rejects it and preserves FIFO order for survivors', async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('first');
    const mid = Symbol('middle');
    const d = Symbol('last');

    await lock.acquire(a); // a owns

    const order: symbol[] = [];
    const bPromise = lock.acquire(b).then(() => order.push(b));
    let midRejected = false;
    const midPromise = lock.acquire(mid).then(
      () => order.push(mid),
      () => {
        midRejected = true;
      },
    );
    const dPromise = lock.acquire(d).then(() => order.push(d));

    await drainMicrotasks();

    // Destroy the middle waiter mid-queue.
    lock.cancel(mid);
    await midPromise;
    expect(midRejected).toBe(true);

    // Drain the survivors in their original arrival order: b then d.
    lock.updateStatus(a, IDLE); // → b
    await bPromise;
    lock.updateStatus(b, IDLE); // → d (mid was removed)
    await dPromise;

    expect(order).toEqual([b, d]);
    expect(lock.isOwner(d)).toBe(true);
  });

  it('mid-queue destroy (b): a waiter granted ownership by drain, then torn down before executing, passes ownership on', async () => {
    const lock = new SessionLock();
    const a = Symbol('owner');
    const b = Symbol('granted-then-destroyed');
    const c = Symbol('next');

    await lock.acquire(a); // a owns

    const bPromise = lock.acquire(b).then(
      () => undefined,
      () => undefined,
    );
    let cResolved = false;
    const cPromise = lock.acquire(c).then(() => {
      cResolved = true;
    });

    await drainMicrotasks();

    // a idles → drain grants ownership to b (but b has not "executed" yet).
    lock.updateStatus(a, IDLE);
    await bPromise;
    expect(lock.isOwner(b)).toBe(true);
    expect(cResolved).toBe(false);

    // b is torn down before it runs — cancel must release AND drain c (no
    // dead-owner deadlock).
    lock.cancel(b);
    await cPromise;
    expect(cResolved).toBe(true);
    expect(lock.isOwner(c)).toBe(true);
  });

  // The deprecated compatibility shim for external multi-duplex setups: the
  // bridge itself no longer calls hold() (admission acquires), but the
  // exported surface keeps its exact pre-reservation behavior — take if
  // free, re-entrant true, never steal.
  it('hold() shim: takes a free session, is re-entrant, never steals', () => {
    const lock = new SessionLock();
    const a = Symbol('a');
    const b = Symbol('b');

    expect(lock.hold(a)).toBe(true);
    expect(lock.isOwner(a)).toBe(true);
    expect(lock.hold(a)).toBe(true);
    expect(lock.hold(b)).toBe(false);
    expect(lock.isOwner(a)).toBe(true);
  });
});

// ─── Integration: concurrent transactions through pool ───

describe('session lock integration', async () => {
  let pool: pg.Pool;
  const pglite = await setupPGlite();

  beforeAll(async () => {
    await pglite.exec(`
      CREATE TABLE session_test (id serial PRIMARY KEY, val text);
    `);

    pool = new PgBridgePool({ pglite, max: 2 });
  });

  beforeEach(async () => {
    await pglite.exec('TRUNCATE TABLE session_test');
  });

  afterAll(async () => {
    await pool?.end();
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
    await pglite.exec("INSERT INTO session_test (val) VALUES ('seed')");

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

describe('mutation-hardening: return-value contracts', () => {
  it('updateStatus returns true when the owner releases on idle', async () => {
    const lock = new SessionLock();
    const a = Symbol('a');
    await lock.acquire(a);
    expect(lock.updateStatus(a, 0x49)).toBe(true); // 0x49 = 'I' (idle RFQ)
  });

  it('updateStatus returns false for a non-owner or a non-idle status', async () => {
    const lock = new SessionLock();
    const a = Symbol('a');
    const b = Symbol('b');
    await lock.acquire(a);
    expect(lock.updateStatus(b, 0x49)).toBe(false); // not the owner
    expect(lock.updateStatus(a, 0x54)).toBe(false); // 0x54 = 'T' (in transaction, not idle)
  });

  it('cancel returns true when it rejects a queued waiter', async () => {
    const lock = new SessionLock();
    const a = Symbol('a');
    const b = Symbol('b');
    await lock.acquire(a);
    const waiting = lock.acquire(b);
    expect(lock.cancel(b)).toBe(true);
    await expect(waiting).rejects.toThrow();
  });

  it('cancel returns false when the id owns nothing and has no waiter', async () => {
    const lock = new SessionLock();
    const a = Symbol('a');
    const z = Symbol('z');
    await lock.acquire(a);
    expect(lock.cancel(z)).toBe(false);
  });

  it('cancel rejects a waiter with the default message when none is passed', async () => {
    const lock = new SessionLock();
    const a = Symbol('a');
    const b = Symbol('b');
    await lock.acquire(a);
    const waiting = lock.acquire(b);
    lock.cancel(b);
    await expect(waiting).rejects.toThrow('Session lock acquire cancelled');
  });
});
