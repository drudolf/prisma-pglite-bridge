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
