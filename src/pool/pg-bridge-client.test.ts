import { EventEmitter } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupPGlite } from '../__tests__/pglite.ts';
import { PGliteDuplex } from '../duplex/index.ts';
import { PgBridgeError } from '../errors.ts';
import { SessionLock } from '../utils/session-lock.ts';
import { FastQuery } from './fast-query.ts';
import {
  PG_CONSUMED_QUERY_FIELDS,
  PgBridgeClient,
  type PgBridgeClientOptions,
  snapshotQueryConfig,
} from './pg-bridge-client.ts';
import { liveClients } from './session-registry.ts';

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

// Bounded blocked-promise detection (same shape as the abandoned-transaction
// suite): resolves to the settled value if `p` settles first, else the
// sentinel `'pending'` after `ms`. The loser timer is unref'd so it never
// keeps the event loop alive after `p` wins.
const settledOrPending = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([
    p,
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), ms).unref();
    }),
  ]);

// pg's parse-skip cache on a live pool client. The Connection augmentation in
// pg-internals.ts types `parsedStatements`; PoolClient merely hides the
// `connection` property behind its narrower public type.
const parsedStatementsOf = (client: pg.PoolClient): Record<string, string | undefined> =>
  (client as unknown as pg.Client).connection.parsedStatements;

// Warm a user-named statement into pg's parse-skip cache: the first run
// Parses and records connection.parsedStatements[name]; the second run skips
// Parse (extended protocol — `name` forces it). No statementCaching needed:
// pg's own parsedStatements guard is the cache under test, same as the
// user-named shapes in index.statement-cache.test.ts. After an unintercepted
// session-wide DEALLOCATE, this shape's next run Binds a name PGlite forgot
// and fails with Postgres error 26000.
const warmNamedStatement = async (
  client: pg.PoolClient,
  name: string,
  marker: number,
): Promise<{ name: string; text: string }> => {
  const shape = { name, text: `SELECT ${marker} AS n` };
  await client.query(shape);
  await client.query(shape);
  expect(parsedStatementsOf(client)[name]).toBeDefined();
  return shape;
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

  it.sequential('destroys the stream-factory duplex when the pg-internals assertion fails', async () => {
    const connectionPrototype = Object.getPrototypeOf(
      new pg.Client({ host: 'localhost' }).connection,
    ) as { close?: unknown };
    const closeDescriptor = Object.getOwnPropertyDescriptor(connectionPrototype, 'close');
    if (closeDescriptor === undefined) throw new Error('pg Connection.prototype.close is absent');

    const destroySpy = vi.spyOn(PGliteDuplex.prototype, 'destroy');
    Object.defineProperty(connectionPrototype, 'close', {
      ...closeDescriptor,
      value: undefined,
    });
    try {
      expect(
        () =>
          new PgBridgeClient({
            [PgBridgeClient.OptionsKey]: {
              pglite,
              bridgeId: Symbol('bridge'),
              syncToFs: false,
              statementCaching: true,
            },
          }),
      ).toThrowError(
        [
          'Unsupported pg internals: prisma-pglite-bridge relies on undocumented pg 8.x private state.',
          'Make sure prisma-pglite-bridge and @prisma/adapter-pg use one deduplicated pg 8.x installation.',
          'pg 8.16.3 is the oldest verified-compatible release; older 8.x minors may predate these internals.',
          'Missing or incompatible internals:',
          '- client.connection.close()',
        ].join('\n'),
      );

      expect(destroySpy).toHaveBeenCalledTimes(1);
      expect(destroySpy).toHaveBeenCalledWith();
      expect(destroySpy.mock.contexts[0]).toBeInstanceOf(PGliteDuplex);
      expect(liveClients.has(pglite)).toBe(false);
    } finally {
      Object.defineProperty(connectionPrototype, 'close', closeDescriptor);
      const createdDuplex = destroySpy.mock.contexts[0] as PGliteDuplex | undefined;
      destroySpy.mockRestore();
      await createdDuplex?.onClose;
    }
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

  it('returns a Submittable synchronously and admits it immediately when the chain is idle', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // Submittable contract (pg API parity): client.query(q) hands back
        // the SAME object synchronously — callers attach event listeners to
        // it. With the submission chain idle, admission to pg's queue is
        // immediate; deferred admission behind a busy chain is pinned by the
        // ordering tests below.
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

  it('preserves call order when a Submittable follows a chain-delayed ordinary query', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE submittable_order_t (seq serial, n int)');

        // The first query keeps pg active. The ordinary INSERT is therefore
        // delayed on PgBridgeClient's submission chain, while the following
        // Submittable currently bypasses that chain and jumps ahead of it.
        const first = client.query('SELECT pg_sleep(0.05)');
        const second = client.query('INSERT INTO submittable_order_t (n) VALUES (2)');
        const submittable = new pg.Query('INSERT INTO submittable_order_t (n) VALUES (3)');
        const third = new Promise<void>((resolve, reject) => {
          submittable.once('end', () => resolve());
          submittable.once('error', reject);
        });
        expect(client.query(submittable)).toBe(submittable);

        await Promise.all([first, second, third]);
        const { rows } = await client.query<{ n: number }>(
          'SELECT n FROM submittable_order_t ORDER BY seq',
        );
        expect(rows.map(({ n }) => n)).toEqual([2, 3]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('keeps ordinary → Submittable → ordinary call order on a busy chain', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE mixed_order_t (seq serial, n int)');

        // All three calls land while the opener keeps pg busy. The
        // Submittable's ADMISSION defers behind the chained INSERT 1, and
        // the trailing ordinary INSERT 3 must not overtake the Submittable
        // either — call order is execution order. (Completion ordering after
        // admission is pg's own queue discipline; the chain is deliberately
        // not extended past the Submittable.)
        const opener = client.query('SELECT pg_sleep(0.05)');
        const first = client.query('INSERT INTO mixed_order_t (n) VALUES (1)');
        const submittable = new pg.Query('INSERT INTO mixed_order_t (n) VALUES (2)');
        const second = new Promise<void>((resolve, reject) => {
          submittable.once('end', () => resolve());
          submittable.once('error', reject);
        });
        expect(client.query(submittable)).toBe(submittable);
        const third = client.query('INSERT INTO mixed_order_t (n) VALUES (3)');

        await Promise.all([opener, first, second, third]);
        const { rows } = await client.query<{ n: number }>(
          'SELECT n FROM mixed_order_t ORDER BY seq',
        );
        expect(rows.map(({ n }) => n)).toEqual([1, 2, 3]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('preserves relative admission order between two Submittables behind a busy chain', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE twin_sub_t (seq serial, n int)');

        // Two Submittables deferred behind the same pending ordinary query:
        // both admissions wait for the chain to settle, and they must reach
        // pg's queue in call order — deferral must not reorder them.
        const settleOf = (q: pg.Query): Promise<void> =>
          new Promise<void>((resolve, reject) => {
            q.once('end', () => resolve());
            q.once('error', reject);
          });
        const opener = client.query('SELECT pg_sleep(0.05)');
        const first = client.query('INSERT INTO twin_sub_t (n) VALUES (1)');
        const qa = new pg.Query('INSERT INTO twin_sub_t (n) VALUES (2)');
        const qb = new pg.Query('INSERT INTO twin_sub_t (n) VALUES (3)');
        const second = settleOf(qa);
        const third = settleOf(qb);
        expect(client.query(qa)).toBe(qa);
        expect(client.query(qb)).toBe(qb);

        await Promise.all([opener, first, second, third]);
        const { rows } = await client.query<{ n: number }>('SELECT n FROM twin_sub_t ORDER BY seq');
        expect(rows.map(({ n }) => n)).toEqual([1, 2, 3]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('attaches a trailing positional callback to a Submittable admitted on an idle chain (stock pg parity)', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // Stock pg's Submittable arm adopts a trailing positional callback
        // when the Submittable has none of its own (`if (!query.callback)`,
        // pg 8.22 client.js). The bridge must forward the full argument list
        // for that adoption to happen. pg.Query invokes its callback BEFORE
        // emitting 'end', so 'end' is the bounded completion signal that
        // works in the red state too — a dropped callback still ends the
        // query, it just never delivers.
        const calls: Array<{ err: unknown; res: unknown }> = [];
        const q = new pg.Query('SELECT 2 AS y');
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(
          q,
          (err: unknown, res: unknown) => {
            calls.push({ err, res });
          },
        );
        // The synchronous Submittable return survives the callback form.
        expect(returned).toBe(q);

        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.err).toBeNull();
        const res = calls[0]?.res as pg.QueryResult<{ y: number }>;
        expect(res.command).toBe('SELECT');
        expect(res.rows).toEqual([{ y: 2 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('forwards the trailing callback through a deferred Submittable admission and preserves call order', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE deferred_sub_cb_t (seq serial, n int)');

        // The opener occupies the submission chain, so the Submittable takes
        // the DEFERRED arm; the trailing callback must ride the deferred
        // super.query hand-off — dropping it there is invisible to the
        // idle-chain test above. Admission stays serialized: the chained
        // INSERT 1 lands before the Submittable's INSERT 2.
        const opener = client.query('SELECT pg_sleep(0.05)');
        const first = client.query('INSERT INTO deferred_sub_cb_t (n) VALUES (1)');
        const calls: Array<{ err: unknown; res: unknown }> = [];
        const q = new pg.Query('INSERT INTO deferred_sub_cb_t (n) VALUES (2)');
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(
          q,
          (err: unknown, res: unknown) => {
            calls.push({ err, res });
          },
        );
        expect(returned).toBe(q);
        // Deferred admission: nothing can have completed synchronously.
        expect(calls).toEqual([]);

        await Promise.all([opener, first]);
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();

        expect(calls).toHaveLength(1);
        expect(calls[0]?.err).toBeNull();
        const res = calls[0]?.res as pg.QueryResult;
        expect(res.command).toBe('INSERT');
        expect(res.rowCount).toBe(1);

        const { rows } = await client.query<{ n: number }>(
          'SELECT n FROM deferred_sub_cb_t ORDER BY seq',
        );
        expect(rows.map(({ n }) => n)).toEqual([1, 2]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it("keeps a Submittable's own pre-set callback over the trailing positional one (stock !query.callback guard)", async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // Stock pg adopts the positional callback ONLY when the Submittable
        // has none of its own. Green today (dropped arguments cannot clobber
        // anything) and pinned so the argument-forwarding fix reproduces
        // stock's guard instead of unconditionally assigning.
        const ownCalls: Array<{ err: unknown; res: unknown }> = [];
        const positionalCalls: Array<{ err: unknown; res: unknown }> = [];
        const q = new pg.Query('SELECT 3 AS z', (err, res) => {
          ownCalls.push({ err, res });
        });
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(
          q,
          (err: unknown, res: unknown) => {
            positionalCalls.push({ err, res });
          },
        );
        expect(returned).toBe(q);

        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();
        expect(ownCalls).toHaveLength(1);
        expect(ownCalls[0]?.err).toBeNull();
        const res = ownCalls[0]?.res as pg.QueryResult<{ z: number }>;
        expect(res.rows).toEqual([{ z: 3 }]);
        expect(positionalCalls).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('does not extend the submission chain past a callback-carrying Submittable (deferred arm)', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // The chain is deliberately NOT extended past a Submittable —
        // arbitrary Submittables expose no uniform terminal signal. That
        // must survive the argument-forwarding fix: a trailing callback is a
        // completion signal pg owns, not an invitation to chain past the
        // admission. Identity, not settlement: the chain tail before and
        // after the call is the same promise.
        const view = client as unknown as { querySubmissionChain?: Promise<void> };
        const opener = client.query('SELECT pg_sleep(0.05)');
        const busyTail = view.querySubmissionChain;
        expect(busyTail).toBeDefined();

        const q = new pg.Query('SELECT 4 AS w');
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(q, () => {});
        expect(returned).toBe(q);
        expect(view.querySubmissionChain).toBe(busyTail);

        await opener;
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('delivers an ended-client admission failure through the Submittable error path, not an unhandled rejection', async () => {
    // The deferred admission may fire after the client has ended (pool
    // teardown wins the race against a busy chain). The failure must reach
    // the Submittable's OWN error path — pg.Query's 'error' event — never an
    // unhandled promise rejection (captured like the abandoned-transaction
    // suite does).
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    const { pool, close } = await createBridgePool(pglite);
    let closed = false;
    try {
      const client = await pool.connect();
      let released = false;
      try {
        // Busy chain at admission time: the opener occupies the submission
        // chain while the pool tears down.
        void client.query('SELECT pg_sleep(0.3)').catch(() => {});
        const q = new pg.Query('SELECT 1');
        const settled = new Promise<'end' | 'error'>((resolve) => {
          q.once('error', () => resolve('error'));
          q.once('end', () => resolve('end'));
        });
        expect(client.query(q)).toBe(q);
        client.release();
        released = true;
        await close();
        closed = true;

        // Bounded: a dropped Submittable would never settle — surface that
        // in ~5 s instead of eating the suite timeout. Which path fires
        // ('error' from the teardown, or 'end' if the query won the race) is
        // not pinned; settling through q's own events is.
        const outcome = await Promise.race([
          settled,
          new Promise<'pending'>((resolve) => {
            setTimeout(() => resolve('pending'), 5_000).unref();
          }),
        ]);
        expect(outcome).not.toBe('pending');

        // Let any deferred rejection surface before asserting none did.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toEqual([]);
      } finally {
        if (!released) client.release();
      }
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      // The pool is usually ended in the body; pg-pool rejects a second
      // end(), so only close here when an assertion threw before it ran.
      if (!closed) await close().catch(() => {});
      // Drain any in-flight teardown work before the afterEach reset.
      await pglite.query('SELECT 1').catch(() => {});
    }
  });

  it('destroys the client when a deferred Submittable submit() throws, delivering one normalized Error to handleError', async () => {
    // FIX 2, real pg state (no prototype stubs): a deferred Submittable whose
    // submit() throws synchronously at the hand-off (a contract violation)
    // used to leave pg internally wedged — the active-query slot stayed
    // occupied and every successor hung forever. The bridge now destroys the
    // client's connection with the thrown error, normalized to an Error.
    // pg's connection-error path must then deliver that error EXACTLY ONCE
    // to the Submittable via handleError(err, connection), reject the queued
    // successor, and leave the client evictable so a fresh checkout works.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    const { pool, close } = await createBridgePool(pglite);
    // pg-pool re-raises client errors observed while idle as pool 'error'
    // events; an unlistened emit would crash the worker. Captured, not pinned.
    const poolErrors: unknown[] = [];
    pool.on('error', (err) => {
      poolErrors.push(err);
    });
    try {
      const client = await pool.connect();
      let released = false;
      try {
        // Stock pg re-emits the destroy error on the client itself
        // (_handleErrorEvent), and a checked-out pool client has no
        // pool-attached 'error' listener — capture it so the re-emit cannot
        // crash the worker. handleError is the pinned delivery channel.
        const clientErrors: unknown[] = [];
        client.on('error', (err) => {
          clientErrors.push(err);
        });

        // Busy chain at call time: the opener forces the Submittable's
        // hand-off to pg onto the deferred chain hop.
        void client.query('SELECT pg_sleep(0.05)').catch(() => {});
        const handleError = vi.fn();
        const evil = {
          // Thrown as a non-Error on purpose — pins the normalization arm.
          submit: (): void => {
            throw 'submit boom';
          },
          handleError,
        };
        expect(client.query(evil)).toBe(evil);
        // Queued successor: must REJECT once the client is destroyed — a
        // wedged pg would leave it hanging forever.
        const succ = client.query('SELECT 1 AS ok');
        succ.catch(() => {});

        const outcome = await settledOrPending(
          succ.then(
            () => 'resolved' as const,
            () => 'rejected' as const,
          ),
          5_000,
        );
        expect(outcome).toBe('rejected');

        // Delivery is async (nextTick via pg's _errorAllQueries).
        await vi.waitFor(() => expect(handleError).toHaveBeenCalledTimes(1));
        const [err] = handleError.mock.calls[0] ?? [];
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('submit boom');

        // The destroyed connection left the client non-queryable, so a plain
        // release EVICTS instead of recycling (pg-pool _release:
        // `!client._queryable` → _remove, synchronous on totalCount).
        client.release();
        released = true;
        expect(pool.totalCount).toBe(0);

        // Pool recovers: a fresh client on the same session works. Bounded —
        // a leaked SessionLock would hang the fresh query, not fail it.
        const fresh = await settledOrPending(pool.connect(), 5_000);
        expect(fresh).not.toBe('pending');
        if (fresh !== 'pending') {
          try {
            const r = await settledOrPending(fresh.query<{ ok: number }>('SELECT 1 AS ok'), 5_000);
            expect(r).not.toBe('pending');
            if (r !== 'pending') expect(r.rows[0]?.ok).toBe(1);
          } finally {
            fresh.release();
          }
        }

        // Still exactly once after the recovery round-trip — no duplicate
        // delivery — and nothing surfaced as an unhandled rejection.
        expect(handleError).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toEqual([]);
      } finally {
        if (!released) client.release();
      }
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      // Bounded teardown: a red run leaves pg's active-query slot occupied —
      // end() must not hang the worker; the barrier drains teardown work.
      await settledOrPending(close(), 10_000).catch(() => {});
      await pglite.query('SELECT 1').catch(() => {});
    }
  });

  it('passes an Error-instance submit() throw to handleError by identity and recovers the pool', async () => {
    // Identity arm of the same destroy path: an Error thrown by the deferred
    // submit() must reach handleError unwrapped (toBe identity, no
    // re-normalization), with the same successor-reject + evict +
    // fresh-client recovery contract as the non-Error arm above.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    const { pool, close } = await createBridgePool(pglite);
    const poolErrors: unknown[] = [];
    pool.on('error', (err) => {
      poolErrors.push(err);
    });
    try {
      const client = await pool.connect();
      let released = false;
      try {
        const clientErrors: unknown[] = [];
        client.on('error', (err) => {
          clientErrors.push(err);
        });

        void client.query('SELECT pg_sleep(0.05)').catch(() => {});
        const boom = new Error('submit boom 2');
        const handleError = vi.fn();
        const evil = {
          submit: (): void => {
            throw boom;
          },
          handleError,
        };
        expect(client.query(evil)).toBe(evil);
        const succ = client.query('SELECT 1 AS ok');
        succ.catch(() => {});

        const outcome = await settledOrPending(
          succ.then(
            () => 'resolved' as const,
            () => 'rejected' as const,
          ),
          5_000,
        );
        expect(outcome).toBe('rejected');

        await vi.waitFor(() => expect(handleError).toHaveBeenCalledTimes(1));
        expect(handleError.mock.calls[0]?.[0]).toBe(boom);

        client.release();
        released = true;
        expect(pool.totalCount).toBe(0);

        const fresh = await settledOrPending(pool.connect(), 5_000);
        expect(fresh).not.toBe('pending');
        if (fresh !== 'pending') {
          try {
            const r = await settledOrPending(fresh.query<{ ok: number }>('SELECT 1 AS ok'), 5_000);
            expect(r).not.toBe('pending');
            if (r !== 'pending') expect(r.rows[0]?.ok).toBe(1);
          } finally {
            fresh.release();
          }
        }

        expect(handleError).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toEqual([]);
      } finally {
        if (!released) client.release();
      }
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      await settledOrPending(close(), 10_000).catch(() => {});
      await pglite.query('SELECT 1').catch(() => {});
    }
  });

  // ————— Submittable DEALLOCATE/DISCARD — statement-cache eviction —————
  // The plain-text and promise forms detect DEALLOCATE/DISCARD at admission
  // and evict every live client's parse-skip caches after REAL completion.
  // A Submittable carrying the same SQL executes on the backend but bypasses
  // that intercept entirely, leaving pg's parsedStatements pointing at names
  // PGlite forgot — every later warm named run fails 26000, persistently.
  // These tests pin the contract: detection on the submittable's `.text`
  // after admission (ONE read, fail-closed), eviction armed on BOTH
  // completion channels — the callback (evict on err == null, then delegate)
  // and 'end' — behind a shared exactly-once guard, and the same live-client
  // fan-out as the plain-text path. pg 8.22 fact (lib/query.js
  // handleReadyForQuery): on success the callback fires AND THEN 'end' is
  // emitted unconditionally; on error callback(err) XOR emit('error'), and
  // 'end' never fires.

  it("evicts every warm parse-skip entry after a Submittable DEALLOCATE ALL completes ('end' channel)", async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_end_evict_stmt', 41);

        const q = new pg.Query('DEALLOCATE ALL');
        expect(client.query(q)).toBe(q);
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();

        // Both warm re-runs succeed: the eviction forced a clean re-Parse.
        // Unfixed, pg skips Parse for a name PGlite forgot and BOTH runs
        // fail 26000 — the poisoning is persistent, not transient.
        const first = await client.query(shape);
        expect(first.rows).toEqual([{ n: 41 }]);
        const second = await client.query(shape);
        expect(second.rows).toEqual([{ n: 41 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it("evicts through pg-pool's release callback when pool.query runs a Submittable DEALLOCATE ALL", async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      // Warm on a checked-out client, then release: pg-pool keeps the client
      // (and its parse-skip cache) for the next checkout.
      const warmClient = await pool.connect();
      let shape: { name: string; text: string };
      try {
        shape = await warmNamedStatement(warmClient, 'sub_pool_cb_stmt', 42);
      } finally {
        warmClient.release();
      }

      // pool.query(Submittable): pg-pool attaches its release callback as
      // query.callback inside stock pg's submittable arm — the CALLBACK
      // channel is the completion signal that must carry the eviction here.
      // (@types/pg types the pool submittable form as returning the
      // submittable, but pg-pool's runtime always returns a promise.)
      const deallocP = (pool.query as unknown as (arg: unknown) => Promise<unknown>)(
        new pg.Query('DEALLOCATE ALL'),
      );
      const dealloc = await settledOrPending(deallocP, 5_000);
      expect(dealloc).not.toBe('pending');

      // A fresh checkout hands back the same warm client (max: 1); its
      // re-run must re-Parse instead of skipping into a 26000.
      const fresh = await pool.connect();
      try {
        const rerun = await fresh.query(shape);
        expect(rerun.rows).toEqual([{ n: 42 }]);
      } finally {
        fresh.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it("fans a Submittable DEALLOCATE ALL out to a sibling client's parse-skip cache (max: 2)", async () => {
    // Session-wide invalidation must reach EVERY live client of the PGlite
    // instance, not just the issuer — same registry fan-out as plain text.
    const poolConfig = {
      Client: PgBridgeClient,
      max: 2,
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    };
    const pool = new pg.Pool(poolConfig);
    try {
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        const shape = await warmNamedStatement(b, 'sub_sibling_stmt', 43);

        // The wipe travels through A as a Submittable, so neither the
        // plain-text intercept nor the promise path sees it — B's cache
        // still has to be evicted through the live-client registry.
        const q = new pg.Query('DEALLOCATE ALL');
        expect(a.query(q)).toBe(q);
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();

        const rerun = await b.query(shape);
        expect(rerun.rows).toEqual([{ n: 43 }]);
      } finally {
        a.release();
        b.release();
      }
    } finally {
      await endPoolAndBarrier(() => pool.end());
    }
  });

  it('evicts exactly once when both completion channels fire on one Submittable DEALLOCATE ALL', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_once_stmt', 44);

        // On success pg fires the callback AND THEN emits 'end'. The
        // eviction must run BEFORE the delegated callback and exactly once.
        // The sentinel inserted INSIDE the callback — i.e. after the
        // callback-channel eviction — can only disappear if the 'end'
        // channel wipes a second time, so its survival pins the shared
        // exactly-once guard.
        let warmEntryAtCallback: string | undefined = 'unread';
        const calls: Array<{ err: unknown }> = [];
        const q = new pg.Query('DEALLOCATE ALL');
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(
          q,
          (err: unknown) => {
            calls.push({ err });
            warmEntryAtCallback = parsedStatementsOf(client)[shape.name];
            parsedStatementsOf(client).sub_once_sentinel = 'SELECT 1';
          },
        );
        expect(returned).toBe(q);
        // Attached AFTER query() so a bridge-armed 'end' listener runs
        // first: by the time this resolves, any (buggy) second eviction has
        // already run and would have deleted the sentinel.
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toEqual([{ err: null }]);
        // The callback-channel eviction ran before the delegated callback —
        // red while unfixed: the entry is still there because no eviction
        // happened at all.
        expect(warmEntryAtCallback).toBeUndefined();
        // Exactly once: the 'end' channel must NOT wipe again.
        expect(parsedStatementsOf(client).sub_once_sentinel).toBe('SELECT 1');

        // Coherence: the warm shape re-runs cleanly after the wipe.
        const rerun = await client.query(shape);
        expect(rerun.rows).toEqual([{ n: 44 }]);
      } finally {
        delete parsedStatementsOf(client).sub_once_sentinel;
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('does NOT evict when a Submittable DEALLOCATE completes with an error (callback channel)', async () => {
    // Kills 2314 (`if (err == null) evict()` → `if (true) evict()`): a FAILED
    // Submittable DEALLOCATE (callback fired with err != null) must NOT wipe the
    // statement caches — pg calls callback(err) XOR emits 'error' and never emits
    // 'end', so eviction has no completion signal to fire on. The mutant evicts
    // regardless, discarding a warm parse-skip entry that PGlite still holds.
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
        statementCaching: true,
      },
    });
    try {
      // Prime a warm parse-skip entry the eviction would wipe.
      parsedStatementsOf(client as unknown as pg.PoolClient).sub_err_victim = 'SELECT 1';
      // Stub stock admission so no real query runs; return the submittable like pg.
      pg.Client.prototype.query = vi.fn(
        (arg: unknown) => arg,
      ) as unknown as typeof pg.Client.prototype.query;

      const delivered: unknown[] = [];
      const submittable = {
        text: 'DEALLOCATE ALL',
        submit: (): void => {},
        callback: (err: unknown) => {
          delivered.push(err);
        },
        once: (): void => {},
      };
      const returned = (client.query as unknown as (arg: unknown) => unknown)(submittable);
      expect(returned).toBe(submittable);

      // Fire the bridge-wrapped callback with an ERROR (a failed DEALLOCATE).
      const boom = new Error('prepared statement does not exist');
      (submittable.callback as (err: unknown, res: unknown) => void)(boom, undefined);

      // The original callback still received the error (delegation is unconditional)...
      expect(delivered).toEqual([boom]);
      // ...but no eviction ran: the warm entry survives. The mutant wipes it.
      expect(parsedStatementsOf(client as unknown as pg.PoolClient).sub_err_victim).toBe(
        'SELECT 1',
      );
    } finally {
      pg.Client.prototype.query = origQuery;
      client.deregisterLiveClient();
    }
  });

  it('does not invoke a non-function once() when arming the end channel (fail-closed)', async () => {
    // Kills 2319 (`typeof target.once === 'function'` → true): a Submittable whose
    // `once` is NOT a function must skip the 'end' arm silently, never invoking it.
    // The mutant drops the type guard and blindly calls `once.call(submittable,
    // 'end', evict)`; a Submittable simply lacking once() can't distinguish that
    // (the call throws and is swallowed by the arm's catch), so probe with a
    // non-function `once` carrying a recording `.call`. Under the guard it is never
    // touched; under the mutant it is invoked. Arming must also not throw.
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
        statementCaching: true,
      },
    });
    try {
      pg.Client.prototype.query = vi.fn(
        (arg: unknown) => arg,
      ) as unknown as typeof pg.Client.prototype.query;

      const onceCallArgs: unknown[][] = [];
      // `once` is a non-function object; its `.call` records invocation. The type
      // guard means the bridge must never reach it — the mutant (guard → true) does.
      const submittable = {
        text: 'DEALLOCATE ALL',
        submit: (): void => {},
        callback: (_err: unknown): void => {},
        once: {
          call: (...args: unknown[]): void => {
            onceCallArgs.push(args);
          },
        },
      } as Record<string, unknown>;

      // Arming must not throw for a Submittable whose once() is not a function.
      let returned: unknown;
      expect(() => {
        returned = (client.query as unknown as (arg: unknown) => unknown)(submittable);
      }).not.toThrow();
      expect(returned).toBe(submittable);

      // Guard skipped the non-function once: its .call was never invoked. The mutant
      // invokes it with ['end', evict].
      expect(onceCallArgs).toEqual([]);
    } finally {
      pg.Client.prototype.query = origQuery;
      client.deregisterLiveClient();
    }
  });

  it('evicts exactly once when a configured query_timeout arms but does not fire on the Submittable', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_timer_stmt', 49);

        // pg reads query_timeout off the SUBMITTABLE itself (client.js:660,
        // config === the Query object). A generous budget arms pg's timer
        // and wraps query.callback in the clearTimeout shim WITHOUT firing —
        // the bridge's own wrapper must sit around pg's shim and still
        // deliver evict-then-delegate exactly once.
        let warmEntryAtCallback: string | undefined = 'unread';
        const calls: Array<{ err: unknown }> = [];
        const q = new pg.Query('DEALLOCATE ALL');
        (q as unknown as { query_timeout?: number }).query_timeout = 5_000;
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(
          q,
          (err: unknown) => {
            calls.push({ err });
            warmEntryAtCallback = parsedStatementsOf(client)[shape.name];
            parsedStatementsOf(client).sub_timer_sentinel = 'SELECT 1';
          },
        );
        expect(returned).toBe(q);
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toEqual([{ err: null }]);
        expect(warmEntryAtCallback).toBeUndefined();
        expect(parsedStatementsOf(client).sub_timer_sentinel).toBe('SELECT 1');

        const rerun = await client.query(shape);
        expect(rerun.rows).toEqual([{ n: 49 }]);
      } finally {
        delete parsedStatementsOf(client).sub_timer_sentinel;
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it("evicts via 'end' after a fired query_timeout silenced the Submittable's callback channel (simulated pg sequence)", async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_timeout_stmt', 45);

        // pg 8.22 fact (lib/client.js): when a configured query_timeout
        // FIRES, pg invokes the PRE-WRAP callback with the timeout Error and
        // replaces query.callback with a noop — the callback channel goes
        // silent and any wrapper installed after super.query is discarded
        // unseen. If the query later completes for real,
        // handleReadyForQuery still calls the (noop) callback and emits
        // 'end'. A real DEALLOCATE cannot be delayed past a timer
        // deterministically, so this fake drives pg's EXACT sequence by
        // hand: a silent submit (nothing on the wire), the manual timeout
        // effects, then a test-sent Sync whose ReadyForQuery makes pg call
        // the active query's handleReadyForQuery — same drive-to-completion
        // seam as the throwing-submit fakes above.
        const userCallback = vi.fn();
        let wire: pg.Connection | undefined;
        type FakeSubmittable = EventEmitter & {
          text: string;
          callback: (err: unknown, res: unknown) => void;
          submit: (connection: pg.Connection) => void;
          handleReadyForQuery: () => void;
          handleError: (err: Error) => void;
        };
        const fake: FakeSubmittable = Object.assign(new EventEmitter(), {
          text: 'DEALLOCATE ALL',
          callback: userCallback as (err: unknown, res: unknown) => void,
          submit: (connection: pg.Connection): void => {
            // Wire silence: the DEALLOCATE never reaches the backend — this
            // is a unit-level pin of the bridge's channel bookkeeping, so
            // only parsedStatements is asserted, never backend state.
            wire = connection;
          },
          handleReadyForQuery: (): void => {
            // pg.Query's sequence: callback first, then always 'end'.
            fake.callback(null, undefined);
            fake.emit('end');
          },
          handleError: (err: Error): void => {
            fake.emit('error', err);
          },
        });
        // A red-state teardown must not crash the worker on an unlistened
        // 'error' emit.
        fake.on('error', () => {});

        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(fake);
        expect(returned).toBe(fake);
        expect(wire).toBeDefined();
        const ended = new Promise<void>((resolve) => {
          fake.once('end', () => resolve());
        });

        // Simulate pg's timer firing: the captured pre-wrap callback gets
        // the timeout error directly, then query.callback is REPLACED with
        // a noop.
        userCallback(new Error('Query read timeout'));
        fake.callback = () => {};

        // No eviction yet — the callback channel never reported success.
        expect(parsedStatementsOf(client)[shape.name]).toBeDefined();

        // Drive the REAL completion: a bare Sync round-trips to
        // ReadyForQuery and pg hands it to the active query.
        wire?.sync();
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The 'end' channel carried the eviction — matching the plain-text
        // path's evict-on-real-completion semantics. Red while unfixed: the
        // entry survives.
        expect(parsedStatementsOf(client)[shape.name]).toBeUndefined();
        // The silenced callback was never invoked again by the bridge.
        expect(userCallback).toHaveBeenCalledTimes(1);

        // The client is unwedged and usable. (The warm shape itself is NOT
        // re-run: the backend never really deallocated, so the evicted name
        // would re-Parse into 42P05 — bookkeeping, not backend state, is
        // what this unit-level pin asserts.)
        const alive = await settledOrPending(client.query('SELECT 1 AS ok'), 5_000);
        expect(alive).not.toBe('pending');
        if (alive !== 'pending') expect(alive.rows).toEqual([{ ok: 1 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('keeps warm caches intact when a Submittable DEALLOCATE errors (missing name, 26000)', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_err_keep_stmt', 46);

        // The backend rejects the DEALLOCATE (undefined prepared
        // statement). pg delivers callback(err) XOR emit('error') and never
        // emits 'end' — no eviction may fire on either channel: the warm
        // statement was never dropped server-side.
        const q = new pg.Query('DEALLOCATE sub_missing_name');
        const failed = new Promise<unknown>((resolve) => {
          q.once('error', resolve);
        });
        expect(client.query(q)).toBe(q);
        const err = await settledOrPending(failed, 5_000);
        expect(err).not.toBe('pending');
        expect((err as { code?: string }).code).toBe('26000');

        // The parse-skip entry survived and the warm run still skips Parse
        // into a working Bind.
        expect(parsedStatementsOf(client)[shape.name]).toBeDefined();
        const rerun = await client.query(shape);
        expect(rerun.rows).toEqual([{ n: 46 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('delivers the 26000 error to a positional callback exactly once without evicting (Submittable DEALLOCATE, callback channel)', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_err_cb_stmt', 51);

        // A trailing positional callback: stock pg's submittable arm assigns
        // it as query.callback BEFORE the bridge arms eviction, so the error
        // travels through the bridge's WRAPPED callback — pg calls
        // callback(err) (no 'error' emit, no 'end'), and the wrap's err-arm
        // must delegate untouched and evict nothing. The event-channel twin
        // above never exercises the wrap; this one pins it.
        const done = Promise.withResolvers<void>();
        const cb = vi.fn((..._args: unknown[]) => done.resolve());
        const q = new pg.Query('DEALLOCATE sub_missing_cb_name');
        // Red-state safety: a wrap that loses the callback would route the
        // failure to the event channel — resolve instead of crashing the
        // worker on an unlistened 'error' emit, and let the call-count
        // assertion report the regression.
        q.once('error', () => done.resolve());
        // (@types/pg types no Submittable-plus-callback overload; pg's
        // runtime accepts it and returns the submittable itself.)
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(q, cb);
        expect(returned).toBe(q);
        await expect(settledOrPending(done.promise, 5_000)).resolves.toBeUndefined();
        // Let any erroneous second delivery (e.g. a stray 'end' hop) land
        // before the exactly-once assertion.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(cb).toHaveBeenCalledTimes(1);
        const [err, res] = cb.mock.calls[0] ?? [];
        expect((err as { code?: string } | undefined)?.code).toBe('26000');
        expect(res).toBeUndefined();

        // No eviction on error: the entry survives and the warm run still
        // skips Parse into a working Bind.
        expect(parsedStatementsOf(client)[shape.name]).toBeDefined();
        const rerun = await client.query(shape);
        expect(rerun.rows).toEqual([{ n: 51 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it("fail-closed: a DEALLOCATE-shaped Submittable with neither callback nor 'once' never evicts and never throws", async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_nochannel_stmt', 47);

        // No 'once', no callback: the bridge has no completion channel to
        // arm, so the detection hit is skipped fail-closed — query() must
        // return the object without throwing and must never evict. The
        // fake's submit sends only a Sync (nothing executes server-side);
        // completion is observed through handleReadyForQuery, which pg
        // invokes on the active query when the Sync's ReadyForQuery
        // arrives — keeping pg's queue unwedged without any event channel.
        const completion = Promise.withResolvers<void>();
        const fake = {
          text: 'DEALLOCATE ALL',
          submit: (connection: pg.Connection): void => {
            connection.sync();
          },
          handleReadyForQuery: (): void => {
            completion.resolve();
          },
          handleError: (err: Error): void => {
            completion.reject(err);
          },
        };
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(fake);
        expect(returned).toBe(fake);
        await expect(settledOrPending(completion.promise, 5_000)).resolves.toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Fail-closed means NO eviction: the entry survives and the warm
        // shape still runs (the backend never actually deallocated).
        expect(parsedStatementsOf(client)[shape.name]).toBeDefined();
        const rerun = await client.query(shape);
        expect(rerun.rows).toEqual([{ n: 47 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it("fail-closed: a throwing .text getter skips detection without breaking the Submittable's query()", async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_text_throw_stmt', 50);

        // A REAL pg.Query cannot carry a throwing .text getter — its own
        // submit() reads this.text and would explode mid-pulse — so a fake
        // with a working submit isolates the bridge's single detection
        // read. Stock pg's submittable arm reads no .text (verified against
        // pg 8.22 client.js), so the bridge is the only reader in play:
        // the throw must be swallowed (detection skipped, no eviction) and
        // query() must return normally.
        type ThrowingTextFake = EventEmitter & {
          submit: (connection: pg.Connection) => void;
          handleReadyForQuery: () => void;
          handleError: (err: Error) => void;
        };
        const fake: ThrowingTextFake = Object.assign(new EventEmitter(), {
          submit: (connection: pg.Connection): void => {
            connection.sync();
          },
          handleReadyForQuery: (): void => {
            fake.emit('end');
          },
          handleError: (err: Error): void => {
            fake.emit('error', err);
          },
        });
        Object.defineProperty(fake, 'text', {
          get: (): string => {
            throw new Error('text getter boom');
          },
        });
        fake.on('error', () => {});

        let returned: unknown = 'not returned';
        expect(() => {
          returned = (client.query as unknown as (...args: unknown[]) => unknown)(fake);
        }).not.toThrow();
        expect(returned).toBe(fake);
        const ended = new Promise<void>((resolve) => {
          fake.once('end', () => resolve());
        });
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Detection was skipped, so nothing was evicted.
        expect(parsedStatementsOf(client)[shape.name]).toBeDefined();
        const rerun = await client.query(shape);
        expect(rerun.rows).toEqual([{ n: 50 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('arms eviction on the deferred Submittable admission behind a busy chain', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const shape = await warmNamedStatement(client, 'sub_deferred_stmt', 48);

        // The opener occupies the submission chain, so the Submittable
        // takes the DEFERRED arm — detection and channel arming must ride
        // the deferred super.query hand-off exactly like the immediate arm.
        const opener = client.query('SELECT pg_sleep(0.05)');
        const calls: Array<{ err: unknown }> = [];
        const q = new pg.Query('DEALLOCATE ALL');
        const ended = new Promise<void>((resolve, reject) => {
          q.once('end', () => resolve());
          q.once('error', reject);
        });
        const returned = (client.query as unknown as (...args: unknown[]) => unknown)(
          q,
          (err: unknown) => {
            calls.push({ err });
          },
        );
        expect(returned).toBe(q);

        await opener;
        await expect(settledOrPending(ended, 5_000)).resolves.toBeUndefined();
        expect(calls).toEqual([{ err: null }]);

        // Post-drain, the eviction happened: the warm shape re-Parses
        // cleanly instead of skipping into a 26000.
        const rerun = await client.query(shape);
        expect(rerun.rows).toEqual([{ n: 48 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('leaves a successor chain tail in place when the cleanup link settles (identity check)', async () => {
    // Pins the cleanup link's tail-release identity check: a next-checkout
    // query that chains BEFORE the link settles replaces the chain tail, and
    // the link's own release must leave that successor tail alone — clearing
    // it would let a later query bypass the successor's serialization. Same
    // stub seam as above; the client never connected, so the link's run-time
    // re-check no-ops (no duplex) and only the chain mechanics are in play.
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    try {
      const gates: Array<() => void> = [];
      pg.Client.prototype.query = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            gates.push(resolve);
          }),
      ) as unknown as typeof pg.Client.prototype.query;

      // Busy chain at release time, so the cleanup is deferred onto a link…
      const opener = client.query('SELECT 1') as Promise<unknown>;
      client.rollbackAbandonedTransaction();
      // …and the successor chains behind the still-pending link.
      const successor = client.query('SELECT 2') as Promise<unknown>;

      gates[0]?.();
      await opener;
      // The successor submits only after the link settles; wait for its
      // gated stub call to appear, then let it finish.
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1]?.();
      await expect(successor).resolves.toBeUndefined();
    } finally {
      pg.Client.prototype.query = origQuery;
    }
  });

  it('keeps a reentrant toPostgres query tail after the outer query settles', async () => {
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const outer = Promise.withResolvers<unknown>();
    const nested = Promise.withResolvers<unknown>();
    let nestedQuery: Promise<unknown> | undefined;
    let nestedTail: Promise<void> | undefined;

    try {
      pg.Client.prototype.query = vi.fn((config: unknown) => {
        if (typeof config === 'object' && config !== null) {
          const value = (config as { values: Array<{ toPostgres: () => unknown }> }).values[0];
          value?.toPostgres();
          return outer.promise;
        }
        return nested.promise;
      }) as unknown as typeof pg.Client.prototype.query;

      const outerQuery = client.query({
        text: 'SELECT $1',
        values: [
          {
            toPostgres: () => {
              nestedQuery = client.query('SELECT nested') as Promise<unknown>;
              nestedTail = (client as unknown as { querySubmissionChain?: Promise<void> })
                .querySubmissionChain;
              return 1;
            },
          },
        ],
      }) as Promise<unknown>;

      expect(nestedQuery).toBeDefined();
      expect(nestedTail).toBeDefined();
      outer.resolve({ command: 'SELECT' });
      await outerQuery;
      expect(
        (client as unknown as { querySubmissionChain?: Promise<void> }).querySubmissionChain,
      ).toBe(nestedTail);
    } finally {
      outer.resolve(undefined);
      nested.resolve(undefined);
      await (nestedQuery ?? nested.promise);
      pg.Client.prototype.query = origQuery;
    }
  });

  it('keeps a reentrant warm FastQuery parser query tail after the outer query settles', async () => {
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const nested = Promise.withResolvers<unknown>();
    let nestedQuery: Promise<unknown> | undefined;
    let nestedTail: Promise<void> | undefined;
    let fastQuery: FastQuery | undefined;

    try {
      pg.Client.prototype.query = vi.fn((query: unknown) => {
        if (query instanceof FastQuery) {
          fastQuery = query;
          const runtime = query as unknown as {
            types: {
              getTypeParser: (oid: number, format?: string) => (value: string) => unknown;
            };
            handleReadyForQuery: () => void;
          };
          runtime.types.getTypeParser(23, 'text');
          runtime.handleReadyForQuery();
          return query;
        }
        return nested.promise;
      }) as unknown as typeof pg.Client.prototype.query;

      const outerQuery = client.query({
        name: 'reentrant_fast_parser',
        text: 'SELECT 1',
        values: [],
        rowMode: 'array',
        types: {
          getTypeParser: () => {
            nestedQuery = client.query('SELECT nested fast parser') as Promise<unknown>;
            nestedTail = (client as unknown as { querySubmissionChain?: Promise<void> })
              .querySubmissionChain;
            return (value: string) => value;
          },
        },
      }) as Promise<unknown>;

      expect(fastQuery).toBeInstanceOf(FastQuery);
      expect(nestedQuery).toBeDefined();
      expect(nestedTail).toBeDefined();
      await outerQuery;
      expect(
        (client as unknown as { querySubmissionChain?: Promise<void> }).querySubmissionChain,
      ).toBe(nestedTail);
    } finally {
      fastQuery?.handleReadyForQuery();
      nested.resolve(undefined);
      await (nestedQuery ?? nested.promise);
      pg.Client.prototype.query = origQuery;
    }
  });

  it('clears a fresh reservation after synchronous submission throws', async () => {
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const expected = new Error('synchronous submission failure');
    let throwSynchronously = true;

    try {
      pg.Client.prototype.query = vi.fn(() => {
        if (throwSynchronously) throw expected;
        return Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      await expect(client.query('SELECT sync throw')).rejects.toBe(expected);
      throwSynchronously = false;
      await expect(client.query('SELECT successor')).resolves.toEqual({ command: 'SELECT' });
      expect(
        (client as unknown as { querySubmissionChain?: Promise<void> }).querySubmissionChain,
      ).toBeUndefined();
    } finally {
      pg.Client.prototype.query = origQuery;
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

describe('PgBridgeClient — submission-chain query_timeout budget', () => {
  const bridgeOptions = () => ({
    pglite,
    sessionLock: new SessionLock(),
    bridgeId: Symbol('bridge'),
    syncToFs: false,
  });

  const clientWithTimeout = (queryTimeout = 0): PgBridgeClient =>
    new PgBridgeClient({
      query_timeout: queryTimeout,
      [PgBridgeClient.OptionsKey]: bridgeOptions(),
    });

  const connectionTimeout = (client: PgBridgeClient): number =>
    (
      client as unknown as {
        connectionParameters: { query_timeout: number };
      }
    ).connectionParameters.query_timeout;

  const setConnectionTimeout = (client: PgBridgeClient, value: number): void => {
    (
      client as unknown as {
        connectionParameters: { query_timeout: number };
      }
    ).connectionParameters.query_timeout = value;
  };

  const flushPromiseChain = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('uses the explicit timeout from the public call, suppresses stock timers, and keeps the chain on actual execution', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(100);
    const execution = Promise.withResolvers<unknown>();
    const observed: Array<{ perQuery: unknown; fallback: number }> = [];

    try {
      pg.Client.prototype.query = vi.fn((config: unknown) => {
        observed.push({
          perQuery:
            typeof config === 'object' && config !== null
              ? (config as { query_timeout?: unknown }).query_timeout
              : undefined,
          fallback: connectionTimeout(client),
        });
        return execution.promise;
      }) as unknown as typeof pg.Client.prototype.query;

      const config = { text: 'SELECT timed', query_timeout: 20 };
      const timed = client.query(config) as Promise<unknown>;
      let outcome: unknown = 'pending';
      void timed.then(
        (value) => {
          outcome = value;
        },
        (error) => {
          outcome = error;
        },
      );

      expect(observed).toEqual([{ perQuery: 0, fallback: 0 }]);
      expect(config.query_timeout).toBe(20);
      expect(connectionTimeout(client)).toBe(100);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(20);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('Query read timeout');

      setConnectionTimeout(client, 0);
      const successor = client.query('SELECT successor') as Promise<unknown>;
      expect(pg.Client.prototype.query).toHaveBeenCalledTimes(1);

      execution.resolve({ command: 'SELECT' });
      await flushPromiseChain();
      expect(pg.Client.prototype.query).toHaveBeenCalledTimes(2);
      await expect(successor).resolves.toEqual({ command: 'SELECT' });
    } finally {
      execution.resolve(undefined);
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });

  it('preserves the live default budget for synchronous re-entry during stock timeout suppression', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(0);
    const outerExecution = Promise.withResolvers<unknown>();
    let outerQuery: Promise<unknown> | undefined;
    let nestedQuery: Promise<unknown> | undefined;
    const suppressedDefaults: number[] = [];

    try {
      pg.Client.prototype.query = vi.fn(() => {
        if (nestedQuery === undefined) {
          suppressedDefaults.push(connectionTimeout(client));
          nestedQuery = client.query('SELECT nested default') as Promise<unknown>;
          return outerExecution.promise;
        }
        return Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      setConnectionTimeout(client, 25);
      outerQuery = client.query({
        text: 'SELECT outer explicit',
        query_timeout: 10,
      }) as Promise<unknown>;

      expect(suppressedDefaults).toEqual([0]);
      expect(nestedQuery).toBeDefined();
      expect(pg.Client.prototype.query).toHaveBeenCalledTimes(1);
      expect(connectionTimeout(client)).toBe(25);
      expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([10, 25]);
    } finally {
      outerExecution.resolve({ command: 'SELECT' });
      await Promise.allSettled([outerQuery ?? Promise.resolve(), nestedQuery ?? Promise.resolve()]);
      pg.Client.prototype.query = origQuery;
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('starts the default budget while queued, treats per-query zero as fallback, skips expired work, and preserves callback parity', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(0);
    const opener = Promise.withResolvers<unknown>();
    const submitted: unknown[] = [];

    try {
      pg.Client.prototype.query = vi.fn((config: unknown) => {
        submitted.push(config);
        return submitted.length === 1 ? opener.promise : Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      const first = client.query('SELECT opener') as Promise<unknown>;
      setConnectionTimeout(client, 25);

      const zeroFallsBack = client.query({
        text: 'SELECT skipped promise',
        query_timeout: 0,
      }) as Promise<unknown>;
      let promiseOutcome: unknown = 'pending';
      void zeroFallsBack.catch((error: unknown) => {
        promiseOutcome = error;
      });

      const callbackCalls: Array<{ error: unknown; result: unknown }> = [];
      const callbackReturn = client.query(
        'SELECT skipped callback',
        (error: unknown, result: unknown) => callbackCalls.push({ error, result }),
      );
      expect(callbackReturn).toBeUndefined();
      expect(vi.getTimerCount()).toBe(2);

      setConnectionTimeout(client, 0);
      const successor = client.query('SELECT successor') as Promise<unknown>;

      await vi.advanceTimersByTimeAsync(25);
      expect(promiseOutcome).toBeInstanceOf(Error);
      expect((promiseOutcome as Error).message).toBe('Query read timeout');
      expect(callbackCalls).toHaveLength(1);
      expect(callbackCalls[0]?.error).toMatchObject({ message: 'Query read timeout' });
      expect(callbackCalls[0]?.result).toBeUndefined();
      expect(submitted).toEqual(['SELECT opener']);

      opener.resolve({ command: 'SELECT' });
      await first;
      await expect(successor).resolves.toEqual({ command: 'SELECT' });
      expect(submitted).toEqual(['SELECT opener', 'SELECT successor']);
      expect(callbackCalls).toHaveLength(1);
    } finally {
      opener.resolve(undefined);
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });

  it('restores both timeout sources and suppression context when stock submission throws synchronously', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(40);
    const expected = new Error('submit boom');
    const config = { text: 'SELECT boom', query_timeout: 15 };
    const observed: Array<{ perQuery: unknown; fallback: number }> = [];
    let shouldThrow = true;
    // Armed-timer delays are the only observable a leaked suppression stash
    // has: a stale stash resurrects the old 40ms default for the follow-up
    // query, whose timer is cleared before getTimerCount() could see it.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      pg.Client.prototype.query = vi.fn((ownedConfig: unknown) => {
        observed.push({
          perQuery:
            typeof ownedConfig === 'object' && ownedConfig !== null
              ? (ownedConfig as { query_timeout?: unknown }).query_timeout
              : undefined,
          fallback: connectionTimeout(client),
        });
        if (shouldThrow) {
          shouldThrow = false;
          throw expected;
        }
        return Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      await expect(client.query(config)).rejects.toBe(expected);
      expect(observed).toEqual([{ perQuery: 0, fallback: 0 }]);
      expect(config.query_timeout).toBe(15);
      expect(connectionTimeout(client)).toBe(40);
      expect(vi.getTimerCount()).toBe(0);

      setConnectionTimeout(client, 0);
      await expect(client.query('SELECT after throw')).resolves.toEqual({ command: 'SELECT' });
      expect(observed).toEqual([
        { perQuery: 0, fallback: 0 },
        { perQuery: undefined, fallback: 0 },
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([15]);
    } finally {
      setTimeoutSpy.mockRestore();
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });

  it('restores the per-query timeout on the owned config after suppression', async () => {
    // Kills 2183 (`ownedConfig !== undefined` on the restore line → false): the
    // suppression frame sets the owned snapshot's query_timeout to 0 for stock
    // admission and MUST restore it in the finally. Under the mutant the restore is
    // skipped, so the snapshot's query_timeout is left at 0 instead of its original.
    // Observe by capturing the owned snapshot pg is handed and reading its
    // query_timeout after the query settles: 0 during submit (suppressed), restored
    // to the per-query value afterward.
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(0);
    let owned: { query_timeout?: unknown } | undefined;
    let seenDuringSubmit: unknown;
    try {
      pg.Client.prototype.query = vi.fn((config: unknown) => {
        if (typeof config === 'object' && config !== null) {
          owned = config as { query_timeout?: unknown };
          seenDuringSubmit = (config as { query_timeout?: unknown }).query_timeout;
        }
        return Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      await client.query({ text: 'SELECT timed', query_timeout: 20 });

      // Suppressed to 0 for stock admission (the bridge owns the timer)...
      expect(seenDuringSubmit).toBe(0);
      // ...then restored on the owned snapshot in the finally. The mutant leaves 0.
      expect(owned?.query_timeout).toBe(20);
    } finally {
      pg.Client.prototype.query = origQuery;
      client.deregisterLiveClient();
    }
  });

  it('never mutates a frozen caller query config', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(40);
    const config = Object.freeze({ text: 'SELECT frozen', query_timeout: 15 });

    try {
      pg.Client.prototype.query = vi.fn(() =>
        Promise.resolve({ command: 'SELECT' }),
      ) as unknown as typeof pg.Client.prototype.query;

      await expect(client.query(config)).resolves.toEqual({ command: 'SELECT' });
      expect(config.query_timeout).toBe(15);
      expect(connectionTimeout(client)).toBe(40);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });

  it('keeps a defaulted FastQuery and its successor chained behind the late ReadyForQuery', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(20);
    const submitted: unknown[] = [];
    let fastQuery: FastQuery | undefined;

    try {
      pg.Client.prototype.query = vi.fn((query: unknown) => {
        submitted.push(query);
        if (query instanceof FastQuery) fastQuery = query;
        return Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      const config = {
        name: 'timeout_fast_query',
        text: 'SELECT 1',
        values: [],
        rowMode: 'array' as const,
        types: pg.types,
        query_timeout: 0,
      };
      const timed = client.query(config) as Promise<unknown>;
      let outcome: unknown = 'pending';
      void timed.catch((error: unknown) => {
        outcome = error;
      });

      expect(fastQuery).toBeInstanceOf(FastQuery);
      expect(submitted).toHaveLength(1);
      expect(connectionTimeout(client)).toBe(20);
      expect(config.query_timeout).toBe(0);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(20);
      expect(outcome).toMatchObject({ message: 'Query read timeout' });

      setConnectionTimeout(client, 0);
      const successor = client.query('SELECT successor') as Promise<unknown>;
      expect(submitted).toHaveLength(1);

      fastQuery?.handleCommandComplete({ text: 'SELECT 0' });
      fastQuery?.handleReadyForQuery();
      await flushPromiseChain();
      expect(submitted).toHaveLength(2);
      await expect(successor).resolves.toEqual({ command: 'SELECT' });
    } finally {
      fastQuery?.handleReadyForQuery();
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });

  it('keeps release cleanup and callback delivery behind an admitted query that rejects late', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(0);
    const execution = Promise.withResolvers<unknown>();
    const submitted: unknown[] = [];
    const callbackCalls: Array<{ error: unknown; result: unknown }> = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      pg.Client.prototype.query = vi.fn((config: unknown) => {
        submitted.push(config);
        return submitted.length === 1 ? execution.promise : Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      const returned = client.query(
        { text: 'SELECT callback', query_timeout: 20 },
        (error: unknown, result: unknown) => callbackCalls.push({ error, result }),
      );
      expect(returned).toBeUndefined();

      // This is the same release-listener seam PgBridgePool uses. The cleanup
      // link must follow actual execution, not the already-timed-out callback.
      client.rollbackAbandonedTransaction();
      const successor = client.query('SELECT successor') as Promise<unknown>;

      await vi.advanceTimersByTimeAsync(20);
      expect(callbackCalls).toHaveLength(1);
      expect(callbackCalls[0]?.error).toMatchObject({ message: 'Query read timeout' });
      expect(callbackCalls[0]?.result).toBeUndefined();
      expect(submitted).toHaveLength(1);

      execution.reject(new Error('late execution failure'));
      await expect(successor).resolves.toEqual({ command: 'SELECT' });
      expect(submitted).toHaveLength(2);
      expect(callbackCalls).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      execution.resolve(undefined);
      process.removeListener('unhandledRejection', onUnhandled);
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });

  it('suppresses connectionParameters.query_timeout at the moment a deferred query is submitted to the wire', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(5000);
    const opener = Promise.withResolvers<unknown>();
    const observedAtSubmit: Array<{ perQuery: unknown; fallback: number }> = [];

    try {
      pg.Client.prototype.query = vi.fn((config: unknown) => {
        observedAtSubmit.push({
          perQuery:
            typeof config === 'object' && config !== null
              ? (config as { query_timeout?: unknown }).query_timeout
              : undefined,
          fallback: connectionTimeout(client),
        });
        return observedAtSubmit.length === 1
          ? opener.promise
          : Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      // First query occupies the chain — no timeout so it blocks indefinitely.
      setConnectionTimeout(client, 0);
      const first = client.query('SELECT opener') as Promise<unknown>;

      // Re-arm the connection timeout before issuing the deferred query.
      setConnectionTimeout(client, 5000);
      const deferredConfig = { text: 'SELECT deferred', query_timeout: 5000 };
      const deferred = client.query(deferredConfig) as Promise<unknown>;

      // The deferred execute() has not run yet — first is still pending.
      expect(observedAtSubmit).toHaveLength(1);
      expect(observedAtSubmit[0]).toEqual({ perQuery: undefined, fallback: 0 });

      // Settle the opener so the deferred execute() runs.
      opener.resolve({ command: 'SELECT' });
      await first;
      await flushPromiseChain();

      // Now the deferred query was submitted — suppression must have zeroed both.
      expect(observedAtSubmit).toHaveLength(2);
      expect(observedAtSubmit[1]).toEqual({ perQuery: 0, fallback: 0 });

      // Caller's config must be restored to its original value.
      expect(deferredConfig.query_timeout).toBe(5000);

      await deferred;
    } finally {
      opener.resolve(undefined);
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });

  it('restores connectionParameters.query_timeout after a deferred query settles', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(5000);
    const opener = Promise.withResolvers<unknown>();

    try {
      const observedAtSubmit: unknown[] = [];
      pg.Client.prototype.query = vi.fn((config: unknown) => {
        observedAtSubmit.push(config);
        return observedAtSubmit.length === 1
          ? opener.promise
          : Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;

      setConnectionTimeout(client, 0);
      const first = client.query('SELECT opener') as Promise<unknown>;

      // Re-arm before queuing the deferred query.
      setConnectionTimeout(client, 5000);
      const deferredConfig = { text: 'SELECT deferred restore', query_timeout: 5000 };
      const deferred = client.query(deferredConfig) as Promise<unknown>;

      // Settle the opener so the deferred executes.
      opener.resolve({ command: 'SELECT' });
      await first;
      await deferred;

      // After the deferred query settles, both timeout sources must be restored.
      expect(connectionTimeout(client)).toBe(5000);
      expect(deferredConfig.query_timeout).toBe(5000);
    } finally {
      opener.resolve(undefined);
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });

  it('enforces the bridge timeout on the deferred path when the backend never responds', async () => {
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = clientWithTimeout(0);
    const opener = Promise.withResolvers<unknown>();
    // The deferred query's backend will never respond.
    const deferred = Promise.withResolvers<unknown>();

    try {
      let submitCount = 0;
      pg.Client.prototype.query = vi.fn(() => {
        submitCount++;
        return submitCount === 1 ? opener.promise : deferred.promise;
      }) as unknown as typeof pg.Client.prototype.query;

      // First query — no timeout, holds the chain.
      setConnectionTimeout(client, 0);
      const first = client.query('SELECT opener') as Promise<unknown>;

      // Set a short connection-level timeout and queue the deferred query.
      setConnectionTimeout(client, 30);
      const deferredQuery = client.query('SELECT deferred timeout') as Promise<unknown>;
      let deferredOutcome: unknown = 'pending';
      void deferredQuery.then(
        (v) => {
          deferredOutcome = v;
        },
        (e) => {
          deferredOutcome = e;
        },
      );

      // The timeout timer for the deferred query is armed at query() call time,
      // so it can fire while the first query is still in flight.
      await vi.advanceTimersByTimeAsync(30);
      expect(deferredOutcome).toBeInstanceOf(Error);
      expect((deferredOutcome as Error).message).toBe('Query read timeout');

      // Settle the opener — the deferred execute() may run but the result is
      // still the already-rejected public promise.
      opener.resolve({ command: 'SELECT' });
      await first;
      await flushPromiseChain();
      expect(submitCount).toBeGreaterThanOrEqual(1);
    } finally {
      opener.resolve(undefined);
      deferred.resolve(undefined);
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
    }
  });
});

// Plan A3-A6 (promise-form rows) — the bridge must snapshot the supported
// pg call shapes at query() invocation, reading each pg-consumed field
// exactly once and never evaluating unrelated enumerable getters, matching
// stock pg's synchronous `new Query(config)` construction. A busy predecessor
// forces the deferred submission path where the pre-fix closure re-reads the
// mutable config. These assert exact getter read counts, exact executed
// values, and exact reference identity — not error codes.
describe('PgBridgeClient — call-time query-config snapshot (promise forms)', () => {
  it('A3 reads a text getter exactly once and executes the first value', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        let reads = 0;
        // A valid-but-different SQL on the second read; the query must observe
        // the FIRST read's value only. Pre-fix detect + name-injection +
        // fastSubmit + pg's deferred Query construction each read `text`, so
        // the count exceeds one and a later read's value is executed.
        const config = {
          get text(): string {
            const value = reads === 0 ? 'SELECT 1 AS n' : 'SELECT 2 AS n';
            reads++;
            return value;
          },
        };
        const predecessor = client.query('SELECT pg_sleep(0.05)');
        const result = (await client.query(config as pg.QueryConfig)) as pg.QueryResult<{
          n: number;
        }>;
        await predecessor;

        expect(reads).toBe(1);
        expect(result.rows[0]?.n).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('A4 snapshots a scalar config: a text reassigned after query() returns has no effect', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const predecessor = client.query('SELECT pg_sleep(0.05)');
        const config = { text: 'SELECT 1 AS n' };
        const pending = client.query(config) as Promise<pg.QueryResult<{ n: number }>>;
        // Stock pg constructs the Query synchronously in query(); this
        // reassignment must not reach the backend. Pre-fix the deferred
        // closure re-reads config.text and runs the reassigned SELECT 2.
        config.text = 'SELECT 2 AS n';
        const result = await pending;
        await predecessor;

        expect(result.rows[0]?.n).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('A4 snapshots a scalar config on the positional-callback re-entry path', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // A positional callback (NOT an embedded-callback config, which would
        // take the rest-spread path and incidentally snapshot). The config's
        // text is reassigned after query() returns; the callback must receive
        // the FIRST value's rows. Pre-fix the deferred closure re-reads the
        // mutated text.
        const predecessor = client.query('SELECT pg_sleep(0.05)');
        const config = { text: 'SELECT 1 AS n' };
        const delivered = await new Promise<number>((resolve, reject) => {
          (client.query as unknown as (...args: unknown[]) => unknown)(
            config,
            (err: unknown, res: pg.QueryResult<{ n: number }>) => {
              if (err) reject(err);
              // biome-ignore lint/style/noNonNullAssertion: SELECT n always yields one row
              else resolve(res.rows[0]!.n);
            },
          );
          config.text = 'SELECT 2 AS n';
        });
        await predecessor;

        expect(delivered).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('A5 keeps a captured values array by reference and observes its later element mutation', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const capturedValues = [41];
        const otherValues = [99];
        const config = { text: 'SELECT $1::int AS v', values: capturedValues };
        const predecessor = client.query('SELECT pg_sleep(0.05)');
        const pending = client.query(config) as Promise<pg.QueryResult<{ v: number }>>;
        // Reassigning config.values must NOT switch the query away from the
        // originally captured array (stock pg's shared-reference semantics);
        // mutating that captured array's element IS observed.
        config.values = otherValues;
        capturedValues[0] = 42;
        const result = await pending;
        await predecessor;

        expect(result.rows[0]?.v).toBe(42);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('A5 positional values override config.values without mutating the caller config', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        const configValues = [41];
        const positionalValues = [42];
        const config: { text: string; values: unknown[] } = {
          text: 'SELECT $1::int AS v',
          values: configValues,
        };
        const predecessor = client.query('SELECT pg_sleep(0.05)');
        const pending = client.query(config, positionalValues) as Promise<
          pg.QueryResult<{ v: number }>
        >;
        // Later reassignment of config.values must not win over the positional
        // array; the positional element mutation IS observed.
        const reassigned = [99];
        config.values = reassigned;
        positionalValues[0] = 7;
        const result = await pending;
        await predecessor;

        expect(result.rows[0]?.v).toBe(7);
        // The bridge owns a fresh record and must NOT reproduce pg's
        // incidental in-place normalizeQueryConfig mutation of the caller's
        // config: the caller's object holds exactly what the caller last
        // wrote. Pre-fix pg rewrites config.values to the positional array.
        expect(config.values).toBe(reassigned);
        expect(configValues[0]).toBe(41);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('A6 ignores an unrelated throwing getter on the plain promise path', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // No `types` — the plain object-form promise path. Pinned as a
        // regression: it may already pass today, but must never regress into
        // a general `{ ...config }` snapshot.
        const config = {
          text: 'SELECT 1 AS n',
          get unrelated(): never {
            throw new Error('unrelated getter boom');
          },
        };
        const result = (await client.query(config as pg.QueryConfig)) as pg.QueryResult<{
          n: number;
        }>;
        expect(result.rows[0]?.n).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  it('A6 ignores an unrelated throwing getter when types are wrapped', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      try {
        // `types` present → the bridge clones for fast-array-parser wrapping.
        // Pre-fix that clone is `{ ...first }`, which evaluates the unrelated
        // getter and throws synchronously out of query().
        const config = {
          text: 'SELECT 1 AS n',
          types: pg.types,
          get unrelated(): never {
            throw new Error('unrelated getter boom');
          },
        };
        const result = (await client.query(config as pg.QueryConfig)) as pg.QueryResult<{
          n: number;
        }>;
        expect(result.rows[0]?.n).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });

  // A7 — mechanical pg field-consumption drift guard. The production snapshot
  // field list must stay in lockstep with what the installed pg version
  // actually consumes; a pg update that reads another config property would
  // otherwise be silently dropped on deferred bridge submission. Record every
  // PropertyKey read through the COMPLETE stock `pg.Client.prototype.query`
  // entry point on a live connected client — not `new pg.Query` alone, which
  // misses Client-level reads like `query_timeout` — and require the traced
  // call to finish its normal success path, so the recorded accesses belong
  // to a viable invocation. pg reads `submit` first as its dispatch probe;
  // the bridge mirrors that check (isSubmittable) before snapshotting, so it
  // is asserted in position and never part of the snapshot list. The tail is
  // compared as an order-independent exact set: repeat reads are deduped
  // because A7 guards field MEMBERSHIP, not read counts — the snapshot tests
  // own exact getter-count behavior. Residual: a runtime trace covers the
  // executed successful promise path only; a field read solely on an
  // unexecuted upstream branch (or only on the callback path) stays outside
  // any finite trace and is covered by the source citations on
  // PG_CONSUMED_QUERY_FIELDS.
  it('A7 production field list matches the full stock Client.query read set', async () => {
    const { pool, close } = await createBridgePool(pglite);
    try {
      const client = await pool.connect();
      // Destroy the checked-out client unless the traced call and every
      // assertion completed — a failed trace could leave partial upstream
      // state (a queued Query, a live read-timeout timer) that must not be
      // recycled into teardown.
      let releaseError: Error | undefined = new Error(
        'A7 full-entry-point trace did not complete cleanly',
      );
      try {
        const accesses: PropertyKey[] = [];
        // A deliberately rich callback-free promise-path config — named +
        // parameterized + extended + typed + row-limited + array rowMode +
        // timeout — so the traced path exercises the common option surface.
        // Still one executed shape, not proof over every upstream branch.
        const target: Record<string, unknown> = {
          text: 'SELECT $1::int AS n',
          values: [1],
          rows: 1,
          types: pg.types,
          name: 'a7_full_client_query_trace',
          queryMode: 'extended',
          binary: false,
          portal: '',
          rowMode: 'array',
          query_timeout: 30_000,
        };
        const proxy = new Proxy(target, {
          get(t, prop, receiver) {
            accesses.push(prop);
            return Reflect.get(t, prop, receiver);
          },
        });

        // The STOCK entry point on the bridge client's real connection —
        // bypassing the bridge override exactly the way super.query does.
        const ret = Reflect.apply(
          pg.Client.prototype.query as (...a: unknown[]) => unknown,
          client,
          [proxy],
        );
        expect((ret as { then?: unknown }).then).toBeTypeOf('function');
        const result = (await ret) as { rows: unknown[] };
        // The traced call completed its normal success path (array rowMode).
        expect(result.rows).toEqual([[1]]);

        // Copy AFTER the await: the complete successful invocation's trace.
        const deduped = [...new Set(accesses)];
        const symbols = deduped.filter((key) => typeof key === 'symbol');
        // No Symbol reads today; a future engine/pg Symbol probe must be
        // classified explicitly, never silently filtered.
        expect(symbols).toEqual([]);
        const strings = deduped.filter((key): key is string => typeof key === 'string');
        // pg's dispatch probe leads; it is classified, never snapshotted.
        expect(strings[0]).toBe('submit');
        // Exact membership, order-independent — harmless upstream read
        // reordering does not change which fields the bridge must preserve.
        expect(strings.slice(1).sort()).toEqual([...PG_CONSUMED_QUERY_FIELDS].sort());

        // The snapshot record itself must stay in lockstep with the list —
        // without this, the record literal could drop or add a field while
        // A7 stays green. (The record defines every key even for absent
        // config fields; `callback` is present exactly when the capture
        // injects one.)
        const record = snapshotQueryConfig(
          { text: 'SELECT 1' },
          { override: false },
          { omit: false, value: undefined },
        );
        expect(Object.keys(record)).toEqual([...PG_CONSUMED_QUERY_FIELDS]);

        releaseError = undefined;
      } finally {
        client.release(releaseError);
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });
});

// The duplex-teardown handle contract. pg runs the client's stream factory
// synchronously inside the PgBridgeClient constructor, so the duplex — and
// its teardown — exist long before any connect attempt. `teardown` (getter)
// is the public view; `onTeardownCreated` hands the caller the same handle
// synchronously AT CONSTRUCTION, which is what lets PgBridgePool's end()
// close barrier cover a client whose connect fails before pg-pool ever
// emits 'connect'.
describe('PgBridgeClient — duplex teardown handle', () => {
  type TeardownHandle = { settled: Promise<void>; abort: (reason: Error) => void };

  const duplexOf = (client: PgBridgeClient): PGliteDuplex => {
    const stream = client.connection.stream;
    if (!(stream instanceof PGliteDuplex)) throw new Error('expected a PGliteDuplex stream');
    return stream;
  };

  it('teardown.settled is the created duplex onClose, and abort(reason) destroys the duplex', async () => {
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const duplex = duplexOf(client);
    try {
      // `settled` IS the duplex's resolve-only close promise — identity, not
      // just same-settlement, so a barrier awaiting it can never observe an
      // earlier-resolving proxy.
      const teardown = client.teardown;
      expect(teardown.settled).toBe(duplex.onClose);

      // A never-connected duplex has no 'error' listener (pg's Connection
      // attaches its stream listeners in connect()), so capture the destroy
      // error — this keeps the emit from crashing the worker AND pins that
      // abort forwards its reason into destroy().
      const errors: unknown[] = [];
      duplex.on('error', (err) => {
        errors.push(err);
      });
      const reason = new Error('teardown abort probe');
      teardown.abort(reason);
      expect(duplex.destroyed).toBe(true);
      await expect(settledOrPending(teardown.settled, 2_000)).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(reason);
    } finally {
      client.deregisterLiveClient();
      if (!duplex.destroyed) duplex.destroy();
      await settledOrPending(duplex.onClose, 2_000).catch(() => {});
    }
  });

  it('invokes onTeardownCreated exactly once, synchronously at construction, with the duplex teardown handle', async () => {
    const handles: TeardownHandle[] = [];
    const bridge: PgBridgeClientOptions & {
      onTeardownCreated?: (teardown: TeardownHandle) => void;
    } = {
      pglite,
      bridgeId: Symbol('bridge'),
      syncToFs: false,
      onTeardownCreated: (teardown) => {
        handles.push(teardown);
      },
    };
    const client = new PgBridgeClient({ [PgBridgeClient.OptionsKey]: bridge });
    const duplex = duplexOf(client);
    try {
      // Synchronous: the handle exists by the time the constructor returns,
      // before any connect attempt.
      expect(handles).toHaveLength(1);
      const [handle] = handles;
      if (handle === undefined) throw new Error('unreachable: length asserted above');
      // The callback handle exposes the SAME duplex teardown as the public
      // getter: `settled` is the created duplex's onClose.
      expect(handle.settled).toBe(duplex.onClose);
      expect(client.teardown.settled).toBe(handle.settled);

      // And the handle's abort destroys the duplex, settling `settled`.
      const errors: unknown[] = [];
      duplex.on('error', (err) => {
        errors.push(err);
      });
      const reason = new Error('onTeardownCreated abort probe');
      handle.abort(reason);
      expect(duplex.destroyed).toBe(true);
      await expect(settledOrPending(handle.settled, 2_000)).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(reason);
      // Still exactly once — construction is the only invocation point.
      expect(handles).toHaveLength(1);
    } finally {
      client.deregisterLiveClient();
      if (!duplex.destroyed) duplex.destroy();
      await settledOrPending(duplex.onClose, 2_000).catch(() => {});
    }
  });

  it.sequential('invokes onTeardownCreated even when construction fails after the duplex is created', async () => {
    // Mirror of the assertPgInternals-failure test above: break a required
    // connection prototype member so the constructor throws AFTER pg has
    // synchronously run the stream factory. The handle must still reach the
    // callback — a construction throw must not orphan the already-created
    // duplex from the pool's end() barrier.
    const connectionPrototype = Object.getPrototypeOf(
      new pg.Client({ host: 'localhost' }).connection,
    ) as { close?: unknown };
    const closeDescriptor = Object.getOwnPropertyDescriptor(connectionPrototype, 'close');
    if (closeDescriptor === undefined) throw new Error('pg Connection.prototype.close is absent');

    const handles: TeardownHandle[] = [];
    Object.defineProperty(connectionPrototype, 'close', {
      ...closeDescriptor,
      value: undefined,
    });
    try {
      const bridge: PgBridgeClientOptions & {
        onTeardownCreated?: (teardown: TeardownHandle) => void;
      } = {
        pglite,
        bridgeId: Symbol('bridge'),
        syncToFs: false,
        statementCaching: true,
        onTeardownCreated: (teardown) => {
          handles.push(teardown);
        },
      };
      expect(() => new PgBridgeClient({ [PgBridgeClient.OptionsKey]: bridge })).toThrowError(
        /Unsupported pg internals/,
      );

      // The callback fired exactly once — inside the stream factory, before
      // the assertion threw — and the constructor's cleanup destroy settles
      // the handle it delivered (no error argument, so no 'error' emission).
      expect(handles).toHaveLength(1);
      const [handle] = handles;
      if (handle === undefined) throw new Error('unreachable: length asserted above');
      await expect(settledOrPending(handle.settled, 2_000)).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(connectionPrototype, 'close', closeDescriptor);
    }
  });
});

// ————— Tier A site pin: pool/pg-bridge-client.ts:214 — BRIDGE_OPTIONS_REQUIRED —————
// After implementation: the constructor must throw PgBridgeError with
// code BRIDGE_OPTIONS_REQUIRED and the exact current message text.
describe('PgBridgeClient constructor Tier A site pin (PgBridgeError)', () => {
  it('throws PgBridgeError instanceof Error when bridge options are missing', () => {
    let caught: unknown;
    try {
      new PgBridgeClient();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PgBridgeError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as PgBridgeError).code).toBe('BRIDGE_OPTIONS_REQUIRED');
    expect((caught as PgBridgeError).name).toBe('PgBridgeError');
    expect((caught as PgBridgeError).message).toBe('PgBridgeClient requires bridge options');
  });

  it('throws PgBridgeError with code BRIDGE_OPTIONS_REQUIRED for a config without the options key', () => {
    let caught: unknown;
    try {
      new PgBridgeClient({} as ConstructorParameters<typeof PgBridgeClient>[0]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PgBridgeError);
    expect((caught as PgBridgeError).code).toBe('BRIDGE_OPTIONS_REQUIRED');
    expect((caught as PgBridgeError).message).toBe('PgBridgeClient requires bridge options');
  });
});

describe('mutation-hardening: survivor kills', () => {
  it('deregisters from the live-client registry on end and idempotently, dropping the empty Set', async () => {
    // Sole client of a FRESH PGlite so the registry Set is exactly {this} and its
    // removal empties + drops the WeakMap entry. Kills: the 'end' hook (2019/2020),
    // the deregister body/guards (2021/2022/2024), and the size===0 cleanup (2026).
    const db = new PGlite();
    await db.waitReady;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite: db,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    try {
      // Registered at construction.
      expect(liveClients.get(db)?.has(client)).toBe(true);

      // 'end' must invoke deregisterLiveClient (kills 2019 empty-event, 2020 no-op arrow).
      client.emit('end');
      expect(liveClients.get(db)?.has(client) ?? false).toBe(false);
      // Last client of this PGlite gone → the Set is dropped from the WeakMap
      // (kills 2026: size===0 → false leaves an empty Set behind).
      expect(liveClients.has(db)).toBe(false);

      // Idempotent: a second explicit call must not throw (kills 2024's inverted
      // guard, which would call .delete on an undefined Set).
      expect(() => client.deregisterLiveClient()).not.toThrow();
    } finally {
      await db.close();
    }
  });

  it('rollbackAbandonedTransaction skips a wedged bare Submittable and an idle non-tx client without registering a cleanup link', async () => {
    // Stubbed-query seam (mirrors the existing cleanup-link tests). Two early-return
    // guards must fire: (a) active-query + no-chain + no-suspended-portal (2032/2044),
    // (b) idle + no-chain + not-in-transaction (2046/2052). In both, NO cleanup link
    // may be registered and NO abandoned-transaction warning may be emitted.
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const warnings: string[] = [];
    const origEmit = process.emitWarning.bind(process);
    process.emitWarning = ((w: unknown) => {
      warnings.push(typeof w === 'string' ? w : String((w as Error)?.message ?? w));
      return undefined as never;
    }) as typeof process.emitWarning;
    const chainOf = () =>
      (client as unknown as { querySubmissionChain?: Promise<void> }).querySubmissionChain;
    try {
      pg.Client.prototype.query = vi.fn(() =>
        Promise.resolve({ command: 'SELECT' }),
      ) as unknown as typeof pg.Client.prototype.query;

      // (b) Idle, not in a transaction, no chain: must early-return (2046/2052).
      // Ensure a clean idle state.
      expect(chainOf()).toBeUndefined();
      client.rollbackAbandonedTransaction();
      expect(chainOf()).toBeUndefined();

      // (a) Simulate a wedged bare Submittable: pg has an active query, the bridge
      // has no submission chain, and no suspended portal is recorded. The guard
      // (2032/2044) must skip — no link, no warning. Falling through (mutant) would
      // reach #chainRollbackCleanup (inTransaction: true below), registering a link.
      const getPgActiveQuery = (await import('./pg-internals.ts')).getPgActiveQuery;
      // Fabricate the active query on the slot pg-internals actually reads:
      // client._getActiveQuery() → client._activeQuery (pg >= 8.17), which the
      // deprecated client.activeQuery getter also delegates to. NOT connection._activeQuery.
      const active = new pg.Query('SELECT 1');
      (client as unknown as { _activeQuery?: unknown })._activeQuery = active;
      // Assert the fabrication lands where the guard reads it — a seam change must
      // fail here loudly, not silently skip the kill assertion below.
      expect(getPgActiveQuery(client)).toBe(active);
      // hasSuspendedPortal → false (no recoverable portal).
      Object.defineProperty(client.connection.stream, 'hasSuspendedPortal', {
        value: () => false,
        configurable: true,
      });
      Object.defineProperty(client.connection.stream, 'inTransaction', {
        get: () => true,
        configurable: true,
      });

      client.rollbackAbandonedTransaction();
      // Wedged bare Submittable (active query, no chain, no suspended portal):
      // the guard must early-return — no cleanup link registered. The mutant that
      // drops the guard falls through and registers one (chainOf() becomes defined).
      expect(chainOf()).toBeUndefined();
      expect(warnings.filter((w) => w.includes('open transaction'))).toEqual([]);
    } finally {
      process.emitWarning = origEmit;
      pg.Client.prototype.query = origQuery;
      client.deregisterLiveClient();
      const stream = client.connection.stream;
      if (stream instanceof PGliteDuplex && !stream.destroyed) stream.destroy();
      await settledOrPending((stream as PGliteDuplex).onClose, 2_000).catch(() => {});
    }
  });

  it('emits the full abandoned-transaction warning message including the roll-back guidance', async () => {
    const { pool, close } = await createBridgePool(pglite);
    const warnings: string[] = [];
    const origEmit = process.emitWarning.bind(process);
    process.emitWarning = ((w: unknown) => {
      warnings.push(typeof w === 'string' ? w : String((w as Error)?.message ?? w));
      return undefined as never;
    }) as typeof process.emitWarning;
    try {
      const client = await pool.connect();
      try {
        // Open a transaction and release without COMMIT/ROLLBACK: the cleanup link
        // emits the abandoned-transaction warning, whose message tail (2064) must
        // include the exact guidance.
        await client.query('BEGIN');
        (
          client as unknown as { rollbackAbandonedTransaction: () => void }
        ).rollbackAbandonedTransaction();
        // Let the chained cleanup link run.
        await client.query('SELECT 1').catch(() => {});
      } finally {
        client.release();
      }
    } finally {
      process.emitWarning = origEmit;
      await endPoolAndBarrier(close);
    }
    const abandoned = warnings.filter((w) => w.includes('attempting ROLLBACK'));
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toContain('Commit or roll back before release().');
  });

  it('the deferred cleanup link clears its own chain slot and leaves a successor tail intact', async () => {
    // Stubbed-query seam. Kills the cleanup link's releaseChainTail: the body must
    // run (2070), the identity check must be === and true only for its own tail
    // (2071 true-stomps a successor, 2072 false-never-clears, 2073 inverted).
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const view = client as unknown as {
      querySubmissionChain?: Promise<void>;
      rollbackAbandonedTransaction: () => void;
    };
    try {
      const gates: Array<() => void> = [];
      pg.Client.prototype.query = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            gates.push(resolve);
          }),
      ) as unknown as typeof pg.Client.prototype.query;

      // Busy chain so the cleanup defers onto a link.
      const opener = client.query('SELECT 1') as Promise<unknown>;
      view.rollbackAbandonedTransaction();
      // No successor yet: after the link settles, the chain must return to undefined
      // (2070 body-empty / 2072 false → chain never cleared).
      gates[0]?.();
      await opener;
      await vi.waitFor(() => expect(view.querySubmissionChain).toBeUndefined());

      // Now: busy chain again, defer another cleanup link, then chain a successor
      // BEFORE the link settles — the link's release must NOT clear the successor's
      // tail (2071 true / 2073 inverted would stomp it).
      const opener2 = client.query('SELECT 2') as Promise<unknown>;
      view.rollbackAbandonedTransaction();
      const successor = client.query('SELECT 3') as Promise<unknown>;
      const successorTail = view.querySubmissionChain;
      expect(successorTail).toBeDefined();
      gates[1]?.();
      await opener2;
      // Drain the cleanup link; the successor tail must survive it.
      await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3));
      expect(view.querySubmissionChain).toBe(successorTail);
      gates[2]?.();
      await expect(successor).resolves.toBeUndefined();
    } finally {
      pg.Client.prototype.query = origQuery;
      client.deregisterLiveClient();
    }
  });

  it('an ordinary query tail-release leaves a concurrent query tail intact', {
    timeout: 5_000,
  }, async () => {
    // Kills 2211 (ordinary releaseChainTail identity `=== chainTail` → true): a
    // concurrent second query installs its own tail; when the first settles it must
    // clear ONLY its own slot, leaving the second's tail so a third query stays
    // serialized behind it.
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const view = client as unknown as { querySubmissionChain?: Promise<void> };
    try {
      const gates: Array<() => void> = [];
      pg.Client.prototype.query = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            gates.push(resolve);
          }),
      ) as unknown as typeof pg.Client.prototype.query;

      // First takes the reservation path; second and third are ordinary
      // chained queries (2211 lives in the ordinary releaseChainTail). Chain a
      // third BEFORE the second settles so the second's release runs while the
      // third's tail is the live chain slot.
      const first = client.query('SELECT 1') as Promise<unknown>;
      const second = client.query('SELECT 2') as Promise<unknown>;
      const third = client.query('SELECT 3') as Promise<unknown>;
      const thirdTail = view.querySubmissionChain;
      expect(thirdTail).toBeDefined();

      // Drain the reservation (first) → the second's deferred execute runs and
      // pushes its own gate.
      gates[0]?.();
      await first;
      await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(2));

      // Settle the SECOND: its releaseChainTail fires while thirdTail is
      // installed. The identity check must clear ONLY the second's own slot,
      // leaving thirdTail intact. Under the mutant (=== → true) the second's
      // release clears the chain unconditionally, discarding thirdTail.
      gates[1]?.();
      await second;
      expect(view.querySubmissionChain).toBe(thirdTail);

      // Drain the third and confirm the chain empties.
      await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3));
      gates[2]?.();
      await expect(third).resolves.toBeUndefined();
      await vi.waitFor(() => expect(view.querySubmissionChain).toBeUndefined());
    } finally {
      pg.Client.prototype.query = origQuery;
      client.deregisterLiveClient();
    }
  });

  it('routes both null and undefined queries to stock pg synchronous TypeError', () => {
    // Kills the nullish dispatch guard (2083/2084/2085/2087): each of null and
    // undefined must throw pg's synchronous TypeError. Under any mutant that stops
    // routing a nullish first to stock pg, isSubmittable(first) reads `.submit` off
    // null/undefined and throws a DIFFERENT (Cannot read properties) error — or the
    // call no longer throws synchronously at all.
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    try {
      const throwsPgTypeError = (arg: unknown): Error => {
        let caught: unknown;
        try {
          (client.query as unknown as (a: unknown) => unknown)(arg);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(TypeError);
        return caught as Error;
      };
      // pg's message for a nullish query is the 'Client was passed a null or
      // undefined query' family — not the 'Cannot read properties of null (reading
      // submit)' the mutant would produce.
      const nullErr = throwsPgTypeError(null);
      const undefErr = throwsPgTypeError(undefined);
      expect(nullErr.message).not.toMatch(/reading '?submit'?/);
      expect(undefErr.message).not.toMatch(/reading '?submit'?/);
    } finally {
      client.deregisterLiveClient();
    }
  });

  // 2152 (`prior === undefined` → true) is EQUIVALENT — no deterministic test can
  // kill it, so no test lives here. The mutant makes a reservation be published for
  // BUSY queries too, but on the busy path execute is deferred (`prior.then(execute)`)
  // so hooks run async — there is no synchronous re-entry for the reservation to
  // guard, and the reservationTail substitutes for the ordinary chainTail with
  // identical clear semantics (self-identity, clears on settle AND reject) and
  // identical chaining. Submission order, chain-defined-while-pending,
  // drain-to-undefined, and idle-path re-engagement are all preserved; the sole
  // difference is a one-microtask-later clear that no query can synchronously
  // observe. Proof + reclassification: .claude/verify/triage-pool-pg-bridge-client.json.

  it('string-form query with a connection-default timeout settles via the timer, no ownedConfig throw', async () => {
    // Kills 2176/2177 (`ownedConfig?.query_timeout` → non-optional, `ownedConfig !==
    // undefined` → true): a STRING-form query has no ownedConfig, so execute() must
    // guard the config reads; the mutants throw TypeError reading/writing
    // .query_timeout of undefined. Also kills 2174: with no per-query config but a
    // connection default, timeout !== undefined, so the suppression frame runs and
    // must not blow up on the absent ownedConfig.
    vi.useFakeTimers();
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      query_timeout: 30,
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const never = Promise.withResolvers<unknown>();
    try {
      pg.Client.prototype.query = vi.fn(
        () => never.promise,
      ) as unknown as typeof pg.Client.prototype.query;
      // String form (no ownedConfig) + connection-default timeout: must submit
      // without throwing, then time out via the bridge timer.
      const timed = client.query('SELECT slow') as Promise<unknown>;
      let outcome: unknown = 'pending';
      void timed.then(
        (v) => {
          outcome = v;
        },
        (e) => {
          outcome = e;
        },
      );
      await vi.advanceTimersByTimeAsync(30);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('Query read timeout');
    } finally {
      never.resolve(undefined);
      pg.Client.prototype.query = origQuery;
      vi.useRealTimers();
      client.deregisterLiveClient();
    }
  });

  it('a no-timeout query does not arm the suppression frame', async () => {
    // Kills 2174 (`timeout === undefined` → false): with NO timeout configured,
    // execute() must take the fast `return submitWithCloses()` path and never touch
    // connectionParameters.query_timeout or the suppression stash. The mutant runs
    // the suppression frame, transiently zeroing connectionParameters and leaving
    // observable side effects the fast path never has.
    const origQuery = pg.Client.prototype.query;
    const client = new PgBridgeClient({
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('bridge'),
        syncToFs: false,
      },
    });
    const cp = (client as unknown as { connectionParameters: { query_timeout: unknown } })
      .connectionParameters;
    try {
      let observedAtSubmit: unknown = 'unset';
      pg.Client.prototype.query = vi.fn(() => {
        // Under the mutant the suppression frame has set connectionParameters to 0
        // by submit time; under the original it is untouched (sentinel below).
        observedAtSubmit = cp.query_timeout;
        return Promise.resolve({ command: 'SELECT' });
      }) as unknown as typeof pg.Client.prototype.query;
      // A truthy sentinel would itself arm the timeout (query_timeout is the
      // trigger), collapsing the fast/suppression distinction. Use the genuine
      // no-timeout state (undefined) and detect the mutant by the transient 0
      // its suppression frame writes to connectionParameters at submit time.
      cp.query_timeout = undefined;
      await client.query('SELECT nolimit');
      expect(observedAtSubmit).toBe(undefined);
      expect(cp.query_timeout).toBe(undefined);
    } finally {
      pg.Client.prototype.query = origQuery;
      client.deregisterLiveClient();
    }
  });

  it('a positional values array overrides config.values without reading the shadowed getter, on both promise and callback re-entry', async () => {
    // Kills the valuesOverride wiring on the promise path (2107/2108, line 524) and
    // the callback re-entry path (2255/2256, line 765). The snapshot MUST take the
    // positional array as authoritative and NEVER read config.values. Plain
    // config.values can't distinguish the mutants — stock pg (and #fastSubmit's
    // `args[1] ?? config.values`) re-apply the positional array downstream, so the
    // result is 42 either way. The load-bearing observable is the shadowed
    // config.values GETTER: with the override (original) snapshotQueryConfig never
    // reads it; without it (2107 `{}` / 2108 `false`) the snapshot falls back to
    // config.values and invokes the getter. A throwing getter turns that read into
    // a rejection the query would never otherwise produce.
    const { pool, close } = await createBridgePool(pglite);
    const makeCfg = () => {
      const cfg: { text: string; values?: unknown } = { text: 'SELECT $1::int AS v' };
      Object.defineProperty(cfg, 'values', {
        get() {
          throw new Error('shadowed config.values getter must not be read when overridden');
        },
        enumerable: true,
        configurable: true,
      });
      return cfg;
    };
    try {
      const client = await pool.connect();
      try {
        // Promise path: positional [42] wins and the config.values getter is never
        // read, so the query resolves. Under the mutant the getter throws during
        // snapshot → the promise rejects.
        const rp = (await (client.query as unknown as (...a: unknown[]) => Promise<unknown>)(
          makeCfg(),
          [42],
        )) as pg.QueryResult<{ v: number }>;
        expect(rp.rows[0]?.v).toBe(42);

        // Callback re-entry path: same override, same getter-untouched requirement.
        const delivered = await new Promise<number>((resolve, reject) => {
          (client.query as unknown as (...a: unknown[]) => unknown)(
            makeCfg(),
            [42],
            (err: unknown, res: pg.QueryResult<{ v: number }>) => {
              if (err) reject(err);
              else resolve(res.rows[0]?.v as number);
            },
          );
        });
        expect(delivered).toBe(42);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndBarrier(close);
    }
  });
});
