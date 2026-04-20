import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LockWaitEvent,
  lockWaitChannel,
  type QueryEvent,
  queryChannel,
} from './diagnostics.ts';
import { QUERY_DURATION_WINDOW_SIZE, StatsCollector } from './stats-collector.ts';

type PGliteLike = import('@electric-sql/pglite').PGlite;

const makePglite = (size: bigint = BigInt(12345)) =>
  ({
    query: vi.fn().mockResolvedValue({ rows: [{ size }] }),
  }) as unknown as PGliteLike;

const withCollector = async (level: 1 | 2, fn: (c: StatsCollector) => Promise<void>) => {
  const c = new StatsCollector(level, Symbol('adapter'));
  try {
    await fn(c);
  } finally {
    c.stop();
  }
};

describe('StatsCollector — percentile math', () => {
  it('computes p50/p95/max for [10,20,30,40,50]', async () => {
    await withCollector(1, async (c) => {
      for (const d of [10, 20, 30, 40, 50]) c.recordQuery(d, true);
      const s = await c.snapshot(makePglite());
      expect(s.recentP50QueryMs).toBe(30);
      expect(s.recentP95QueryMs).toBe(50);
      expect(s.recentMaxQueryMs).toBe(50);
    });
  });

  it('computes p50/p95/max for [1..100]', async () => {
    await withCollector(1, async (c) => {
      for (let i = 1; i <= 100; i++) c.recordQuery(i, true);
      const s = await c.snapshot(makePglite());
      expect(s.recentP50QueryMs).toBe(50);
      expect(s.recentP95QueryMs).toBe(95);
      expect(s.recentMaxQueryMs).toBe(100);
    });
  });

  it('sorts unsorted input before computing percentiles', async () => {
    await withCollector(1, async (c) => {
      for (const d of [50, 10, 40, 20, 30]) c.recordQuery(d, true);
      const s = await c.snapshot(makePglite());
      expect(s.recentP50QueryMs).toBe(30);
      expect(s.recentP95QueryMs).toBe(50);
      expect(s.recentMaxQueryMs).toBe(50);
    });
  });

  it('n === 0: all percentiles and avg are 0, durationMs > 0 after await', async () => {
    await withCollector(1, async (c) => {
      await sleep(5);
      const s = await c.snapshot(makePglite());
      expect(s.queryCount).toBe(0);
      expect(s.avgQueryMs).toBe(0);
      expect(s.recentP50QueryMs).toBe(0);
      expect(s.recentP95QueryMs).toBe(0);
      expect(s.recentMaxQueryMs).toBe(0);
      expect(s.durationMs).toBeGreaterThan(0);
    });
  });

  it('n === 1: p50 === p95 === max === the single duration', async () => {
    await withCollector(1, async (c) => {
      c.recordQuery(42, true);
      const s = await c.snapshot(makePglite());
      expect(s.recentP50QueryMs).toBe(42);
      expect(s.recentP95QueryMs).toBe(42);
      expect(s.recentMaxQueryMs).toBe(42);
    });
  });

  it('ring buffer: recent window reflects only last QUERY_DURATION_WINDOW_SIZE entries; lifetime counters stay complete', async () => {
    await withCollector(1, async (c) => {
      const trimThreshold = QUERY_DURATION_WINDOW_SIZE * 2;
      for (let i = 0; i < trimThreshold; i++) c.recordQuery(1, true);
      for (let i = 0; i < trimThreshold; i++) c.recordQuery(999, true);
      const s = await c.snapshot(makePglite());
      expect(s.queryCount).toBe(trimThreshold * 2);
      expect(s.recentP50QueryMs).toBe(999);
      expect(s.recentP95QueryMs).toBe(999);
      expect(s.recentMaxQueryMs).toBe(999);
    });
  });
});

