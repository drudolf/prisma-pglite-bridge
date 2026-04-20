import diagnostics_channel from 'node:diagnostics_channel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPGlite } from '../__tests__/pglite.ts';
import {
  createPool,
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from '../index.ts';

const queryCh = diagnostics_channel.channel(QUERY_CHANNEL);
const lockWaitCh = diagnostics_channel.channel(LOCK_WAIT_CHANNEL);
const getPGlite = setupPGlite();

type PoolResult = Awaited<ReturnType<typeof createPool>>;

let queryPool: PoolResult;
let queryPoolB: PoolResult;
let lockWaitPool: PoolResult;

beforeAll(async () => {
  const pglite = getPGlite();
  queryPool = await createPool({ pglite });
  queryPoolB = await createPool({ pglite });
  lockWaitPool = await createPool({ pglite, max: 2 });
});

afterAll(async () => {
  await queryPool.close();
  await queryPoolB.close();
  await lockWaitPool.close();
});

describe('QUERY_CHANNEL end-to-end', () => {
  it('publishes an event with the pool adapterId, durationMs, succeeded:true on a successful query', async () => {
    const events: QueryEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as QueryEvent);
    queryCh.subscribe(listener);
    try {
      await queryPool.pool.query('SELECT 1 AS n');
      await new Promise((r) => setImmediate(r));

      const mine = events.filter((e) => e.adapterId === queryPool.adapterId);
      expect(mine.length).toBeGreaterThan(0);
      const last = mine[mine.length - 1];
      expect(last).toBeDefined();
      if (!last) return;
      expect(last.succeeded).toBe(true);
      expect(typeof last.durationMs).toBe('number');
      expect(last.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      queryCh.unsubscribe(listener);
    }
  });

  it('publishes succeeded:false when the query fails', async () => {
    const events: QueryEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as QueryEvent);
    queryCh.subscribe(listener);
    try {
      await expect(
        queryPool.pool.query('SELECT * FROM definitely_not_a_table'),
      ).rejects.toBeDefined();
      await new Promise((r) => setImmediate(r));

      const mine = events.filter((e) => e.adapterId === queryPool.adapterId);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.some((e) => e.succeeded === false)).toBe(true);
    } finally {
      queryCh.unsubscribe(listener);
    }
  });

  it('filters across adapters: each pool sees only its own events after filtering', async () => {
    const events: QueryEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as QueryEvent);
    queryCh.subscribe(listener);
    try {
      await queryPool.pool.query('SELECT 1');
      await queryPoolB.pool.query('SELECT 1');
      await new Promise((r) => setImmediate(r));

      const fromA = events.filter((e) => e.adapterId === queryPool.adapterId);
      const fromB = events.filter((e) => e.adapterId === queryPoolB.adapterId);
      expect(fromA.length).toBeGreaterThan(0);
      expect(fromB.length).toBeGreaterThan(0);
      for (const e of fromA) expect(e.adapterId).toBe(queryPool.adapterId);
      for (const e of fromB) expect(e.adapterId).toBe(queryPoolB.adapterId);
    } finally {
      queryCh.unsubscribe(listener);
    }
  });
});

describe('LOCK_WAIT_CHANNEL end-to-end', () => {
  it('publishes when a second connection waits on a held session lock', async () => {
    const events: LockWaitEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as LockWaitEvent);
    lockWaitCh.subscribe(listener);
    try {
      const a = await lockWaitPool.pool.connect();
      try {
        await a.query('BEGIN');

        // B's query blocks until A commits. Schedule a release shortly.
        const other = lockWaitPool.pool.query('SELECT 1 AS n');
        await new Promise((r) => setTimeout(r, 1));
        await a.query('COMMIT');
        await other;
      } finally {
        a.release();
      }

      const mine = events.filter((e) => e.adapterId === lockWaitPool.adapterId);
      expect(mine.length).toBeGreaterThan(0);
      const waited = mine.find((e) => e.durationMs > 0);
      expect(waited).toBeDefined();
    } finally {
      lockWaitCh.unsubscribe(listener);
    }
  });
});
