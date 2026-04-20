import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterStats, QUERY_DURATION_WINDOW_SIZE } from './adapter-stats.ts';

let pglite: Parameters<AdapterStats['snapshot']>[0];

const withStats = async (level: 1 | 2, fn: (c: AdapterStats) => Promise<void>) => {
  const c = new AdapterStats(level);
  try {
    await fn(c);
  } finally {
    c.stop();
  }
};

beforeEach(() => {
  pglite = { query: vi.fn().mockResolvedValue({ rows: [{ size: 12345n }] }) };
});

describe('AdapterStats — percentile math', () => {
  it('computes p50/p95/max for [10,20,30,40,50]', async () => {
    await withStats(1, async (c) => {
      for (const d of [10, 20, 30, 40, 50]) c.recordQuery(d, true);
      const s = await c.snapshot(pglite);
      expect(s.recentP50QueryMs).toBe(30);
      expect(s.recentP95QueryMs).toBe(50);
      expect(s.recentMaxQueryMs).toBe(50);
    });
  });

  it('computes p50/p95/max for [1..100]', async () => {
    await withStats(1, async (c) => {
      for (let i = 1; i <= 100; i++) c.recordQuery(i, true);
      const s = await c.snapshot(pglite);
      expect(s.recentP50QueryMs).toBe(50);
      expect(s.recentP95QueryMs).toBe(95);
      expect(s.recentMaxQueryMs).toBe(100);
    });
  });

  it('sorts unsorted input before computing percentiles', async () => {
    await withStats(1, async (c) => {
      for (const d of [50, 10, 40, 20, 30]) c.recordQuery(d, true);
      const s = await c.snapshot(pglite);
      expect(s.recentP50QueryMs).toBe(30);
      expect(s.recentP95QueryMs).toBe(50);
      expect(s.recentMaxQueryMs).toBe(50);
    });
  });

  it('n === 0: all percentiles and avg are 0, durationMs > 0 after await', async () => {
    const hrtimeSpy = vi.spyOn(process.hrtime, 'bigint');
    hrtimeSpy.mockReturnValueOnce(1_000_000_000n);

    const c = new AdapterStats(1);
    try {
      hrtimeSpy.mockReturnValueOnce(1_005_000_000n);
      const s = await c.snapshot(pglite);
      expect(s.queryCount).toBe(0);
      expect(s.avgQueryMs).toBe(0);
      expect(s.recentP50QueryMs).toBe(0);
      expect(s.recentP95QueryMs).toBe(0);
      expect(s.recentMaxQueryMs).toBe(0);
      expect(s.durationMs).toBeGreaterThan(0);
    } finally {
      hrtimeSpy.mockRestore();
      c.stop();
    }
  });

  it('n === 1: p50 === p95 === max === the single duration', async () => {
    await withStats(1, async (c) => {
      c.recordQuery(42, true);
      const s = await c.snapshot(pglite);
      expect(s.recentP50QueryMs).toBe(42);
      expect(s.recentP95QueryMs).toBe(42);
      expect(s.recentMaxQueryMs).toBe(42);
    });
  });

  it('ring buffer: recent window reflects only last QUERY_DURATION_WINDOW_SIZE entries; lifetime counters stay complete', async () => {
    await withStats(1, async (c) => {
      const trimThreshold = QUERY_DURATION_WINDOW_SIZE * 2;
      for (let i = 0; i < trimThreshold; i++) c.recordQuery(1, true);
      for (let i = 0; i < trimThreshold; i++) c.recordQuery(999, true);
      const s = await c.snapshot(pglite);
      expect(s.queryCount).toBe(trimThreshold * 2);
      expect(s.recentP50QueryMs).toBe(999);
      expect(s.recentP95QueryMs).toBe(999);
      expect(s.recentMaxQueryMs).toBe(999);
    });
  });
});

