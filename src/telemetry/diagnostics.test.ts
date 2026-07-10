import diagnostics_channel from 'node:diagnostics_channel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgBridgePool } from '../pool';
import {
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './diagnostics.ts';

const queryCh = diagnostics_channel.channel(QUERY_CHANNEL);
const lockWaitCh = diagnostics_channel.channel(LOCK_WAIT_CHANNEL);

let queryPool: PgBridgePool;
let queryPoolB: PgBridgePool;
let lockWaitPool: PgBridgePool;

beforeAll(() => {
  // One pool-owned PGlite per pool — the warning-free topology. bridgeId
  // filtering does not depend on the pools sharing an instance, and
  // concurrent pools on one instance would (correctly) emit
  // PGliteBridgeSharedInstanceWarning. `pool.end()` closes owned instances.
  queryPool = new PgBridgePool();
  queryPoolB = new PgBridgePool();
  lockWaitPool = new PgBridgePool({ max: 2 });
});

afterAll(async () => {
  await queryPool.end();
  await queryPoolB.end();
  await lockWaitPool.end();
});

describe('QUERY_CHANNEL end-to-end', () => {
  it('publishes an event with the pool bridgeId, durationMs, succeeded:true on a successful query', async () => {
    const events: QueryEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as QueryEvent);
    queryCh.subscribe(listener);
    try {
      await queryPool.query('SELECT 1 AS n');
      await new Promise((r) => setImmediate(r));

      const mine = events.filter((e) => e.bridgeId === queryPool.bridgeId);
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
      await expect(queryPool.query('SELECT * FROM definitely_not_a_table')).rejects.toBeDefined();
      await new Promise((r) => setImmediate(r));

      const mine = events.filter((e) => e.bridgeId === queryPool.bridgeId);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.some((e) => e.succeeded === false)).toBe(true);
    } finally {
      queryCh.unsubscribe(listener);
    }
  });

  it('filters across bridges: each pool sees only its own events after filtering', async () => {
    const events: QueryEvent[] = [];
    const listener = (msg: unknown) => events.push(msg as QueryEvent);
    queryCh.subscribe(listener);
    try {
      await queryPool.query('SELECT 1');
      await queryPoolB.query('SELECT 1');
      await new Promise((r) => setImmediate(r));

      const fromA = events.filter((e) => e.bridgeId === queryPool.bridgeId);
      const fromB = events.filter((e) => e.bridgeId === queryPoolB.bridgeId);
      expect(fromA.length).toBeGreaterThan(0);
      expect(fromB.length).toBeGreaterThan(0);
      for (const e of fromA) expect(e.bridgeId).toBe(queryPool.bridgeId);
      for (const e of fromB) expect(e.bridgeId).toBe(queryPoolB.bridgeId);
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
      const a = await lockWaitPool.connect();
      try {
        await a.query('BEGIN');

        // B's query blocks until A commits. Schedule a release shortly.
        const other = lockWaitPool.query('SELECT 1 AS n');
        await new Promise((r) => setTimeout(r, 1));
        await a.query('COMMIT');
        await other;
      } finally {
        a.release();
      }

      const mine = events.filter((e) => e.bridgeId === lockWaitPool.bridgeId);
      expect(mine.length).toBeGreaterThan(0);
      const waited = mine.find((e) => e.durationMs > 0);
      expect(waited).toBeDefined();
    } finally {
      lockWaitCh.unsubscribe(listener);
    }
  });
});
