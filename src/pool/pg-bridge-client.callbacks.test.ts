import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
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