describe('AdapterStats — counters', () => {
  it('recordQuery is additive across calls', async () => {
    await withStats(1, async (c) => {
      c.recordQuery(10, true);
      c.recordQuery(20, true);
      c.recordQuery(30, true);
      const s = await c.snapshot(pglite);
      expect(s.queryCount).toBe(3);
      expect(s.totalQueryMs).toBe(60);
      expect(s.avgQueryMs).toBe(20);
      expect(s.failedQueryCount).toBe(0);
    });
  });

  it('failed query increments queryCount AND failedQueryCount, adds to totalQueryMs', async () => {
    await withStats(1, async (c) => {
      c.recordQuery(5, false);
      const s = await c.snapshot(pglite);
      expect(s.queryCount).toBe(1);
      expect(s.failedQueryCount).toBe(1);
      expect(s.totalQueryMs).toBe(5);
    });
  });

  it('markWasmInit: first call wins', async () => {
    await withStats(1, async (c) => {
      c.markWasmInit(100);
      c.markWasmInit(999);
      c.markWasmInit(1);
      const s = await c.snapshot(pglite);
      expect(s.wasmInitMs).toBe(100);
    });
  });

  it('markSchemaSetup: first call wins', async () => {
    await withStats(1, async (c) => {
      c.markSchemaSetup(42);
      c.markSchemaSetup(777);
      const s = await c.snapshot(pglite);
      expect(s.schemaSetupMs).toBe(42);
    });
  });

  it('incrementResetDb counts each call', async () => {
    await withStats(1, async (c) => {
      c.incrementResetDb();
      c.incrementResetDb();
      c.incrementResetDb();
      const s = await c.snapshot(pglite);
      expect(s.resetDbCalls).toBe(3);
    });
  });
});

describe('AdapterStats — snapshot level gating', () => {
  it('level 1: statsLevel === 1 and level-2 fields are undefined', async () => {
    await withStats(1, async (c) => {
      const s = await c.snapshot(pglite);
      expect(s.statsLevel).toBe(1);
      expect(s).not.toHaveProperty('processRssPeakBytes');
      expect(s).not.toHaveProperty('totalSessionLockWaitMs');
      expect(s).not.toHaveProperty('sessionLockAcquisitionCount');
      expect(s).not.toHaveProperty('avgSessionLockWaitMs');
      expect(s).not.toHaveProperty('maxSessionLockWaitMs');
    });
  });

  it('level 2: statsLevel === 2 and level-2 fields are defined with session-lock defaults', async () => {
    await withStats(2, async (c) => {
      const s = await c.snapshot(pglite);
      if (s.statsLevel !== 2) throw new Error('expected level 2');
      expect(s.processRssPeakBytes).toBeGreaterThan(0);
      expect(s.totalSessionLockWaitMs).toBe(0);
      expect(s.sessionLockAcquisitionCount).toBe(0);
      expect(s.avgSessionLockWaitMs).toBe(0);
      expect(s.maxSessionLockWaitMs).toBe(0);
    });
  });
});

describe('AdapterStats — pglite query robustness', () => {
  it('snapshot parses dbSizeBytes from the single column of rows[0]', async () => {
    await withStats(1, async (c) => {
      vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [{ size: 54321n }] });
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBe(54321);
    });
  });

  it('snapshot tolerates a rejecting pglite.query: dbSizeBytes undefined, rest returns', async () => {
    await withStats(1, async (c) => {
      c.recordQuery(10, true);
      vi.mocked(pglite.query).mockRejectedValueOnce(new Error('broken'));
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
      expect(s.queryCount).toBe(1);
      expect(s.totalQueryMs).toBe(10);
      expect(s.statsLevel).toBe(1);
    });
  });
});

