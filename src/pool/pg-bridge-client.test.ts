import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { SessionLock } from '../utils/session-lock.ts';
import { PgBridgeClient } from './pg-bridge-client.ts';

const createBridgePool = async (pglite: PGlite) => {
  await pglite.waitReady;
  const bridgeId = Symbol('bridge');
  const poolConfig = {
    Client: PgBridgeClient,
    max: 1,
    [PgBridgeClient.OptionsKey]: {
      pglite,
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

describe('PgBridgeClient', () => {
  it('throws when bridge options are missing', () => {
    expect(() => new PgBridgeClient()).toThrow('PgBridgeClient requires bridge options');
  });

  it('forwards deferred callback-form query failures to the callback', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
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
      await pglite.close();
    }
  });

  it('forwards synchronous query-config errors to the callback', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
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

    try {
      const calls: Array<{ err: unknown; res: unknown }> = [];
      client.query(config, (err: unknown, res: unknown) => {
        calls.push({ err, res });
      });
      expect(calls).toEqual([{ err: expected, res: undefined }]);
    } finally {
      await pglite.close();
    }
  });

  it('preserves pg synchronous TypeError for nullish queries', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
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

  describe('config-embedded callback form', () => {
    type QueryCallback = (err: unknown, res: unknown) => void;
    type CallbackConfig = pg.QueryConfig & { callback: QueryCallback };

    const recordCallback = () => {
      const calls: Array<{ err: unknown; res: unknown }> = [];
      let settle: () => void = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const callback: QueryCallback = (err, res) => {
        calls.push({ err, res });
        settle();
      };
      return { calls, callback, settled };
    };

    const withPooledClient = async (run: (client: pg.PoolClient) => Promise<void>) => {
      const pglite = new PGlite();
      const { pool, close } = await createBridgePool(pglite);
      try {
        const client = await pool.connect();
        try {
          await run(client);
        } finally {
          // Drain pg's internal queue before release: a config-callback query
          // orphaned by a synchronous wrapper throw may still be in flight,
          // and closing PGlite underneath it would error the connection.
          await client.query('SELECT 1').catch(() => {});
          client.release();
        }
      } finally {
        await close();
        await pglite.close();
      }
    };

    it('returns undefined, delivers rows to the config callback, and stays usable', async () => {
      await withPooledClient(async (client) => {
        const { calls, callback, settled } = recordCallback();
        const config: CallbackConfig = { text: 'SELECT 1 AS one', callback };

        const ret = client.query(config);

        expect(ret).toBeUndefined();
        await settled;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.err).toBeNull();
        const res = calls[0]?.res as pg.QueryResult<{ one: number }>;
        expect(res.rows[0]?.one).toBe(1);

        const followUp = await client.query<{ two: number }>('SELECT 2 AS two');
        expect(followUp.rows[0]?.two).toBe(2);
      });
    });

    it('delivers query errors to the config callback', async () => {
      await withPooledClient(async (client) => {
        const { calls, callback, settled } = recordCallback();
        const config: CallbackConfig = { text: 'SELECT nope_column', callback };

        const ret = client.query(config);

        expect(ret).toBeUndefined();
        await settled;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.err).toBeTruthy();
        expect(calls[0]?.res).toBeUndefined();
      });
    });

    it.each([
      {
        shape: 'values embedded in the config',
        buildArgs: (callback: QueryCallback): [CallbackConfig, unknown[]?] => [
          { text: 'SELECT $1::int AS v', values: [42], callback },
        ],
      },
      {
        shape: 'values as a separate argument',
        buildArgs: (callback: QueryCallback): [CallbackConfig, unknown[]?] => [
          { text: 'SELECT $1::int AS v', callback },
          [42],
        ],
      },
    ])('passes parameter values through with a config callback ($shape)', async ({ buildArgs }) => {
      await withPooledClient(async (client) => {
        const { calls, callback, settled } = recordCallback();
        const [config, values] = buildArgs(callback);

        const ret = values === undefined ? client.query(config) : client.query(config, values);

        expect(ret).toBeUndefined();
        await settled;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.err).toBeNull();
        const res = calls[0]?.res as pg.QueryResult<{ v: number }>;
        expect(res.rows[0]?.v).toBe(42);
      });
    });

    it('prefers a positional callback over the config-embedded callback', async () => {
      await withPooledClient(async (client) => {
        const embedded = recordCallback();
        const positional = recordCallback();
        const config: CallbackConfig = { text: 'SELECT 1 AS one', callback: embedded.callback };

        const ret = client.query(config, positional.callback);

        expect(ret).toBeUndefined();
        await positional.settled;
        expect(positional.calls).toHaveLength(1);
        expect(positional.calls[0]?.err).toBeNull();
        const res = positional.calls[0]?.res as pg.QueryResult<{ one: number }>;
        expect(res.rows[0]?.one).toBe(1);
        expect(embedded.calls).toEqual([]);
      });
    });

    it('invokes only the last of multiple positional callbacks', async () => {
      await withPooledClient(async (client) => {
        const first = recordCallback();
        const last = recordCallback();
        // pg's runtime collapses every trailing function argument into
        // config.callback (last one wins); the typings do not model this.
        const queryUntyped = client.query.bind(client) as (...args: unknown[]) => unknown;

        const ret = queryUntyped('SELECT 1 AS one', first.callback, last.callback);

        expect(ret).toBeUndefined();
        await last.settled;
        expect(last.calls).toHaveLength(1);
        expect(last.calls[0]?.err).toBeNull();
        const res = last.calls[0]?.res as pg.QueryResult<{ one: number }>;
        expect(res.rows[0]?.one).toBe(1);
        expect(first.calls).toEqual([]);
      });
    });

    it('rejects instead of throwing when the config callback is not callable', async () => {
      await withPooledClient(async (client) => {
        // Intentional divergence from stock pg, which throws synchronously:
        // the wrapper converts synchronous submit throws into rejections.
        const config = { text: 'SELECT 1', callback: 'nope' } as unknown as pg.QueryConfig;

        await expect(client.query(config)).rejects.toThrow(/callback is not a function/);
      });
    });

    it('serializes a config-callback query behind a pending promise-form query', async () => {
      await withPooledClient(async (client) => {
        const order: string[] = [];
        const { calls, callback, settled } = recordCallback();
        const config: CallbackConfig = {
          text: 'SELECT 2 AS b',
          callback: (err, res) => {
            order.push('callback');
            callback(err, res);
          },
        };

        // Issue both in the same tick: the callback-form query must not jump
        // ahead of the pending promise-form predecessor.
        const p1 = client.query<{ a: number }>('SELECT 1 AS a').then((res) => {
          order.push('promise');
          return res;
        });
        const ret = client.query(config);

        expect(ret).toBeUndefined();
        const res1 = await p1;
        await settled;
        expect(order).toEqual(['promise', 'callback']);
        expect(res1.rows[0]?.a).toBe(1);
        expect(calls[0]?.err).toBeNull();
        const res2 = calls[0]?.res as pg.QueryResult<{ b: number }>;
        expect(res2.rows[0]?.b).toBe(2);
      });
    });

    it('delivers rows to a positional callback (regression guard)', async () => {
      await withPooledClient(async (client) => {
        const { calls, callback, settled } = recordCallback();

        const ret = client.query('SELECT 1 AS one', callback);

        expect(ret).toBeUndefined();
        await settled;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.err).toBeNull();
        const res = calls[0]?.res as pg.QueryResult<{ one: number }>;
        expect(res.rows[0]?.one).toBe(1);
      });
    });

    it('resolves the promise form with rows (regression guard)', async () => {
      await withPooledClient(async (client) => {
        const res = await client.query<{ one: number }>('SELECT 1 AS one');
        expect(res.rows[0]?.one).toBe(1);
      });
    });
  });
});
