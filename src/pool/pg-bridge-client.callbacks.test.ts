import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

  // Plan A3 (callback getter rows) — a config `callback` must be discovered
  // with exactly one getter read when no positional callback exists, and must
  // not be read at all when a positional callback wins. Pre-fix the typeof
  // probe and the `{ callback, ...rest }` destructure each read it.
  it('A3 reads a config callback getter exactly once when no positional callback exists', async () => {
    await withPooledClient(async (client) => {
      let reads = 0;
      const calls: Array<{ err: unknown; res: unknown }> = [];
      let settle: () => void = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const config = {
        text: 'SELECT 1 AS one',
        get callback(): QueryCallback {
          reads++;
          return (err, res) => {
            calls.push({ err, res });
            settle();
          };
        },
      };

      const ret = (client.query as unknown as (...args: unknown[]) => unknown)(config);

      expect(ret).toBeUndefined();
      await settled;
      // Delivery still works: the discovered callback fires with rows.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.err).toBeNull();
      const res = calls[0]?.res as pg.QueryResult<{ one: number }>;
      expect(res.rows[0]?.one).toBe(1);
      // Exactly one getter read — no double discovery, no rest-spread.
      expect(reads).toBe(1);
    });
  });

  it('A3 does not read a config callback getter when a positional callback wins', async () => {
    await withPooledClient(async (client) => {
      let reads = 0;
      const positional = recordCallback();
      const config = {
        text: 'SELECT 1 AS one',
        get callback(): QueryCallback {
          reads++;
          return (_err, _res) => {};
        },
      };

      const ret = (client.query as unknown as (...args: unknown[]) => unknown)(
        config,
        positional.callback,
      );

      expect(ret).toBeUndefined();
      await positional.settled;
      expect(positional.calls).toHaveLength(1);
      expect(positional.calls[0]?.err).toBeNull();
      const res = positional.calls[0]?.res as pg.QueryResult<{ one: number }>;
      expect(res.rows[0]?.one).toBe(1);
      // The positional callback shadows the config one: its getter is never
      // evaluated. Pre-fix the rest-destructure still reads it once.
      expect(reads).toBe(0);
    });
  });

  // Plan A6 (callback / positional-callback rows) — an otherwise valid config
  // carrying an unrelated enumerable throwing getter must succeed as a
  // callback query. Pre-fix the `{ callback, ...rest }` destructure evaluates
  // the unrelated getter and throws synchronously out of query().
  it('A6 ignores an unrelated throwing getter with an embedded config callback', async () => {
    await withPooledClient(async (client) => {
      const { calls, callback, settled } = recordCallback();
      const config = {
        text: 'SELECT 1 AS one',
        callback,
        get unrelated(): never {
          throw new Error('unrelated getter boom');
        },
      } as unknown as CallbackConfig;

      const ret = client.query(config);

      expect(ret).toBeUndefined();
      await settled;
      expect(calls).toHaveLength(1);
      expect(calls[0]?.err).toBeNull();
      const res = calls[0]?.res as pg.QueryResult<{ one: number }>;
      expect(res.rows[0]?.one).toBe(1);
    });
  });

  it('A6 ignores an unrelated throwing getter when a positional callback overrides a config callback', async () => {
    await withPooledClient(async (client) => {
      const positional = recordCallback();
      const config = {
        text: 'SELECT 1 AS one',
        callback: (_err: unknown, _res: unknown) => {},
        get unrelated(): never {
          throw new Error('unrelated getter boom');
        },
      };

      const ret = (client.query as unknown as (...args: unknown[]) => unknown)(
        config,
        positional.callback,
      );

      expect(ret).toBeUndefined();
      await positional.settled;
      expect(positional.calls).toHaveLength(1);
      expect(positional.calls[0]?.err).toBeNull();
      const res = positional.calls[0]?.res as pg.QueryResult<{ one: number }>;
      expect(res.rows[0]?.one).toBe(1);
    });
  });

  describe('mutation-hardening', () => {
    it('omits the callback field from the config-callback re-entry snapshot', async () => {
      // Kills 2259/2260 (line 767 `{ omit: true }` → `{}` / `omit:true` → false): the
      // callback re-entry snapshot must OMIT the callback field. With omit falsy,
      // snapshotQueryConfig injects `callback: undefined` onto the re-entry record; pg
      // then carries a `callback` property on the config it runs. We observe the
      // re-entry config via a spy on the recursive query() call: the re-entered first
      // argument must have NO own 'callback' key.
      await withPooledClient(async (client) => {
        const { calls, callback, settled } = recordCallback();
        const config: CallbackConfig = { text: 'SELECT 1 AS one', callback };

        // Spy the recursive promise-form re-entry: capture the snapshot passed on.
        const seen: Array<Record<string, unknown>> = [];
        const spied = client as unknown as { query: (...a: unknown[]) => unknown };
        const orig = spied.query.bind(client);
        let depth = 0;
        spied.query = (...a: unknown[]) => {
          // The re-entry call has a snapshot object as its first arg and NO callback.
          if (depth > 0 && typeof a[0] === 'object' && a[0] !== null) {
            seen.push(a[0] as Record<string, unknown>);
          }
          depth++;
          try {
            return orig(...a);
          } finally {
            depth--;
          }
        };

        const ret = (spied.query as (...a: unknown[]) => unknown)(config);
        expect(ret).toBeUndefined();
        await settled;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.err).toBeNull();
        // The re-entry snapshot must not carry a callback field.
        const reentry = seen[0];
        expect(reentry).toBeDefined();
        expect(Object.hasOwn(reentry ?? {}, 'callback')).toBe(false);
      });
    });
  });
});