describe('AdapterStats — freeze()', () => {
  it('post-freeze snapshots use cached values and do not call pglite.query', async () => {
    const c = new AdapterStats(1);
    try {
      vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [{ size: 99999n }] });
      await c.freeze(pglite, process.hrtime.bigint());
      const callsAfterFreeze = vi.mocked(pglite.query).mock.calls.length;

      const s1 = await c.snapshot(pglite);
      const s2 = await c.snapshot(pglite);

      expect(vi.mocked(pglite.query).mock.calls.length).toBe(callsAfterFreeze);
      expect(s1.dbSizeBytes).toBe(99999);
      expect(s2.dbSizeBytes).toBe(99999);
    } finally {
      c.stop();
    }
  });

  it('freeze uses the passed-in closeEntryHrtime for durationMs (not invocation time)', async () => {
    const hrtimeSpy = vi.spyOn(process.hrtime, 'bigint');
    hrtimeSpy.mockReturnValueOnce(1_000_000_000n);

    const c = new AdapterStats(1);
    try {
      const earlyTimestamp = 1_010_000_000n;
      await c.freeze(pglite, earlyTimestamp);
      const s = await c.snapshot(pglite);
      expect(s.durationMs).toBe(10);
    } finally {
      hrtimeSpy.mockRestore();
      c.stop();
    }
  });

  it('seals dbSizeFrozen even when queryDbSize rejects', async () => {
    const c = new AdapterStats(1);
    try {
      vi.mocked(pglite.query).mockRejectedValue(new Error('boom'));

      await c.freeze(pglite, process.hrtime.bigint());
      const callsAfterFreeze = vi.mocked(pglite.query).mock.calls.length;

      await c.snapshot(pglite);
      await c.snapshot(pglite);

      expect(vi.mocked(pglite.query).mock.calls.length).toBe(callsAfterFreeze);
    } finally {
      c.stop();
    }
  });

  it('freeze is idempotent after the instance is already frozen', async () => {
    const c = new AdapterStats(1);
    try {
      vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [{ size: 123n }] });

      await c.freeze(pglite, process.hrtime.bigint());
      const callsAfterFirstFreeze = vi.mocked(pglite.query).mock.calls.length;
      const snapshotAfterFirstFreeze = await c.snapshot(pglite);

      await c.freeze(pglite, process.hrtime.bigint());
      const snapshotAfterSecondFreeze = await c.snapshot(pglite);

      expect(vi.mocked(pglite.query).mock.calls.length).toBe(callsAfterFirstFreeze);
      expect(snapshotAfterSecondFreeze).toEqual(snapshotAfterFirstFreeze);
    } finally {
      c.stop();
    }
  });

  it('ignores recordQuery / recordLockWait / incrementResetDb after freeze', async () => {
    const c = new AdapterStats(2);
    try {
      c.recordQuery(10, true);
      c.recordLockWait(5);
      c.incrementResetDb();
      await c.freeze(pglite, process.hrtime.bigint());
      const before = await c.snapshot(pglite);
      if (before.statsLevel !== 2) throw new Error('expected level 2');

      c.recordQuery(999, false);
      c.recordLockWait(999);
      c.incrementResetDb();
      const after = await c.snapshot(pglite);
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

describe('AdapterStats — level 2 RSS sampler', () => {
  let memSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    memSpy = undefined;
  });

  afterEach(() => {
    memSpy?.mockRestore();
  });

  it('short-run: memoryUsage is called exactly twice (construct + freeze) and peak > 0', async () => {
    memSpy = vi.spyOn(process, 'memoryUsage');
    const c = new AdapterStats(2);
    try {
      await c.freeze(pglite, process.hrtime.bigint());
      expect(memSpy.mock.calls.length).toBe(2);
      const s = await c.snapshot(pglite);
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
      const c = new AdapterStats(2);
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

describe('AdapterStats — queryDbSize robustness', () => {
  it('returns undefined when pg_database_size yields a non-numeric value', async () => {
    await withStats(1, async (c) => {
      vi.mocked(pglite.query).mockResolvedValueOnce({
        fields: [],
        rows: [{ size: 'not-a-number' }],
      });
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });

  it('returns undefined when the single column is null', async () => {
    await withStats(1, async (c) => {
      vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [{ size: null }] });
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });

  it('returns undefined when rows is empty', async () => {
    await withStats(1, async (c) => {
      vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [] });
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });
});

describe('AdapterStats — level 2 session-lock accumulation', () => {
  it('recordLockWait(5), (15), (10) produces total=30, max=15, count=3, avg=10', async () => {
    await withStats(2, async (c) => {
      c.recordLockWait(5);
      c.recordLockWait(15);
      c.recordLockWait(10);
      const s = await c.snapshot(pglite);
      if (s.statsLevel !== 2) throw new Error('expected level 2');
      expect(s.totalSessionLockWaitMs).toBe(30);
      expect(s.maxSessionLockWaitMs).toBe(15);
      expect(s.sessionLockAcquisitionCount).toBe(3);
      expect(s.avgSessionLockWaitMs).toBe(10);
    });
  });

  it('level 1 recordLockWait is a no-op and level-2 fields remain undefined', async () => {
    await withStats(1, async (c) => {
      c.recordLockWait(100);
      c.recordLockWait(200);
      const s = await c.snapshot(pglite);
      expect(s).not.toHaveProperty('totalSessionLockWaitMs');
      expect(s).not.toHaveProperty('maxSessionLockWaitMs');
      expect(s).not.toHaveProperty('sessionLockAcquisitionCount');
      expect(s).not.toHaveProperty('avgSessionLockWaitMs');
    });
  });
});

describe('AdapterStats — lifecycle stop', () => {
  it('stop() is a no-op for level 1 state beyond cleanup safety', () => {
    const c = new AdapterStats(1);
    c.stop();
    c.stop();
  });

  it('freeze() retains cached level-2 state after stop() cleanup', async () => {
    const c = new AdapterStats(2);
    c.recordQuery(11, true);
    c.recordLockWait(7);
    await c.freeze(pglite, process.hrtime.bigint());
    const s = await c.snapshot(pglite);
    if (s.statsLevel !== 2) throw new Error('expected level 2');
    expect(s.queryCount).toBe(1);
    expect(s.totalSessionLockWaitMs).toBe(7);
  });
});
