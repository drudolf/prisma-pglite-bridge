import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPglite } from '../__tests__/mocks.ts';
import { AdapterStats, QUERY_DURATION_WINDOW_SIZE } from './adapter-stats.ts';

let pglite: Parameters<AdapterStats['snapshot']>[0];

const withStats = async (level: 'basic' | 'full', fn: (c: AdapterStats) => Promise<void>) => {
  const c = new AdapterStats(level);
  await fn(c);
};

beforeEach(() => {
  pglite = createMockPglite({ query: vi.fn().mockResolvedValue({ rows: [{ size: 12345n }] }) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdapterStats — percentile math', () => {
  it('computes p50/p95/max for [10,20,30,40,50]', async () => {
    await withStats('basic', async (c) => {
      for (const d of [10, 20, 30, 40, 50]) c.recordQuery(d, true);
      const s = await c.snapshot(pglite);
      expect(s.recentP50QueryMs).toBe(30);
      expect(s.recentP95QueryMs).toBe(50);
      expect(s.recentMaxQueryMs).toBe(50);
    });
  });

  it('computes p50/p95/max for [1..100]', async () => {
    await withStats('basic', async (c) => {
      for (let i = 1; i <= 100; i++) c.recordQuery(i, true);
      const s = await c.snapshot(pglite);
      expect(s.recentP50QueryMs).toBe(50);
      expect(s.recentP95QueryMs).toBe(95);
      expect(s.recentMaxQueryMs).toBe(100);
    });
  });

  it('sorts unsorted input before computing percentiles', async () => {
    await withStats('basic', async (c) => {
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

    const c = new AdapterStats('basic');
    hrtimeSpy.mockReturnValueOnce(1_005_000_000n);
    const s = await c.snapshot(pglite);
    expect(s.queryCount).toBe(0);
    expect(s.avgQueryMs).toBe(0);
    expect(s.recentP50QueryMs).toBe(0);
    expect(s.recentP95QueryMs).toBe(0);
    expect(s.recentMaxQueryMs).toBe(0);
    expect(s.durationMs).toBeGreaterThan(0);
  });

  it('n === 1: p50 === p95 === max === the single duration', async () => {
    await withStats('basic', async (c) => {
      c.recordQuery(42, true);
      const s = await c.snapshot(pglite);
      expect(s.recentP50QueryMs).toBe(42);
      expect(s.recentP95QueryMs).toBe(42);
      expect(s.recentMaxQueryMs).toBe(42);
    });
  });

  it('ring buffer: recent window reflects only last QUERY_DURATION_WINDOW_SIZE entries; lifetime counters stay complete', async () => {
    await withStats('basic', async (c) => {
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
    await withStats('basic', async (c) => {
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
    await withStats('basic', async (c) => {
      c.recordQuery(5, false);
      const s = await c.snapshot(pglite);
      expect(s.queryCount).toBe(1);
      expect(s.failedQueryCount).toBe(1);
      expect(s.totalQueryMs).toBe(5);
    });
  });

  it('markSchemaSetup: first call wins', async () => {
    await withStats('basic', async (c) => {
      c.markSchemaSetup(42);
      c.markSchemaSetup(777);
      const s = await c.snapshot(pglite);
      expect(s.schemaSetupMs).toBe(42);
    });
  });

  it('incrementResetDb counts each call', async () => {
    await withStats('basic', async (c) => {
      c.incrementResetDb();
      c.incrementResetDb();
      c.incrementResetDb();
      const s = await c.snapshot(pglite);
      expect(s.resetDbCalls).toBe(3);
    });
  });
});

describe('AdapterStats — snapshot level gating', () => {
  it(`'basic': statsLevel === 'basic' and 'full'-only fields are undefined`, async () => {
    await withStats('basic', async (c) => {
      const s = await c.snapshot(pglite);
      expect(s.statsLevel).toBe('basic');
      expect(s).not.toHaveProperty('processRssPeakBytes');
      expect(s).not.toHaveProperty('totalSessionLockWaitMs');
      expect(s).not.toHaveProperty('sessionLockAcquisitionCount');
      expect(s).not.toHaveProperty('avgSessionLockWaitMs');
      expect(s).not.toHaveProperty('maxSessionLockWaitMs');
    });
  });

  it(`'full': statsLevel === 'full' and 'full'-only fields are defined with session-lock defaults`, async () => {
    await withStats('full', async (c) => {
      const s = await c.snapshot(pglite);
      if (s.statsLevel !== 'full') throw new Error("expected level 'full'");
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
    await withStats('basic', async (c) => {
      vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [{ size: 54321n }] });
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBe(54321);
    });
  });

  it('snapshot tolerates a rejecting pglite.query: dbSizeBytes undefined, rest returns', async () => {
    await withStats('basic', async (c) => {
      c.recordQuery(10, true);
      vi.mocked(pglite.query).mockRejectedValueOnce(new Error('broken'));
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
      expect(s.queryCount).toBe(1);
      expect(s.totalQueryMs).toBe(10);
      expect(s.statsLevel).toBe('basic');
    });
  });
});

describe('AdapterStats — freeze()', () => {
  it('post-freeze snapshots use cached values and do not call pglite.query', async () => {
    const c = new AdapterStats('basic');
    vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [{ size: 99999n }] });
    await c.freeze(pglite, process.hrtime.bigint());
    const callsAfterFreeze = vi.mocked(pglite.query).mock.calls.length;

    const s1 = await c.snapshot(pglite);
    const s2 = await c.snapshot(pglite);

    expect(vi.mocked(pglite.query).mock.calls.length).toBe(callsAfterFreeze);
    expect(s1.dbSizeBytes).toBe(99999);
    expect(s2.dbSizeBytes).toBe(99999);
  });

  it('freeze uses the passed-in closeEntryHrtime for durationMs (not invocation time)', async () => {
    const hrtimeSpy = vi.spyOn(process.hrtime, 'bigint');
    hrtimeSpy.mockReturnValueOnce(1_000_000_000n);

    const c = new AdapterStats('basic');
    const earlyTimestamp = 1_010_000_000n;
    await c.freeze(pglite, earlyTimestamp);
    const s = await c.snapshot(pglite);
    expect(s.durationMs).toBe(10);
  });

  it('seals dbSizeFrozen even when queryDbSize rejects', async () => {
    const c = new AdapterStats('basic');
    vi.mocked(pglite.query).mockRejectedValue(new Error('boom'));

    await c.freeze(pglite, process.hrtime.bigint());
    const callsAfterFreeze = vi.mocked(pglite.query).mock.calls.length;

    await c.snapshot(pglite);
    await c.snapshot(pglite);

    expect(vi.mocked(pglite.query).mock.calls.length).toBe(callsAfterFreeze);
  });

  it('freeze is idempotent after the instance is already frozen', async () => {
    const c = new AdapterStats('basic');
    vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [{ size: 123n }] });

    await c.freeze(pglite, process.hrtime.bigint());
    const callsAfterFirstFreeze = vi.mocked(pglite.query).mock.calls.length;
    const snapshotAfterFirstFreeze = await c.snapshot(pglite);

    await c.freeze(pglite, process.hrtime.bigint());
    const snapshotAfterSecondFreeze = await c.snapshot(pglite);

    expect(vi.mocked(pglite.query).mock.calls.length).toBe(callsAfterFirstFreeze);
    expect(snapshotAfterSecondFreeze).toEqual(snapshotAfterFirstFreeze);
  });

  it('resolves within the timeout when pglite.query hangs, and leaves dbSizeBytes undefined', async () => {
    vi.useFakeTimers();
    const c = new AdapterStats('basic');
    try {
      vi.mocked(pglite.query).mockReturnValue(new Promise(() => {}) as Promise<never>);

      const freezePromise = c.freeze(pglite, process.hrtime.bigint());
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(freezePromise).resolves.toBeUndefined();

      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores recordQuery / recordLockWait / incrementResetDb after freeze', async () => {
    const c = new AdapterStats('full');
    c.recordQuery(10, true);
    c.recordLockWait(5);
    c.incrementResetDb();
    await c.freeze(pglite, process.hrtime.bigint());
    const before = await c.snapshot(pglite);
    if (before.statsLevel !== 'full') throw new Error("expected level 'full'");

    c.recordQuery(999, false);
    c.recordLockWait(999);
    c.incrementResetDb();
    const after = await c.snapshot(pglite);
    if (after.statsLevel !== 'full') throw new Error("expected level 'full'");

    expect(after.queryCount).toBe(before.queryCount);
    expect(after.failedQueryCount).toBe(before.failedQueryCount);
    expect(after.resetDbCalls).toBe(before.resetDbCalls);
    expect(after.sessionLockAcquisitionCount).toBe(before.sessionLockAcquisitionCount);
  });
});

describe(`AdapterStats — 'full' processRssPeakBytes`, () => {
  it('reads process.resourceUsage().maxRSS and converts kilobytes to bytes', async () => {
    const resourceSpy = vi.spyOn(process, 'resourceUsage').mockReturnValue({
      userCPUTime: 0,
      systemCPUTime: 0,
      maxRSS: 12_345,
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    });
    try {
      await withStats('full', async (c) => {
        const s = await c.snapshot(pglite);
        if (s.statsLevel !== 'full') throw new Error("expected level 'full'");
        expect(s.processRssPeakBytes).toBe(12_345 * 1024);
      });
    } finally {
      resourceSpy.mockRestore();
    }
  });

  it('returns undefined processRssPeakBytes when process.resourceUsage throws', async () => {
    const resourceSpy = vi.spyOn(process, 'resourceUsage').mockImplementation(() => {
      throw new TypeError('process.resourceUsage is not a function');
    });
    try {
      await withStats('full', async (c) => {
        const s = await c.snapshot(pglite);
        if (s.statsLevel !== 'full') throw new Error("expected level 'full'");
        expect(s.processRssPeakBytes).toBeUndefined();
      });
    } finally {
      resourceSpy.mockRestore();
    }
  });
});

describe('AdapterStats — queryDbSize robustness', () => {
  it('returns undefined when pg_database_size yields a non-numeric value', async () => {
    await withStats('basic', async (c) => {
      vi.mocked(pglite.query).mockResolvedValueOnce({
        fields: [],
        rows: [{ size: 'not-a-number' }],
      });
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });

  it('returns undefined when the single column is null', async () => {
    await withStats('basic', async (c) => {
      vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [{ size: null }] });
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });

  it('returns undefined when rows is empty', async () => {
    await withStats('basic', async (c) => {
      vi.mocked(pglite.query).mockResolvedValueOnce({ fields: [], rows: [] });
      const s = await c.snapshot(pglite);
      expect(s.dbSizeBytes).toBeUndefined();
    });
  });
});

describe(`AdapterStats — 'full' session-lock accumulation`, () => {
  it('recordLockWait(5), (15), (10) produces total=30, max=15, count=3, avg=10', async () => {
    await withStats('full', async (c) => {
      c.recordLockWait(5);
      c.recordLockWait(15);
      c.recordLockWait(10);
      const s = await c.snapshot(pglite);
      if (s.statsLevel !== 'full') throw new Error("expected level 'full'");
      expect(s.totalSessionLockWaitMs).toBe(30);
      expect(s.maxSessionLockWaitMs).toBe(15);
      expect(s.sessionLockAcquisitionCount).toBe(3);
      expect(s.avgSessionLockWaitMs).toBe(10);
    });
  });

  it(`'basic' recordLockWait is a no-op and 'full'-only fields remain undefined`, async () => {
    await withStats('basic', async (c) => {
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

describe('AdapterStats — freeze preserves cached state', () => {
  it(`freeze() retains cached 'full' state across snapshots`, async () => {
    const c = new AdapterStats('full');
    c.recordQuery(11, true);
    c.recordLockWait(7);
    await c.freeze(pglite, process.hrtime.bigint());
    const s = await c.snapshot(pglite);
    if (s.statsLevel !== 'full') throw new Error("expected level 'full'");
    expect(s.queryCount).toBe(1);
    expect(s.totalSessionLockWaitMs).toBe(7);
  });
});