describe('StatsCollector — counters', () => {
  it('recordQuery is additive across calls', async () => {
    await withCollector(1, async (c) => {
      c.recordQuery(10, true);
      c.recordQuery(20, true);
      c.recordQuery(30, true);
      const s = await c.snapshot(makePglite());
      expect(s.queryCount).toBe(3);
      expect(s.totalQueryMs).toBe(60);
      expect(s.avgQueryMs).toBe(20);
      expect(s.failedQueryCount).toBe(0);
    });
  });

  it('failed query increments queryCount AND failedQueryCount, adds to totalQueryMs', async () => {
    await withCollector(1, async (c) => {
      c.recordQuery(5, false);
      const s = await c.snapshot(makePglite());
      expect(s.queryCount).toBe(1);
      expect(s.failedQueryCount).toBe(1);
      expect(s.totalQueryMs).toBe(5);
    });
  });

  it('markWasmInit: first call wins', async () => {
    await withCollector(1, async (c) => {
      c.markWasmInit(100);
      c.markWasmInit(999);
      c.markWasmInit(1);
      const s = await c.snapshot(makePglite());
      expect(s.wasmInitMs).toBe(100);
    });
  });

  it('markSchemaSetup: first call wins', async () => {
    await withCollector(1, async (c) => {
      c.markSchemaSetup(42);
      c.markSchemaSetup(777);
      const s = await c.snapshot(makePglite());
      expect(s.schemaSetupMs).toBe(42);
    });
  });

  it('incrementResetDb counts each call', async () => {
    await withCollector(1, async (c) => {
      c.incrementResetDb();
      c.incrementResetDb();
      c.incrementResetDb();
      const s = await c.snapshot(makePglite());
      expect(s.resetDbCalls).toBe(3);
    });
  });
});

describe('StatsCollector — snapshot level gating', () => {
  it('level 1: statsLevel === 1 and level-2 fields are undefined', async () => {
    await withCollector(1, async (c) => {
      const s = await c.snapshot(makePglite());
      expect(s.statsLevel).toBe(1);
      const bag = s as unknown as Record<string, unknown>;
      expect(bag.processRssPeakBytes).toBeUndefined();
      expect(bag.totalSessionLockWaitMs).toBeUndefined();
      expect(bag.sessionLockAcquisitionCount).toBeUndefined();
      expect(bag.avgSessionLockWaitMs).toBeUndefined();
      expect(bag.maxSessionLockWaitMs).toBeUndefined();
    });
  });

  it('level 2: statsLevel === 2 and level-2 fields are defined with session-lock defaults', async () => {
    await withCollector(2, async (c) => {
      const s = await c.snapshot(makePglite());
      if (s.statsLevel !== 2) throw new Error('expected level 2');
      expect(s.processRssPeakBytes).toBeGreaterThan(0);
      expect(s.totalSessionLockWaitMs).toBe(0);
      expect(s.sessionLockAcquisitionCount).toBe(0);
      expect(s.avgSessionLockWaitMs).toBe(0);
      expect(s.maxSessionLockWaitMs).toBe(0);
    });
  });
});

describe('StatsCollector — pglite query robustness', () => {
  it('snapshot parses dbSizeBytes from the single column of rows[0]', async () => {
    await withCollector(1, async (c) => {
      const pglite = makePglite(BigInt(54321));
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBe(54321);
    });
  });

  it('snapshot tolerates a rejecting pglite.query: dbSizeBytes undefined, rest returns', async () => {
    await withCollector(1, async (c) => {
      c.recordQuery(10, true);
      const pglite = {
        query: vi.fn().mockRejectedValueOnce(new Error('broken')),
      } as unknown as PGliteLike;
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
      expect(s.queryCount).toBe(1);
      expect(s.totalQueryMs).toBe(10);
      expect(s.statsLevel).toBe(1);
    });
  });
});

