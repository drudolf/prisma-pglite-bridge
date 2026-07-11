import type { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupPGlite } from '../__tests__/pglite.ts';
import { SessionLock } from '../utils/session-lock.ts';
import { PgBridgeClient } from './pg-bridge-client.ts';

// One shared PGlite for the whole describe — avoids ~1.3 s cold WASM boots per
// test. Each test that uses a pool creates its own pg.Pool with its own
// SessionLock (no lock-state leaks). The afterEach below returns the shared
// session to a clean slate after every test. `reset: false` — the reset runs
// AFTER each pool has fully torn down (afterEach), not before (setupPGlite's
// default beforeEach), because the pool's teardown ROLLBACKs must drain first.
const pglite = await setupPGlite({ reset: false });

const createBridgePool = async (db: PGlite) => {
  await db.waitReady;
  const bridgeId = Symbol('bridge');
  const poolConfig = {
    Client: PgBridgeClient,
    max: 1,
    [PgBridgeClient.OptionsKey]: {
      pglite: db,
      sessionLock: new SessionLock(),
      bridgeId,
      syncToFs: false,
    },
  };
  const pool = new pg.Pool(poolConfig);

  return {
    bridgeId,
    close: () => pool.end(),
    pool,
  };
};

// Deterministic teardown barrier: a client _destroy may still have a
// fire-and-forget ROLLBACK in flight inside PGlite's runExclusive; a direct
// query serializes behind it. A settle tick is a race, not a barrier.
const endPoolAndBarrier = async (close: () => Promise<void>): Promise<void> => {
  await close();
  await pglite.query('SELECT 1').catch(() => {});
};

// Return the shared session to a clean slate between tests. The pool.end()
// (and barrier) in each test's finally block drain any in-flight teardown
// ROLLBACKs first. ROLLBACK here is a defensive no-op (swallowed) that
// guarantees the session is out of any transaction before the drops/DISCARD.
// Table drops and DISCARD ALL are deliberately NOT swallowed: a failure means
// the prior test left the session dirty and must fail loudly.
afterEach(async () => {
  await pglite.query('ROLLBACK').catch(() => {});
  const { rows } = await pglite.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'",
  );
  for (const { t } of rows) {
    await pglite.exec(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  await pglite.exec('DISCARD ALL');
});

describe('PgBridgeClient', () => {
  it('throws when bridge options are missing', () => {
    expect(() => new PgBridgeClient()).toThrow('PgBridgeClient requires bridge options');
    // A config object without the options key throws the same way.
    expect(() => new PgBridgeClient({} as ConstructorParameters<typeof PgBridgeClient>[0])).toThrow(
      'PgBridgeClient requires bridge options',
    );
  });

  it('forwards deferred callback-form query failures to the callback', async () => {
    const origQuery = pg.Client.prototype.query;
    const expected = new Error('boom');
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
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
    }
  });

  it('forwards synchronous query-config errors to the callback', async () => {
    const expected = new Error('types getter boom');
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    // Evaluating `config.types` happens synchronously inside the recursive
    // promise-form call, so the callback path must catch the throw itself.
    const config = {
      text: 'SELECT 1',
      get types(): never {
        throw expected;
      },
    };

    const calls: Array<{ err: unknown; res: unknown }> = [];
    client.query(config, (err: unknown, res: unknown) => {
      calls.push({ err, res });
    });
    expect(calls).toEqual([{ err: expected, res: undefined }]);
  });

  it('preserves pg synchronous TypeError for nullish queries', () => {
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });

    expect(() => client.query(null as never)).toThrow();
    expect(() => client.query(undefined as never)).toThrow();
  });

  it('treats a leading function argument as a query config, not a callback (stock pg parity)', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // Stock pg only collapses positional functions AFTER the first
        // argument into the callback slot (client.query(config, values,
        // callback)); the first argument is always the query config. A bare
        // function is therefore a (nonsensical) config: every function has a
        // string `.name`, so pg's text-or-name guard passes and it runs as a
        // named empty statement (EmptyQueryResponse → command null). Parity
        // here is only that the call returns a promise and the function is
        // never invoked as a callback — the settlement value is stock pg's.
        const fn = vi.fn();
        const ret = (client.query as unknown as (...args: unknown[]) => unknown)(fn);

        expect(ret).toBeInstanceOf(Promise);
        const result = await (ret as Promise<{ command: string | null }>);
        expect(result.command).toBeNull();
        expect(fn).not.toHaveBeenCalled();

        // A nonsense config is a per-query affair, not a connection error —
        // the client must stay usable.
        const followUp = await client.query<{ n: number }>('SELECT 1 AS n');
        expect(followUp.rows[0]?.n).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('delivers rows to the callback when a trailing non-function follows it (documented deviation)', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // query(text, cb, []) — a malformed ordering. Stock pg's
        // normalizeQueryConfig clobbers the callback slot with the trailing
        // truthy array and throws TypeError at settlement; the bridge's
        // collapse keeps the last positional FUNCTION, so the callback is
        // served. A deliberate, saner deviation — pinned so it stays chosen.
        const { rows } = await new Promise<{ rows: unknown[] }>((resolve, reject) => {
          const ret = (client.query as unknown as (...args: unknown[]) => unknown)(
            'SELECT 1 AS n',
            (err: unknown, res: { rows: unknown[] }) => (err ? reject(err) : resolve(res)),
            [],
          );
          expect(ret).toBeUndefined();
        });
        expect(rows).toEqual([{ n: 1 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('does not trigger pg same-client query-queue deprecation warning', async () => {
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
      await endPoolAndBarrier(close);
    }

    const racing = warnings.filter((w) =>
      w.includes('client.query() when the client is already executing'),
    );
    expect(racing).toEqual([]);
  });

  it('serializes callback-form queries without queue deprecation', async () => {
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
      await endPoolAndBarrier(close);
    }

    const racing = warnings.filter((w) =>
      w.includes('client.query() when the client is already executing'),
    );
    expect(racing).toEqual([]);
  });

  it('passes Submittable form through unserialized (documented scope boundary)', async () => {
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
      await endPoolAndBarrier(close);
    }
  });

  it('does not trigger the queue deprecation through Prisma interactive transactions', async () => {
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
      await endPoolAndBarrier(close);
    }

    const racing = warnings.filter((w) =>
      w.includes('client.query() when the client is already executing'),
    );
    expect(racing).toEqual([]);
  });
});
