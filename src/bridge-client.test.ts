import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { BridgeClient, type BridgePoolConfig, bridgeClientOptionsKey } from './bridge-client.ts';
import { SessionLock } from './utils/session-lock.ts';

const createBridgePool = async (pglite: PGlite) => {
  await pglite.waitReady;
  const adapterId = Symbol('adapter');
  const poolConfig: BridgePoolConfig = {
    Client: BridgeClient,
    max: 1,
    [bridgeClientOptionsKey]: {
      pglite,
      sessionLock: new SessionLock(),
      adapterId,
      syncToFs: false,
    },
  };
  const pool = new pg.Pool(poolConfig);

  return {
    adapterId,
    close: () => pool.end(),
    pool,
  };
};

describe('BridgeClient', () => {
  it('throws when bridge options are missing', () => {
    expect(() => new BridgeClient()).toThrow('BridgeClient requires bridge options');
  });

  it('forwards deferred callback-form query failures to the callback', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const origQuery = pg.Client.prototype.query;
    const expected = new Error('boom');
    const client = new BridgeClient({
      [bridgeClientOptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        adapterId: Symbol('adapter'),
        syncToFs: false,
      },
    });

    try {
      pg.Client.prototype.query = vi.fn(() => {
        throw expected;
      }) as typeof pg.Client.prototype.query;

      await expect(
        new Promise<void>((resolve, reject) => {
          client.query('SELECT 1', (err: Error, res: pg.QueryResult | undefined) => {
            try {
              expect(err).toBe(expected);
              expect(res).toBeUndefined();
              resolve();
            } catch (assertErr) {
              reject(assertErr);
            }
          });
        }),
      ).resolves.toBeUndefined();
    } finally {
      pg.Client.prototype.query = origQuery;
      await pglite.close();
    }
  });

  it('preserves pg synchronous TypeError for nullish queries', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const client = new BridgeClient({
      [bridgeClientOptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        adapterId: Symbol('adapter'),
        syncToFs: false,
      },
    });

    try {
      expect(() => client.query(null as never)).toThrow();
      expect(() => client.query(undefined as never)).toThrow();
    } finally {
      await pglite.close();
    }
  });

  it('does not trigger pg same-client query-queue deprecation warning', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createBridgePool(pglite);
    const warnings: string[] = [];
    const origEmit = process.emitWarning.bind(process);
    process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
      warnings.push(typeof w === 'string' ? w : String((w as Error)?.message ?? w));
      // biome-ignore lint/suspicious/noExplicitAny: wrapping overloaded signature
      return (origEmit as any)(w, ...rest);
    }) as typeof process.emitWarning;

    try {
      const client = await pool.connect();
      try {
        await Promise.all([
          client.query('SELECT 1'),
          client.query('SELECT 2'),
          client.query('SELECT 3'),
        ]);
      } finally {
        client.release();
      }
    } finally {
      process.emitWarning = origEmit;
      await close();
      await pglite.close();
    }

    const racing = warnings.filter((w) =>
      w.includes('client.query() when the client is already executing'),
    );
    expect(racing).toEqual([]);
  });

  it('serializes callback-form queries without queue deprecation', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createBridgePool(pglite);
    const warnings: string[] = [];
    const origEmit = process.emitWarning.bind(process);
    process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
      warnings.push(typeof w === 'string' ? w : String((w as Error)?.message ?? w));
      // biome-ignore lint/suspicious/noExplicitAny: wrapping overloaded signature
      return (origEmit as any)(w, ...rest);
    }) as typeof process.emitWarning;

    try {
      const client = await pool.connect();
      try {
        const results = await Promise.all(
          [1, 2, 3].map(
            (n) =>
              new Promise<number>((resolve, reject) => {
                client.query(
                  `SELECT ${n} AS n`,
                  (err: Error, res: pg.QueryResult<{ n: number }>) => {
                    if (err) reject(err);
                    // biome-ignore lint/style/noNonNullAssertion: SELECT n always yields one row
                    else resolve(res.rows[0]!.n);
                  },
                );
              }),
          ),
        );
        expect(results).toEqual([1, 2, 3]);
      } finally {
        client.release();
      }
    } finally {
      process.emitWarning = origEmit;
      await close();
      await pglite.close();
    }

    const racing = warnings.filter((w) =>
      w.includes('client.query() when the client is already executing'),
    );
    expect(racing).toEqual([]);
  });

  it('passes Submittable form through unserialized (documented scope boundary)', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const q = new pg.Query('SELECT 1');
        const returned = client.query(q);
        expect(returned).toBe(q);
        await new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });

  it('does not trigger the queue deprecation through Prisma interactive transactions', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createBridgePool(pglite);
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });
    const warnings: string[] = [];
    const origEmit = process.emitWarning.bind(process);
    process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
      warnings.push(typeof w === 'string' ? w : String((w as Error)?.message ?? w));
      // biome-ignore lint/suspicious/noExplicitAny: wrapping overloaded signature
      return (origEmit as any)(w, ...rest);
    }) as typeof process.emitWarning;

    try {
      await prisma.$transaction(async (tx) => {
        const results = await Promise.all([
          tx.$queryRawUnsafe<{ n: number }[]>('SELECT 1 AS n'),
          tx.$queryRawUnsafe<{ n: number }[]>('SELECT 2 AS n'),
          tx.$queryRawUnsafe<{ n: number }[]>('SELECT 3 AS n'),
        ]);
        expect(results.map((rows) => rows[0]?.n)).toEqual([1, 2, 3]);
      });
    } finally {
      process.emitWarning = origEmit;
      await prisma.$disconnect();
      await close();
      await pglite.close();
    }

    const racing = warnings.filter((w) =>
      w.includes('client.query() when the client is already executing'),
    );
    expect(racing).toEqual([]);
  });
});