describe('StatsCollector — freeze()', () => {
  it('post-freeze snapshots use cached values and do not call pglite.query', async () => {
    const c = new StatsCollector(1, Symbol('adapter'));
    try {
      const pglite = makePglite(BigInt(99999));
      await c.freeze(pglite, process.hrtime.bigint());
      const callsAfterFreeze = (pglite.query as ReturnType<typeof vi.fn>).mock.calls.length;

      const s1 = await c.snapshot(pglite);
      const s2 = await c.snapshot(pglite);

      expect((pglite.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFreeze);
      expect(s1.dbSizeBytes).toBe(99999);
      expect(s2.dbSizeBytes).toBe(99999);
    } finally {
      c.stop();
    }
  });

  it('freeze uses the passed-in closeEntryHrtime for durationMs (not invocation time)', async () => {
    const c = new StatsCollector(1, Symbol('adapter'));
    try {
      const earlyTimestamp = process.hrtime.bigint();
      await sleep(50);
      await c.freeze(makePglite(), earlyTimestamp);
      const s = await c.snapshot(makePglite());
      expect(s.durationMs).toBeLessThan(50);
    } finally {
      c.stop();
    }
  });

  it('seals dbSizeFrozen even when queryDbSize rejects', async () => {
    const c = new StatsCollector(1, Symbol('adapter'));
    try {
      const throwing = {
        query: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as PGliteLike;

      await c.freeze(throwing, process.hrtime.bigint());
      const callsAfterFreeze = (throwing.query as ReturnType<typeof vi.fn>).mock.calls.length;

      await c.snapshot(throwing);
      await c.snapshot(throwing);

      expect((throwing.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFreeze);
    } finally {
      c.stop();
    }
  });

  it('ignores recordQuery / recordLockWait / incrementResetDb after freeze', async () => {
    const c = new StatsCollector(2, Symbol('adapter'));
    try {
      c.recordQuery(10, true);
      c.recordLockWait(5);
      c.incrementResetDb();
      await c.freeze(makePglite(), process.hrtime.bigint());
      const before = await c.snapshot(makePglite());
      if (before.statsLevel !== 2) throw new Error('expected level 2');

      c.recordQuery(999, false);
      c.recordLockWait(999);
      c.incrementResetDb();
      const after = await c.snapshot(makePglite());
      if (after.statsLevel !== 2) throw new Error('expected level 2');

      expect(after.queryCount).toBe(before.queryCount);
      expect(after.failedQueryCount).toBe(before.failedQueryCount);
      expect(after.resetDbCalls).toBe(before.resetDbCalls);
      expect(after.sessionLockAcquisitionCount).toBe(before.sessionLockAcquisitionCount);
    } finally {
      c.stop();
    }
  });
});

describe('StatsCollector — level 2 RSS sampler', () => {
  let memSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    memSpy = undefined;
  });

  afterEach(() => {
    memSpy?.mockRestore();
  });

  it('short-run: memoryUsage is called exactly twice (construct + freeze) and peak > 0', async () => {
    memSpy = vi.spyOn(process, 'memoryUsage');
    const c = new StatsCollector(2, Symbol('adapter'));
    try {
      await c.freeze(makePglite(), process.hrtime.bigint());
      expect(memSpy.mock.calls.length).toBe(2);
      const s = await c.snapshot(makePglite());
      if (s.statsLevel !== 2) throw new Error('expected level 2');
      expect(s.processRssPeakBytes).toBeGreaterThan(0);
    } finally {
      c.stop();
    }
  });

  it('interval sampler fires on schedule (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      memSpy = vi.spyOn(process, 'memoryUsage');
      const c = new StatsCollector(2, Symbol('adapter'));
      try {
        const afterCtor = memSpy.mock.calls.length;
        vi.advanceTimersByTime(500);
        expect(memSpy.mock.calls.length).toBe(afterCtor + 1);
        vi.advanceTimersByTime(2_000);
        expect(memSpy.mock.calls.length).toBe(afterCtor + 5);
      } finally {
        c.stop();
        vi.advanceTimersByTime(10_000);
        const afterStop = memSpy.mock.calls.length;
        vi.advanceTimersByTime(10_000);
        expect(memSpy.mock.calls.length).toBe(afterStop);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('StatsCollector — queryDbSize robustness', () => {
  it('returns undefined when pg_database_size yields a non-numeric value', async () => {
    await withCollector(1, async (c) => {
      const pglite = {
        query: vi.fn().mockResolvedValue({ rows: [{ size: 'not-a-number' }] }),
      } as unknown as PGliteLike;
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });

  it('returns undefined when the single column is null', async () => {
    await withCollector(1, async (c) => {
      const pglite = {
        query: vi.fn().mockResolvedValue({ rows: [{ size: null }] }),
      } as unknown as PGliteLike;
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });

  it('returns undefined when rows is empty', async () => {
    await withCollector(1, async (c) => {
      const pglite = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      } as unknown as PGliteLike;
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });
});

describe('StatsCollector — level 2 session-lock accumulation', () => {
  it('recordLockWait(5), (15), (10) produces total=30, max=15, count=3, avg=10', async () => {
    await withCollector(2, async (c) => {
      c.recordLockWait(5);
      c.recordLockWait(15);
      c.recordLockWait(10);
      const s = await c.snapshot(makePglite());
      if (s.statsLevel !== 2) throw new Error('expected level 2');
      expect(s.totalSessionLockWaitMs).toBe(30);
      expect(s.maxSessionLockWaitMs).toBe(15);
      expect(s.sessionLockAcquisitionCount).toBe(3);
      expect(s.avgSessionLockWaitMs).toBe(10);
    });
  });

  it('level 1 recordLockWait is a no-op and level-2 fields remain undefined', async () => {
    await withCollector(1, async (c) => {
      c.recordLockWait(100);
      c.recordLockWait(200);
      const s = await c.snapshot(makePglite());
      const bag = s as unknown as Record<string, unknown>;
      expect(bag.totalSessionLockWaitMs).toBeUndefined();
      expect(bag.maxSessionLockWaitMs).toBeUndefined();
      expect(bag.sessionLockAcquisitionCount).toBeUndefined();
      expect(bag.avgSessionLockWaitMs).toBeUndefined();
    });
  });
});

describe('StatsCollector — channel subscription', () => {
  it('ingests QUERY_CHANNEL events for its adapterId', async () => {
    const adapterId = Symbol('adapter');
    const c = new StatsCollector(1, adapterId);
    try {
      const event: QueryEvent = { adapterId, durationMs: 17, succeeded: true };
      queryChannel.publish(event);
      const s = await c.snapshot(makePglite());
      expect(s.queryCount).toBe(1);
      expect(s.totalQueryMs).toBe(17);
    } finally {
      c.stop();
    }
  });

  it('ignores QUERY_CHANNEL events tagged with a different adapterId', async () => {
    const mine = Symbol('adapter');
    const other = Symbol('adapter');
    const c = new StatsCollector(1, mine);
    try {
      const event: QueryEvent = { adapterId: other, durationMs: 99, succeeded: true };
      queryChannel.publish(event);
      const s = await c.snapshot(makePglite());
      expect(s.queryCount).toBe(0);
      expect(s.totalQueryMs).toBe(0);
    } finally {
      c.stop();
    }
  });

  it('two collectors in the same process see only their own events', async () => {
    const idA = Symbol('adapter-a');
    const idB = Symbol('adapter-b');
    const a = new StatsCollector(1, idA);
    const b = new StatsCollector(1, idB);
    try {
      queryChannel.publish({ adapterId: idA, durationMs: 10, succeeded: true } as QueryEvent);
      queryChannel.publish({ adapterId: idB, durationMs: 20, succeeded: true } as QueryEvent);
      queryChannel.publish({ adapterId: idB, durationMs: 30, succeeded: false } as QueryEvent);
      const sa = await a.snapshot(makePglite());
      const sb = await b.snapshot(makePglite());
      expect(sa.queryCount).toBe(1);
      expect(sa.totalQueryMs).toBe(10);
      expect(sa.failedQueryCount).toBe(0);
      expect(sb.queryCount).toBe(2);
      expect(sb.totalQueryMs).toBe(50);
      expect(sb.failedQueryCount).toBe(1);
    } finally {
      a.stop();
      b.stop();
    }
  });

  it('level 2 ingests LOCK_WAIT_CHANNEL events', async () => {
    const adapterId = Symbol('adapter');
    const c = new StatsCollector(2, adapterId);
    try {
      lockWaitChannel.publish({ adapterId, durationMs: 7 } as LockWaitEvent);
      lockWaitChannel.publish({ adapterId, durationMs: 3 } as LockWaitEvent);
      const s = await c.snapshot(makePglite());
      if (s.statsLevel !== 2) throw new Error('expected level 2');
      expect(s.sessionLockAcquisitionCount).toBe(2);
      expect(s.totalSessionLockWaitMs).toBe(10);
    } finally {
      c.stop();
    }
  });
});

describe('StatsCollector — lifecycle unsubscribe', () => {
  it('stop() removes the QUERY_CHANNEL subscription (level 1)', () => {
    expect(queryChannel.hasSubscribers).toBe(false);
    const c = new StatsCollector(1, Symbol('adapter'));
    expect(queryChannel.hasSubscribers).toBe(true);
    expect(lockWaitChannel.hasSubscribers).toBe(false);
    c.stop();
    expect(queryChannel.hasSubscribers).toBe(false);
  });

  it('stop() removes both channel subscriptions at level 2', () => {
    expect(queryChannel.hasSubscribers).toBe(false);
    expect(lockWaitChannel.hasSubscribers).toBe(false);
    const c = new StatsCollector(2, Symbol('adapter'));
    expect(queryChannel.hasSubscribers).toBe(true);
    expect(lockWaitChannel.hasSubscribers).toBe(true);
    c.stop();
    expect(queryChannel.hasSubscribers).toBe(false);
    expect(lockWaitChannel.hasSubscribers).toBe(false);
  });

  it('freeze() unsubscribes via stop() (level 2)', async () => {
    const c = new StatsCollector(2, Symbol('adapter'));
    expect(queryChannel.hasSubscribers).toBe(true);
    expect(lockWaitChannel.hasSubscribers).toBe(true);
    await c.freeze(makePglite(), process.hrtime.bigint());
    expect(queryChannel.hasSubscribers).toBe(false);
    expect(lockWaitChannel.hasSubscribers).toBe(false);
  });
});
