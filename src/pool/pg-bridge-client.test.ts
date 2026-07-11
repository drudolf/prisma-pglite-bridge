import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { describe, expect, it, vi } from 'vitest';
import { SessionLock } from '../utils/session-lock.ts';
import { PgBridgeClient, type PgBridgeClientOptions } from './pg-bridge-client.ts';

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
    // A config object without the options key throws the same way.
    expect(() => new PgBridgeClient({} as ConstructorParameters<typeof PgBridgeClient>[0])).toThrow(
      'PgBridgeClient requires bridge options',
    );
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

  it('treats a leading function argument as a query config, not a callback (stock pg parity)', async () => {
    const pglite = new PGlite();
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
      await close();
      await pglite.close();
    }
  });

  it('delivers rows to the callback when a trailing non-function follows it (documented deviation)', async () => {
    const pglite = new PGlite();
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
      await close();
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

// Gated-LRU statement cache with piggybacked wire Close (design:
// .claude/plans/gated-lru-statement-cache.md). A cacheable shape is named
// only on its K-th sighting (minUsages, default 2); promotion at capacity
// evicts the least-recently-used name and queues a wire-level Close('S')
// that is flushed at the next query submission point. Delivery guarantee:
// the duplex pipelines Close until the next Sync/Flush-terminated extended
// batch — a simple-protocol query submitted in between executes BEFORE
// pending Closes. Capacity/minUsages are internal knobs on
// PgBridgeClientOptions.statementCaching (the pool-level public option
// stays boolean), reachable here through the OptionsKey config.
describe('PgBridgeClient — gated statement cache with piggybacked Close', () => {
  type StatementCachingOption = NonNullable<PgBridgeClientOptions['statementCaching']>;

  const createCachingPool = async (pglite: PGlite, statementCaching: StatementCachingOption) => {
    await pglite.waitReady;
    const poolConfig = {
      Client: PgBridgeClient,
      max: 1,
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
        statementCaching,
      },
    };
    const pool = new pg.Pool(poolConfig);

    return {
      close: () => pool.end(),
      pool,
    };
  };

  // Server-side probe through the shared PGlite session — a raw pg.Pool has
  // no connect-time cleanup, so the list is stable between pool queries.
  const listPpb = async (pglite: PGlite): Promise<string[]> => {
    const { rows } = await pglite.query<{ name: string }>(
      "SELECT name FROM pg_prepared_statements WHERE name LIKE 'ppb_%'",
    );
    return rows.map((row) => row.name);
  };

  /** Run a parameterized shape past the K=2 admission gate (two sightings)
   *  and return the freshly promoted server-side statement name. */
  const promote = async (pglite: PGlite, client: pg.PoolClient, text: string): Promise<string> => {
    const before = new Set(await listPpb(pglite));
    await client.query({ text, values: [1] });
    await client.query({ text, values: [1] });
    const fresh = (await listPpb(pglite)).filter((name) => !before.has(name));
    expect(fresh).toHaveLength(1);
    return fresh[0] as string;
  };

  it('names a cacheable shape only on its second execution, then re-engages the fast path', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createCachingPool(pglite, true);
    try {
      const client = await pool.connect();
      try {
        const shape = () => ({
          text: 'SELECT $1::int AS n',
          values: [7],
          rowMode: 'array' as const,
          types: pg.types,
        });

        // First sighting runs below the gate: unnamed, stock pg path — and
        // no ppb_ statement lands in the session.
        const first = await client.query(shape());
        expect(first.rows).toEqual([[7]]);
        expect(first.constructor.name).toBe('Result');
        expect(await listPpb(pglite)).toEqual([]);

        // Second sighting promotes: named, FastQuery path (plain result
        // object), statement prepared server-side.
        const second = await client.query(shape());
        expect(second.rows).toEqual([[7]]);
        expect(second.constructor.name).not.toBe('Result');
        const names = await listPpb(pglite);
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/^ppb_\d+_\d+$/);

        // Warm executions stay on the fast path and return correct rows.
        const third = await client.query(shape());
        expect(third.rows).toEqual([[7]]);
        expect(third.constructor.name).not.toBe('Result');
        expect(await listPpb(pglite)).toEqual(names);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });

  it('evicts the LRU statement past capacity — the Close departs in the promoting batch', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createCachingPool(pglite, { capacity: 2, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(pglite, client, 'SELECT $1::int AS a');
        const nameB = await promote(pglite, client, 'SELECT $1::int AS b');
        // Third promotion exceeds capacity: A (least recently used) is
        // evicted and its Close prefixes the promoting query's own message
        // train — gone immediately, no follow-up query needed.
        const nameC = await promote(pglite, client, 'SELECT $1::int AS c');

        const names = await listPpb(pglite);
        expect(names).not.toContain(nameA);
        // Total ppb_ statements stay bounded at capacity.
        expect(names).toHaveLength(2);
        expect(names).toEqual(expect.arrayContaining([nameB, nameC]));
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });

  it('re-admits an evicted shape through the gate under a strictly fresh name', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createCachingPool(pglite, { capacity: 2, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(pglite, client, 'SELECT $1::int AS a');
        await promote(pglite, client, 'SELECT $1::int AS b');
        await promote(pglite, client, 'SELECT $1::int AS c'); // evicts A, Close delivered

        // Refresh B's recency so the re-promotion below evicts C, not B.
        await client.query({ text: 'SELECT $1::int AS b', values: [2] });
        const afterFlush = await listPpb(pglite);
        expect(afterFlush).not.toContain(nameA);

        // Counters were dropped at promotion, so the evicted shape restarts
        // from zero sightings: the first re-execution stays below the gate
        // and creates no statement.
        const below = await client.query({ text: 'SELECT $1::int AS a', values: [2] });
        expect(below.rows).toEqual([{ a: 2 }]);
        expect((await listPpb(pglite)).filter((name) => !afterFlush.includes(name))).toEqual([]);

        // The second re-execution promotes under a strictly fresh name —
        // the evicted name is never reused.
        const rePromoted = await client.query({ text: 'SELECT $1::int AS a', values: [3] });
        expect(rePromoted.rows).toEqual([{ a: 3 }]);
        const fresh = (await listPpb(pglite)).filter((name) => !afterFlush.includes(name));
        expect(fresh).toHaveLength(1);
        expect(fresh[0]).not.toBe(nameA);
        expect(fresh[0]).toMatch(/^ppb_\d+_\d+$/);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });

  it('delivers an eviction Close inside a failed transaction', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createCachingPool(pglite, { capacity: 1, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(pglite, client, 'SELECT $1::int AS a');
        // First sighting of the next shape stays below the gate.
        await client.query({ text: 'SELECT $1::int AS d', values: [1] });

        await client.query('BEGIN');
        await expect(client.query('SELECT nope FROM ppb_missing_table')).rejects.toThrow();

        // Second sighting promotes INSIDE the failed transaction: the
        // eviction Close for A prefixes the train, the Parse raises 25P02 —
        // but Close is session-level, not transactional, and is processed
        // anyway (pgx's documented reason for Close over DEALLOCATE).
        await expect(
          client.query({ text: 'SELECT $1::int AS d', values: [2] }),
        ).rejects.toMatchObject({ code: '25P02' });
        await client.query('ROLLBACK');

        expect(await listPpb(pglite)).not.toContain(nameA);

        // The session recovered; the shape promoted in the failed tx
        // executes under its name (re-Parsed — 25P02 aborted the Parse, so
        // pg never recorded it as parsed).
        const warm = await client.query({ text: 'SELECT $1::int AS d', values: [5] });
        expect(warm.rows).toEqual([{ d: 5 }]);
        expect(await listPpb(pglite)).toHaveLength(1);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });

  it('tears down cleanly right after promotions — only live statements remain', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createCachingPool(pglite, { capacity: 1, minUsages: 2 });
    try {
      const client = await pool.connect();
      let nameA = '';
      let nameB = '';
      let nameC = '';
      try {
        nameA = await promote(pglite, client, 'SELECT $1::int AS a');
        nameB = await promote(pglite, client, 'SELECT $1::int AS b'); // evicts A
        nameC = await promote(pglite, client, 'SELECT $1::int AS c'); // evicts B
      } finally {
        client.release();
      }

      // Ending the pool right after an evicting promotion must neither
      // error nor hang (the test timeout is the hang tripwire).
      await close();

      const names = await listPpb(pglite);
      expect(names).not.toContain(nameA); // Close rode B's promoting batch
      expect(names).not.toContain(nameB); // Close rode C's promoting batch
      // C was live at teardown — never closed: the documented Non-goals
      // orphan (a dead client's named statements stay in the session).
      expect(names).toContain(nameC);

      // The shared session is unaffected by the orphan.
      const { rows } = await pglite.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await pglite.close();
    }
  });

  it('delivers the eviction Close even when the promoting query fails at bind', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createCachingPool(pglite, { capacity: 1, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameB = await promote(pglite, client, 'SELECT $1::int AS b');
        // First sighting of the next shape stays below the gate.
        await client.query({
          text: 'SELECT $1::int AS e',
          values: [1],
          rowMode: 'array' as const,
          types: pg.types,
        });

        // Second sighting promotes (evicting B), but the bind value is
        // unserializable: prepareValue throws inside FastQuery's submit,
        // which recovers with a bare Sync (fast-query.ts catch). The Close
        // prefix and the Parse already went out in the same batch.
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await expect(
          client.query({
            text: 'SELECT $1::int AS e',
            values: [circular],
            rowMode: 'array' as const,
            types: pg.types,
          }),
        ).rejects.toThrow();

        // The client recovered: the shape executes warm under its promoted
        // name and new queries work. The bind failure settles the promise
        // before the recovery Sync's RFQ, so the warm query — serialized
        // behind that RFQ — is also the barrier that proves the batch
        // (Close prefix included) fully landed before the probe below.
        const warm = await client.query({
          text: 'SELECT $1::int AS e',
          values: [2],
          rowMode: 'array' as const,
          types: pg.types,
        });
        expect(warm.rows).toEqual([[2]]);
        expect(await listPpb(pglite)).not.toContain(nameB);
        const followUp = await client.query('SELECT 3 AS three');
        expect(followUp.rows).toEqual([{ three: 3 }]);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });

  it('flushes an eviction Close safely into an active pg-cursor conversation', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createCachingPool(pglite, { capacity: 1, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(pglite, client, 'SELECT $1::int AS a');
        // First sighting of the next shape stays below the gate.
        await client.query({ text: 'SELECT $1::int AS n', values: [1] });

        const cursor = client.query(
          new Cursor<{ i: number }>('select i from generate_series(1,5) g(i)'),
        );
        const firstPage = await cursor.read(2);
        expect(firstPage.map((row) => row.i)).toEqual([1, 2]);

        // Second sighting mid-conversation: its submission point promotes
        // the shape, evicts A, and writes the Close onto the wire while the
        // cursor's portal is suspended; pg queues the query itself behind
        // the cursor. Generator names never travel through Submittables, so
        // the Close cannot target the cursor's statement.
        const interleaved = client.query({ text: 'SELECT $1::int AS n', values: [9] });

        const rest: number[] = [];
        for (;;) {
          const page = await cursor.read(2);
          if (page.length === 0) break;
          rest.push(...page.map((row) => row.i));
        }
        await cursor.close();
        expect(rest).toEqual([3, 4, 5]);

        const result = await interleaved;
        expect(result.rows).toEqual([{ n: 9 }]);
        expect(await listPpb(pglite)).not.toContain(nameA);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });

  it('sends a no-op Close for an evicted name the user already deallocated', async () => {
    const pglite = new PGlite();
    const { pool, close } = await createCachingPool(pglite, { capacity: 2, minUsages: 2 });
    try {
      const client = await pool.connect();
      try {
        const nameA = await promote(pglite, client, 'SELECT $1::int AS a');
        const nameB = await promote(pglite, client, 'SELECT $1::int AS b');

        // User deallocates A's name directly: the server frees it and the
        // dealloc intercept clears pg's parse-skip entry; the generator map
        // intentionally survives (existing contract).
        await client.query(`DEALLOCATE "${nameA}"`);
        expect(await listPpb(pglite)).toEqual([nameB]);

        // Promoting a third shape evicts A from the generator (still its
        // LRU) and Closes the already-freed name — a protocol no-op that
        // must not error or disturb the batch it rides.
        const nameC = await promote(pglite, client, 'SELECT $1::int AS c');
        const names = await listPpb(pglite);
        expect(names).toHaveLength(2);
        expect(names).toEqual(expect.arrayContaining([nameB, nameC]));

        // B still executes warm under its kept name; A re-enters through
        // the gate and promotes under a fresh name — the old one never
        // returns.
        const warm = await client.query({ text: 'SELECT $1::int AS b', values: [4] });
        expect(warm.rows).toEqual([{ b: 4 }]);
        await client.query({ text: 'SELECT $1::int AS a', values: [5] }); // sighting 1 — below gate
        expect(await listPpb(pglite)).toHaveLength(2);
        await client.query({ text: 'SELECT $1::int AS a', values: [6] }); // sighting 2 — fresh promotion
        const finalNames = await listPpb(pglite);
        expect(finalNames).toHaveLength(2);
        expect(finalNames).toContain(nameB);
        expect(finalNames).not.toContain(nameA);
      } finally {
        client.release();
      }
    } finally {
      await close();
      await pglite.close();
    }
  });
});
