import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createTestPgliteAdapter } from './__tests__/adapter.ts';
import type { StatsLevel } from './utils/adapter-stats.ts';

describe('stats collection', () => {
  it('level 0: explicit and default config both keep stats off', async () => {
    const explicit = await createTestPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 0,
    });
    const implicit = await createTestPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
    });
    try {
      expect(await explicit.stats()).toBeUndefined();
      expect(await implicit.stats()).toBeUndefined();
    } finally {
      await explicit.close();
      await implicit.close();
    }
  });

  it('rejects out-of-range statsLevel at runtime', async () => {
    await expect(
      createTestPgliteAdapter({
        sql: 'CREATE TABLE s (id int PRIMARY KEY)',
        statsLevel: -1 as unknown as StatsLevel,
      }),
    ).rejects.toThrow(/statsLevel must be 0, 1, or 2/);
    await expect(
      createTestPgliteAdapter({
        sql: 'CREATE TABLE s (id int PRIMARY KEY)',
        statsLevel: 3 as unknown as StatsLevel,
      }),
    ).rejects.toThrow(/statsLevel must be 0, 1, or 2/);
  });

  it('level 1 tracks zero-state, successes, failures, simple queries, and resetDb', async () => {
    const { adapter, stats, resetDb, close } = await createTestPgliteAdapter({
      sql: 'CREATE TABLE stat_tbl (id serial PRIMARY KEY, name text NOT NULL)',
      statsLevel: 1,
    });
    const prisma = new PrismaClient({ adapter });
    try {
      const initial = await stats();
      if (initial === undefined) throw new Error('stats() returned undefined');
      expect(initial.statsLevel).toBe(1);
      expect(initial.queryCount).toBe(0);
      expect(initial.failedQueryCount).toBe(0);
      expect(initial.totalQueryMs).toBe(0);
      expect(initial.avgQueryMs).toBe(0);
      expect(initial.recentP50QueryMs).toBe(0);
      expect(initial.recentP95QueryMs).toBe(0);
      expect(initial.recentMaxQueryMs).toBe(0);
      expect(initial.resetDbCalls).toBe(0);
      expect(initial.durationMs).toBeGreaterThan(0);
      expect(initial.dbSizeBytes).toBeGreaterThan(0);

      await prisma.$executeRawUnsafe("INSERT INTO stat_tbl (name) VALUES ('a')");
      await prisma.$executeRawUnsafe("INSERT INTO stat_tbl (name) VALUES ('b')");
      await prisma.$queryRawUnsafe('SELECT * FROM stat_tbl');
      await resetDb();

      const afterRoundTrips = await stats();
      if (afterRoundTrips === undefined) throw new Error('stats() returned undefined');
      expect(afterRoundTrips.statsLevel).toBe(1);
      expect(afterRoundTrips.queryCount).toBeGreaterThan(0);
      expect(afterRoundTrips.failedQueryCount).toBe(0);
      expect(afterRoundTrips.resetDbCalls).toBe(1);
      expect(afterRoundTrips.durationMs).toBeGreaterThan(0);
      expect(afterRoundTrips.avgQueryMs).toBeGreaterThan(0);
      expect(afterRoundTrips.dbSizeBytes).toBeGreaterThan(0);
      expect(afterRoundTrips.wasmInitMs).toBeGreaterThan(0);
      expect(afterRoundTrips.schemaSetupMs).toBeGreaterThan(0);

      await prisma.$executeRawUnsafe('SELECT 1');
      const afterSimple = await stats();
      if (afterSimple === undefined) throw new Error('stats() returned undefined');
      expect(afterSimple.queryCount).toBeGreaterThan(afterRoundTrips.queryCount);
      expect(afterSimple.totalQueryMs).toBeGreaterThan(afterRoundTrips.totalQueryMs);

      await expect(prisma.$queryRawUnsafe('SELECT * FROM nonexistent_table_xyz')).rejects.toThrow();
      const afterFailure = await stats();
      if (afterFailure === undefined) throw new Error('stats() returned undefined');
      expect(afterFailure.queryCount).toBeGreaterThan(afterSimple.queryCount);
      expect(afterFailure.failedQueryCount).toBeGreaterThan(afterSimple.failedQueryCount);
      expect(afterFailure.totalQueryMs).toBeGreaterThan(afterSimple.totalQueryMs);
    } finally {
      await prisma.$disconnect();
      await close();
    }
  });

  it('level 2 live and post-close stats expose the expected extra fields', async () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');
    try {
      const { adapter, stats, close } = await createTestPgliteAdapter({
        sql: 'CREATE TABLE s (id int PRIMARY KEY)',
        statsLevel: 2,
      });
      const prisma = new PrismaClient({ adapter });
      try {
        await prisma.$executeRawUnsafe('INSERT INTO s (id) VALUES (1)');

        const live = await stats();
        if (live === undefined) throw new Error('stats() returned undefined');
        if (live.statsLevel !== 2) throw new Error('expected level 2');
        expect(typeof live.processRssPeakBytes).toBe('number');
        expect(live.processRssPeakBytes).toBeGreaterThan(0);
        expect(typeof live.totalSessionLockWaitMs).toBe('number');
        expect(typeof live.sessionLockAcquisitionCount).toBe('number');
        expect(typeof live.avgSessionLockWaitMs).toBe('number');
        expect(typeof live.maxSessionLockWaitMs).toBe('number');
        expect(live.sessionLockAcquisitionCount).toBeGreaterThan(0);

        const baseline = memSpy.mock.calls.length;
        await prisma.$disconnect();
        await close();

        const frozen = await stats();
        if (frozen === undefined) throw new Error('stats() returned undefined');
        if (frozen.statsLevel !== 2) throw new Error('expected level 2');
        expect(memSpy.mock.calls.length - baseline).toBe(1);
        expect(typeof frozen.processRssPeakBytes).toBe('number');
        expect(frozen.processRssPeakBytes).toBeGreaterThan(0);
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      memSpy.mockRestore();
    }
  });

  it('level 1 close semantics: cached stats stay stable and close is re-entrant', async () => {
    const { adapter, pglite, stats, close } = await createTestPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 1,
    });
    const prisma = new PrismaClient({ adapter });
    try {
      await prisma.$executeRawUnsafe('INSERT INTO s (id) VALUES (1)');
      const preClose = await stats();
      if (preClose === undefined) throw new Error('pre-close stats null');

      await prisma.$disconnect();
      const querySpy = vi.spyOn(pglite, 'query');
      try {
        const closeA = close();
        const closeB = close();
        const closeC = close();
        const statsDuringClose = stats();
        const [a, b, c, snapDuringClose] = await Promise.all([
          closeA,
          closeB,
          closeC,
          statsDuringClose,
        ]);

        expect(a).toBe(b);
        expect(b).toBe(c);
        await expect(close()).resolves.toBeUndefined();

        if (snapDuringClose === undefined) throw new Error('concurrent stats null');
        expect(snapDuringClose.statsLevel).toBe(1);
        expect(snapDuringClose.durationMs).toBeGreaterThan(0);
        expect(snapDuringClose.queryCount).toBeGreaterThan(0);

        const callsAfterClose = querySpy.mock.calls.length;
        const post1 = await stats();
        const post2 = await stats();
        if (post1 === undefined || post2 === undefined) throw new Error('post-close stats null');

        expect(querySpy.mock.calls.length).toBe(callsAfterClose);
        expect(post1.durationMs).toBeGreaterThanOrEqual(preClose.durationMs);
        expect(post2.durationMs).toBe(post1.durationMs);
        expect(post1.dbSizeBytes).toBe(post2.dbSizeBytes);
        expect(post1.queryCount).toBe(post2.queryCount);
        expect(post1.queryCount).toBeGreaterThanOrEqual(preClose.queryCount);
      } finally {
        querySpy.mockRestore();
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});