type CallbackThrowProbe = {
  implementation: 'stock' | 'bridge';
  outcome: 'success' | 'error';
  pgVersion: string;
  returnedUndefined: boolean;
  callback: { hasError: boolean; hasResult: boolean };
  observed: Array<{ channel: 'uncaughtException' | 'unhandledRejection'; message: string }>;
};

const CALLBACK_THROW_PG_VERSION = '8.23.0';
const execFileAsync = promisify(execFile);
const callbackThrowProbe = `
  import { createRequire } from 'node:module';
  import pg from 'pg';

  const [implementation, outcome, bridgeClientUrl, sessionLockUrl] = process.argv.slice(1);
  const pgVersion = createRequire(import.meta.url)('pg/package.json').version;
  const observed = [];
  let callbackArgs;
  let returnedUndefined = false;
  let close = async () => {};
  let resolveCallbackReached;
  const callbackReached = new Promise((resolve) => {
    resolveCallbackReached = resolve;
  });

  const message = (reason) => reason instanceof Error ? reason.message : String(reason);
  process.on('uncaughtException', (reason) => {
    observed.push({ channel: 'uncaughtException', message: message(reason) });
  });
  process.on('unhandledRejection', (reason) => {
    observed.push({ channel: 'unhandledRejection', message: message(reason) });
  });

  const callback = (err, res) => {
    callbackArgs = { hasError: err != null, hasResult: res != null };
    resolveCallbackReached();
    throw new Error('callback ' + outcome + ' boom');
  };
  const text = outcome === 'success' ? 'SELECT 1 AS one' : 'SELECT nope_column';

  if (implementation === 'stock') {
    const client = new pg.Client();
    returnedUndefined = client.query({ text, callback }) === undefined;
    const query = client._queryQueue[0];
    setImmediate(() => {
      if (outcome === 'success') query.handleReadyForQuery({});
      else query.handleError(new Error('query boom'), {});
    });
  } else {
    const [{ PGlite }, { PgBridgeClient }, { SessionLock }] = await Promise.all([
      import('@electric-sql/pglite'),
      import(bridgeClientUrl),
      import(sessionLockUrl),
    ]);
    const pglite = new PGlite();
    await pglite.waitReady;
    const pool = new pg.Pool({
      Client: PgBridgeClient,
      max: 1,
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: new SessionLock(),
        bridgeId: Symbol('callback-throw-probe'),
        syncToFs: false,
      },
    });
    const client = await pool.connect();
    close = async () => {
      client.release();
      await pool.end();
      await pglite.close();
    };
    returnedUndefined = client.query({ text, callback }) === undefined;
  }

  await Promise.race([
    callbackReached,
    new Promise((_, reject) => setTimeout(() => reject(new Error('callback probe timed out')), 5_000)),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 25));
  await close();
  console.log(JSON.stringify({
    implementation,
    outcome,
    pgVersion,
    returnedUndefined,
    callback: callbackArgs,
    observed,
  }));
`;

const runCallbackThrowProbe = async (
  implementation: CallbackThrowProbe['implementation'],
  outcome: CallbackThrowProbe['outcome'],
): Promise<CallbackThrowProbe> => {
  const bridgeClientUrl = new URL('./pg-bridge-client.ts', import.meta.url).href;
  const sessionLockUrl = new URL('../utils/session-lock.ts', import.meta.url).href;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      callbackThrowProbe,
      implementation,
      outcome,
      bridgeClientUrl,
      sessionLockUrl,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 },
  );
  try {
    return JSON.parse(stdout) as CallbackThrowProbe;
  } catch (cause) {
    const childDiagnostic = stderr.trim();
    throw new Error(
      `Callback throw probe returned invalid JSON${childDiagnostic === '' ? '' : `; child stderr: ${childDiagnostic}`}`,
      { cause },
    );
  }
};

describe(`callback-throw channel parity with pg@${CALLBACK_THROW_PG_VERSION}`, () => {
  const outcomes = ['success', 'error'] as const;

  it.each(outcomes)('pins stock pg asynchronous %s-callback throws', async (outcome) => {
    const stock = await runCallbackThrowProbe('stock', outcome);

    expect(stock).toMatchObject({
      implementation: 'stock',
      outcome,
      pgVersion: CALLBACK_THROW_PG_VERSION,
      returnedUndefined: true,
      callback: {
        hasError: outcome === 'error',
        hasResult: outcome === 'success',
      },
    });
    expect(stock.observed).toEqual([
      { channel: 'uncaughtException', message: `callback ${outcome} boom` },
    ]);
  });

  it.each(outcomes)('matches stock pg for asynchronous %s-callback throws', async (outcome) => {
    const [stock, bridge] = await Promise.all([
      runCallbackThrowProbe('stock', outcome),
      runCallbackThrowProbe('bridge', outcome),
    ]);

    expect(bridge).toMatchObject({
      implementation: 'bridge',
      outcome,
      pgVersion: CALLBACK_THROW_PG_VERSION,
      returnedUndefined: true,
      callback: stock.callback,
    });
    expect(bridge.observed).toEqual(stock.observed);
  });
});
