import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPool,
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './index.ts';

const queryCh = diagnostics_channel.channel(QUERY_CHANNEL);
const lockWaitCh = diagnostics_channel.channel(LOCK_WAIT_CHANNEL);

describe('QUERY_CHANNEL end-to-end', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('publishes an event with the pool adapterId, durationMs, succeeded:true on a successful query', async () => {
    const { pool, adapterId, close } = await createPool();
    cleanups.push(close);

    const events: QueryEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as QueryEvent);
    queryCh.subscribe(listener);
    cleanups.push(() => queryCh.unsubscribe(listener));

    await pool.query('SELECT 1 AS n');
    await new Promise((r) => setImmediate(r));

    const mine = events.filter((e) => e.adapterId === adapterId);
    expect(mine.length).toBeGreaterThan(0);
    const last = mine[mine.length - 1];
    expect(last).toBeDefined();
    if (!last) return;
    expect(last.succeeded).toBe(true);
    expect(typeof last.durationMs).toBe('number');
    expect(last.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('publishes succeeded:false when the query fails', async () => {
    const { pool, adapterId, close } = await createPool();
    cleanups.push(close);

    const events: QueryEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as QueryEvent);
    queryCh.subscribe(listener);
    cleanups.push(() => queryCh.unsubscribe(listener));

    await expect(pool.query('SELECT * FROM definitely_not_a_table')).rejects.toBeDefined();
    await new Promise((r) => setImmediate(r));

    const mine = events.filter((e) => e.adapterId === adapterId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((e) => e.succeeded === false)).toBe(true);
  });

  it('filters across adapters: each pool sees only its own events after filtering', async () => {
    const a = await createPool();
    const b = await createPool();
    cleanups.push(a.close, b.close);

    const events: QueryEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as QueryEvent);
    queryCh.subscribe(listener);
    cleanups.push(() => queryCh.unsubscribe(listener));

    await a.pool.query('SELECT 1');
    await b.pool.query('SELECT 1');
    await new Promise((r) => setImmediate(r));

    const fromA = events.filter((e) => e.adapterId === a.adapterId);
    const fromB = events.filter((e) => e.adapterId === b.adapterId);
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromB.length).toBeGreaterThan(0);
    for (const e of fromA) expect(e.adapterId).toBe(a.adapterId);
    for (const e of fromB) expect(e.adapterId).toBe(b.adapterId);
  });
});

describe('LOCK_WAIT_CHANNEL end-to-end', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('publishes when a second connection waits on a held session lock', async () => {
    const { pool, adapterId, close } = await createPool({ max: 2 });
    cleanups.push(close);

    const events: LockWaitEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as LockWaitEvent);
    lockWaitCh.subscribe(listener);
    cleanups.push(() => lockWaitCh.unsubscribe(listener));

    const a = await pool.connect();
    try {
      await a.query('BEGIN');

      // B's query blocks until A commits. Schedule a release shortly.
      const other = pool.query('SELECT 1 AS n');
      await new Promise((r) => setTimeout(r, 20));
      await a.query('COMMIT');
      await other;
    } finally {
      a.release();
    }

    const mine = events.filter((e) => e.adapterId === adapterId);
    expect(mine.length).toBeGreaterThan(0);
    const waited = mine.find((e) => e.durationMs > 0);
    expect(waited).toBeDefined();
  });
});
