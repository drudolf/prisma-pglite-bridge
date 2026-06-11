import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockPGlite, createMockTelemetry } from '../__tests__/mocks.ts';
import { setupPGlite } from '../__tests__/pglite.ts';
import { PgBridgePool } from '../pool';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import { SessionLock } from '../utils/session-lock.ts';
import { PGliteDuplex } from './index.ts';

const pglite = await setupPGlite();
const PROTOCOL_CLEANUP_MESSAGE = Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]);
const RFQ_IDLE_MESSAGE = Buffer.from([0x5a, 0x00, 0x00, 0x00, 0x05, 0x49]);

const isProtocolCleanupMessage = (message: unknown): message is Uint8Array =>
  message instanceof Uint8Array && Buffer.from(message).equals(PROTOCOL_CLEANUP_MESSAGE);

beforeAll(async () => {
  await pglite.exec('CREATE TABLE IF NOT EXISTS conc_test (id serial PRIMARY KEY, val int)');
});
beforeEach(async () => {
  await pglite.exec('DROP TABLE IF EXISTS bridge_test CASCADE');
  await pglite.exec('DROP TABLE IF EXISTS shared_test CASCADE');
  await pglite.exec('TRUNCATE TABLE conc_test RESTART IDENTITY');
});

const createClient = (bridgeId?: symbol, telemetry?: TelemetrySink) =>
  new pg.Client({
    user: 'postgres',
    database: 'postgres',
    stream: () => new PGliteDuplex(pglite, { bridgeId, telemetry }),
  });

describe('PGliteDuplex', () => {
  it('pg.Client connects through the bridge', async () => {
    const client = createClient();
    await client.connect();
    await client.end();
  });

  it('executes a simple query', async () => {
    const client = createClient();
    await client.connect();
    const { rows } = await client.query('SELECT 1 + 1 AS result');
    expect(rows[0]?.result).toBe(2);
    await client.end();
  });

  it('keeps real PGlite usable after protocol cleanup clears parsed messages', async () => {
    const spy = vi.spyOn(pglite, 'execProtocolStream');
    const client = createClient();
    let connected = false;

    try {
      await client.connect();
      connected = true;

      for (let i = 0; i < 40; i++) {
        const { rows } = await client.query('SELECT $1::int AS n', [i]);
        expect(rows[0]?.n).toBe(i);
      }

      const cleanupCall = spy.mock.calls.find(([message]) => isProtocolCleanupMessage(message));
      expect(cleanupCall).toBeDefined();
      expect(cleanupCall?.[1]).toMatchObject({ syncToFs: false, throwOnError: false });

      const { rows } = await client.query('SELECT 42::int AS n');
      expect(rows[0]?.n).toBe(42);
    } finally {
      if (connected) {
        await client.end();
      }
      spy.mockRestore();
    }
  });

  it('executes parameterized queries', async () => {
    const client = createClient();
    await client.connect();
    const { rows } = await client.query('SELECT $1::int + $2::int AS result', [3, 4]);
    expect(rows[0]?.result).toBe(7);
    await client.end();
  });

  it('handles DDL and DML', async () => {
    const client = createClient();
    await client.connect();

    await client.query('CREATE TABLE IF NOT EXISTS bridge_test (id serial PRIMARY KEY, name text)');
    await client.query("INSERT INTO bridge_test (name) VALUES ('hello')");
    const { rows } = await client.query('SELECT name FROM bridge_test');
    expect(rows[0]?.name).toBe('hello');
    await client.query('DROP TABLE bridge_test');

    await client.end();
  });

  it('multiple sequential clients share the same PGlite', async () => {
    const c1 = createClient();
    await c1.connect();
    await c1.query('CREATE TABLE IF NOT EXISTS shared_test (id serial PRIMARY KEY, val int)');
    await c1.query('INSERT INTO shared_test (val) VALUES (42)');
    await c1.end();

    const c2 = createClient();
    await c2.connect();
    const { rows } = await c2.query('SELECT val FROM shared_test');
    expect(rows[0]?.val).toBe(42);
    await c2.query('DROP TABLE shared_test');
    await c2.end();
  });

  it('propagates SQL errors correctly', async () => {
    const client = createClient();
    await client.connect();
    await expect(client.query('SELECT * FROM nonexistent_table')).rejects.toThrow(/does not exist/);
    // Client should still be usable after error
    const { rows } = await client.query('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);
    await client.end();
  });

  it('handles EQP pipeline errors without telemetry enabled', async () => {
    const client = createClient();
    await client.connect();

    await expect(
      client.query('SELECT * FROM nonexistent_plain WHERE id = $1', [1]),
    ).rejects.toThrow(/does not exist/);

    await client.end();
  });

  it('socket-compat no-ops return the bridge instance', () => {
    const duplex = new PGliteDuplex(pglite);
    expect(duplex.setKeepAlive()).toBe(duplex);
    expect(duplex.setNoDelay()).toBe(duplex);
    expect(duplex.setTimeout()).toBe(duplex);
    expect(duplex.ref()).toBe(duplex);
    expect(duplex.unref()).toBe(duplex);
    expect(duplex.connect()).toBe(duplex);
    duplex.destroy();
  });
});

describe('PGliteDuplex concurrency', () => {
  it('concurrent parameterized queries through pool do not cause portal errors', async () => {
    const pool = new PgBridgePool({ max: 5, pglite });

    // Run 50 concurrent parameterized queries (EQP pipeline: P+B+D+E+S)
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => pool.query('SELECT $1::int AS val', [i])),
    );

    for (let i = 0; i < 50; i++) {
      expect(results[i]?.rows[0]?.val).toBe(i);
    }

    await pool.end();
  });

  it('concurrent inserts produce correct row counts', async () => {
    const pool = new PgBridgePool({ max: 3, pglite });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        pool.query('INSERT INTO conc_test (val) VALUES ($1)', [i]),
      ),
    );

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM conc_test');
    expect(rows[0]?.n).toBe(20);

    await pool.end();
  });
});

describe('PGliteDuplex error paths', () => {
  const startupBytes = (): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(8, 0);
    buf.writeUInt32BE(0x00030000, 4);
    return buf;
  };

  const simpleQuery = (sql: string): Buffer => {
    const payload = Buffer.from(`${sql}\0`);
    const len = 4 + payload.length;
    const buf = Buffer.alloc(1 + len);
    buf[0] = 0x51; // 'Q'
    buf.writeUInt32BE(len, 1);
    payload.copy(buf, 5);
    return buf;
  };

  const writeAndAwait = (duplex: PGliteDuplex, chunk: Buffer): Promise<Error | undefined> =>
    new Promise((resolve) => {
      duplex.write(chunk, (err) => resolve(err ?? undefined));
    });

  it('cleans protocol messages at the call threshold but not before', async () => {
    const execProtocolStream = vi.fn().mockResolvedValue([]);
    const pglite = createMockPGlite({ execProtocolStream });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    for (let i = 0; i < 30; i++) {
      await expect(writeAndAwait(duplex, simpleQuery(`SELECT ${i}`))).resolves.toBeUndefined();
    }
    expect(execProtocolStream).not.toHaveBeenCalled();

    await expect(writeAndAwait(duplex, simpleQuery('SELECT 31'))).resolves.toBeUndefined();

    const cleanupCall = execProtocolStream.mock.calls.find(([message]) =>
      isProtocolCleanupMessage(message),
    );
    expect(cleanupCall).toBeDefined();
    expect(cleanupCall?.[1]).toMatchObject({ syncToFs: false, throwOnError: false });
    expect(
      (duplex as unknown as { pendingProtocolCleanupCalls: number }).pendingProtocolCleanupCalls,
    ).toBe(0);

    duplex.destroy();
  });

  it('cleans protocol messages at the raw-byte threshold', async () => {
    const execProtocolStream = vi.fn().mockResolvedValue([]);
    const pglite = createMockPGlite({
      execProtocolRawStream: vi.fn(async (_message, options) => {
        options.onRawData(RFQ_IDLE_MESSAGE);
      }),
      execProtocolStream,
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    (duplex as unknown as { pendingProtocolCleanupBytes: number }).pendingProtocolCleanupBytes =
      8 * 1024 * 1024 - RFQ_IDLE_MESSAGE.byteLength;

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();

    const cleanupCall = execProtocolStream.mock.calls.find(([message]) =>
      isProtocolCleanupMessage(message),
    );
    expect(cleanupCall).toBeDefined();

    duplex.destroy();
  });

  it('attempts protocol cleanup after a raw stream failure', async () => {
    const execProtocolStream = vi.fn().mockResolvedValue([]);
    const streamError = new Error('raw stream failed');
    const pglite = createMockPGlite({
      execProtocolRawStream: vi.fn(async () => {
        throw streamError;
      }),
      execProtocolStream,
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBe(streamError);

    const cleanupCall = execProtocolStream.mock.calls.find(([message]) =>
      isProtocolCleanupMessage(message),
    );
    expect(cleanupCall).toBeDefined();

    duplex.destroy();
  });

  it('disables protocol cleanup after the cleanup frame is rejected', async () => {
    const execProtocolStream = vi.fn().mockRejectedValue(new Error('unsupported cleanup'));
    const pglite = createMockPGlite({ execProtocolStream });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const internals = duplex as unknown as {
      pendingProtocolCleanupCalls: number;
      protocolCleanupUnsupported: boolean;
    };
    internals.pendingProtocolCleanupCalls = 31;

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    expect(execProtocolStream).toHaveBeenCalledTimes(1);
    expect(internals.pendingProtocolCleanupCalls).toBe(0);
    expect(internals.protocolCleanupUnsupported).toBe(true);

    internals.pendingProtocolCleanupCalls = 31;
    await expect(writeAndAwait(duplex, simpleQuery('SELECT 1'))).resolves.toBeUndefined();
    expect(execProtocolStream).toHaveBeenCalledTimes(1);

    duplex.destroy();
  });

  it('disables protocol cleanup when execProtocolStream is missing', async () => {
    const pglite = createMockPGlite({ execProtocolStream: undefined });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const internals = duplex as unknown as {
      pendingProtocolCleanupCalls: number;
      protocolCleanupUnsupported: boolean;
    };
    internals.pendingProtocolCleanupCalls = 31;

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    expect(internals.protocolCleanupUnsupported).toBe(true);
    expect(internals.pendingProtocolCleanupCalls).toBe(0);

    duplex.destroy();
  });

  it('skips the cleanup frame once protocol cleanup is marked unsupported', async () => {
    const execProtocolStream = vi.fn().mockResolvedValue([]);
    const pglite = createMockPGlite({ execProtocolStream });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    // The threshold path in streamProtocol checks the same flag before
    // calling cleanup, so the method's own early return is only reachable
    // by invoking it directly.
    const internals = duplex as unknown as {
      protocolCleanupUnsupported: boolean;
      clearPGliteProtocolMessages: () => Promise<void>;
    };
    internals.protocolCleanupUnsupported = true;

    await internals.clearPGliteProtocolMessages();
    expect(execProtocolStream).not.toHaveBeenCalled();

    duplex.destroy();
  });

  it('fires pending write callbacks with the destroy error when torn down mid-drain', async () => {
    const pglite = createMockPGlite({
      runExclusive: vi.fn(() => new Promise<void>(() => {})),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const writeResult = writeAndAwait(duplex, startupBytes());
    await new Promise((resolve) => setImmediate(resolve));

    const destroyErr = new Error('bridge torn down');
    duplex.destroy(destroyErr);

    await expect(writeResult).resolves.toBe(destroyErr);
  });

  it('releases the session lock and surfaces the error when runExclusive throws', async () => {
    const pglite = createMockPGlite({
      runExclusive: vi.fn(async () => {
        throw new Error('pglite kaput');
      }),
    });
    const lock = new SessionLock();
    const releaseSpy = vi.spyOn(lock, 'release');
    const duplex = new PGliteDuplex(pglite, { sessionLock: lock });
    duplex.on('error', () => {});

    const err = await writeAndAwait(duplex, startupBytes());
    expect(err?.message).toBe('pglite kaput');
    expect(releaseSpy).toHaveBeenCalled();

    duplex.destroy();
  });

  it('records a failed query and rethrows when runExclusive throws after startup', async () => {
    let call = 0;
    const pglite = createMockPGlite({
      runExclusive: vi.fn(async (fn) => {
        call += 1;
        if (call === 1) {
          await fn();
          return;
        }
        throw new Error('query kaput');
      }),
    });

    const telemetry = createMockTelemetry();

    const duplex = new PGliteDuplex(pglite, { telemetry });
    duplex.on('error', () => {});

    const startupErr = await writeAndAwait(duplex, startupBytes());
    expect(startupErr).toBeUndefined();

    const queryErr = await writeAndAwait(duplex, simpleQuery('SELECT 1'));
    expect(queryErr?.message).toBe('query kaput');
    expect(telemetry.recordQuery).toHaveBeenCalledWith(expect.any(Number), false);

    duplex.destroy();
  });

  it('holds processing until a partial startup message completes', async () => {
    let runCalls = 0;
    const pglite = createMockPGlite({
      runExclusive: vi.fn(async (fn) => {
        runCalls += 1;
        await fn();
      }),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const firstHalf = startupBytes().subarray(0, 3);
    const secondHalf = startupBytes().subarray(3);

    const partialErr = await writeAndAwait(duplex, Buffer.from(firstHalf));
    expect(partialErr).toBeUndefined();
    expect(runCalls).toBe(0);

    const restErr = await writeAndAwait(duplex, Buffer.from(secondHalf));
    expect(restErr).toBeUndefined();
    expect(runCalls).toBe(1);

    duplex.destroy();
  });

  it('breaks out of processMessages on a malformed length header', async () => {
    const pglite = createMockPGlite();
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const startupErr = await writeAndAwait(duplex, startupBytes());
    expect(startupErr).toBeUndefined();

    const malformed = Buffer.from([0x51, 0x00, 0x00, 0x00, 0x03]);
    const err = await writeAndAwait(duplex, malformed);
    expect(err).toBeUndefined();

    duplex.destroy();
  });

  it('releases the session lock and ends the stream on TERMINATE', async () => {
    const pglite = createMockPGlite();
    const lock = new SessionLock();
    const releaseSpy = vi.spyOn(lock, 'release');
    const duplex = new PGliteDuplex(pglite, { sessionLock: lock });
    duplex.on('error', () => {});

    await writeAndAwait(duplex, startupBytes());
    releaseSpy.mockClear();

    const terminate = Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]);
    await writeAndAwait(duplex, terminate);

    expect(releaseSpy).toHaveBeenCalled();

    duplex.destroy();
  });

  it('wraps a non-Error throw into an Error when runExclusive rejects', async () => {
    const pglite = createMockPGlite({
      runExclusive: vi.fn(async () => {
        throw 'plain string boom';
      }),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const err = await writeAndAwait(duplex, startupBytes());
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('plain string boom');

    duplex.destroy();
  });

  it('surfaces the error when waitPGliteReady throws because pglite is closed', async () => {
    const pglite = createMockPGlite({ ready: false, closed: true });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const err = await writeAndAwait(duplex, startupBytes());
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('PGlite instance closed');

    duplex.destroy();
  });

  it('surfaces the error when pglite.waitReady rejects', async () => {
    const pglite = createMockPGlite({
      ready: false,
      closed: false,
      waitReady: Promise.reject(new Error('startup failed')),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const err = await writeAndAwait(duplex, startupBytes());
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('PGlite instance not ready: startup failed');

    duplex.destroy();
  });

  it('surfaces a stringified message when pglite.waitReady rejects with a non-Error', async () => {
    const pglite = createMockPGlite({
      ready: false,
      closed: false,
      waitReady: Promise.reject('plain string reason'),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const err = await writeAndAwait(duplex, startupBytes());
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('PGlite instance not ready: plain string reason');

    duplex.destroy();
  });

  it('surfaces the error when waitPGliteReady times out', async () => {
    const pglite = createMockPGlite({
      ready: false,
      closed: false,
      waitReady: new Promise<void>(() => {}), // never resolves
    });
    const TIMEOUT_MS = 5;
    const duplex = new PGliteDuplex(pglite, { timeout: TIMEOUT_MS });
    duplex.on('error', () => {});

    const err = await writeAndAwait(duplex, startupBytes());
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe(
      `PGlite instance not ready: Operation timed out after ${TIMEOUT_MS}ms`,
    );

    duplex.destroy();
  });

  it('surfaces the error when waitPGliteReady throws inside streamProtocol', async () => {
    // First waitPGliteReady (in runUnderRunExclusive) passes; runExclusive's
    // callback flips `closed` to true so the second waitPGliteReady (inside
    // streamProtocol) throws — exercises the second call site.
    let closed = false;
    const pglite = createMockPGlite({
      ready: false,
      waitReady: Promise.resolve(),
      runExclusive: vi.fn(async (fn) => {
        closed = true;
        await fn();
      }),
    });
    Object.defineProperty(pglite, 'closed', { get: () => closed, configurable: true });

    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const err = await writeAndAwait(duplex, startupBytes());
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('PGlite instance closed');

    duplex.destroy();
  });

  it('queues additional writes while a drain is already running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runCalls = 0;
    const pglite = createMockPGlite({
      runExclusive: vi.fn(async (fn) => {
        runCalls += 1;
        if (runCalls === 1) await gate;
        await fn();
      }),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    // Call _write directly twice in the same tick so the second one sees
    // `draining === true` (Node's Writable would otherwise serialize).
    type WriteInternal = (
      chunk: Buffer,
      enc: BufferEncoding,
      cb: (err?: Error | null) => void,
    ) => void;
    const rawWrite = (duplex as unknown as { _write: WriteInternal })._write.bind(duplex);

    let firstErr: Error | null | undefined;
    let secondErr: Error | null | undefined;
    const firstDone = new Promise<void>((resolve) => {
      rawWrite(startupBytes(), 'utf-8', (e) => {
        firstErr = e;
        resolve();
      });
    });
    const secondDone = new Promise<void>((resolve) => {
      rawWrite(simpleQuery('SELECT 1'), 'utf-8', (e) => {
        secondErr = e;
        resolve();
      });
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runCalls).toBe(1);

    release();

    await firstDone;
    await secondDone;
    expect(firstErr ?? undefined).toBeUndefined();
    expect(secondErr ?? undefined).toBeUndefined();
    expect(runCalls).toBe(2);

    duplex.destroy();
  });

  it('records a failed query when an EQP pipeline returns ErrorResponse', async () => {
    const telemetry = createMockTelemetry();

    const client = createClient(Symbol('bridge'), telemetry);
    await client.connect();

    await expect(client.query('SELECT * FROM nonexistent_eqp WHERE id = $1', [1])).rejects.toThrow(
      /does not exist/,
    );

    await client.end();

    const calls = vi.mocked(telemetry.recordQuery).mock.calls;
    expect(calls.some(([, succeeded]) => succeeded === false)).toBe(true);
  });

  it('destroy while waiting on the session lock does not poison the next bridge', async () => {
    const owner = Symbol('owner');
    const lock = new SessionLock();
    lock.updateStatus(owner, 0x54); // 'T'

    let destroyedBridgeRan = false;
    const blockedBridge = new PGliteDuplex(
      createMockPGlite({
        runExclusive: vi.fn(async (fn) => {
          destroyedBridgeRan = true;
          await fn();
        }),
      }),
      { sessionLock: lock },
    );
    blockedBridge.on('error', () => {});

    const blockedWrite = writeAndAwait(blockedBridge, startupBytes());
    await new Promise((resolve) => setImmediate(resolve));

    const destroyErr = new Error('gone');
    blockedBridge.destroy(destroyErr);
    await expect(blockedWrite).resolves.toBe(destroyErr);

    lock.release(owner);
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyedBridgeRan).toBe(false);

    let nextBridgeRan = false;
    const nextBridge = new PGliteDuplex(
      createMockPGlite({
        runExclusive: vi.fn(async (fn) => {
          nextBridgeRan = true;
          await fn();
        }),
      }),
      { sessionLock: lock },
    );
    nextBridge.on('error', () => {});

    await expect(writeAndAwait(nextBridge, startupBytes())).resolves.toBeUndefined();
    expect(nextBridgeRan).toBe(true);

    nextBridge.destroy();
  });

  it('skips a queued runExclusive callback when destroyed before it fires', async () => {
    // Race: pglite.runExclusive enqueues our callback, _destroy then flips
    // tornDown before the callback fires. Without the inner guard the queued
    // op would still execute and leak BEGIN state into the next duplex.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let execCalled = false;
    const pglite = createMockPGlite({
      runExclusive: vi.fn(async (fn) => {
        await gate;
        await fn();
      }),
      execProtocolRawStream: vi.fn(async () => {
        execCalled = true;
      }),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    const writeP = writeAndAwait(duplex, startupBytes());
    await new Promise((resolve) => setImmediate(resolve));

    const destroyErr = new Error('forced destroy');
    duplex.destroy(destroyErr);
    await expect(writeP).resolves.toBe(destroyErr);

    release();
    await new Promise((resolve) => setImmediate(resolve));

    expect(execCalled).toBe(false);
  });

  it('does not block stream teardown on a queued runExclusive callback', async () => {
    // pglite.runExclusive may have accepted our callback but not fired it yet
    // (other queries ahead in PGlite's queue). _destroy must not block on the
    // queued no-op — close needs to proceed promptly so SessionLock waiters
    // and the surrounding server can move on.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pglite = createMockPGlite({
      runExclusive: vi.fn(async (fn) => {
        await gate;
        await fn();
      }),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    void writeAndAwait(duplex, startupBytes());
    await new Promise((resolve) => setImmediate(resolve));

    const closed = new Promise<void>((resolve) => duplex.once('close', resolve));
    duplex.destroy(new Error('forced'));

    // close must fire without us touching `release`. If _destroy awaited the
    // queued callback, this would only resolve once the gate was released.
    await Promise.race([
      closed,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('teardown blocked on queued runExclusive')), 200),
      ),
    ]);

    release();
  });

  it('issues only one ROLLBACK across concurrent _final / _destroy calls', async () => {
    // _final and _destroy can both reach rollbackIfInTransaction nearly at
    // once when a client disconnects mid-transaction. Memoization keeps it to
    // a single ROLLBACK; without it PGlite would see two and reject the second.
    const queryCalls: string[] = [];
    const mock = {
      runExclusive: async (fn: () => Promise<unknown>) => {
        await fn();
      },
      execProtocolRawStream: async () => {},
      query: async (sql: string) => {
        queryCalls.push(sql);
        return { rows: [] };
      },
    } as unknown as PGlite;
    const duplex = new PGliteDuplex(mock);
    duplex.on('error', () => {});

    // Force the duplex into 'T' state — the wire path would normally set this
    // via the framer's onReadyForQuery, but the mock execProtocolRawStream
    // emits no bytes.
    (duplex as unknown as { lastSeenRfqStatus: number }).lastSeenRfqStatus = 0x54;

    await Promise.all([
      duplex.rollbackIfInTransaction(),
      duplex.rollbackIfInTransaction(),
      duplex.rollbackIfInTransaction(),
    ]);

    expect(queryCalls.filter((sql) => sql === 'ROLLBACK').length).toBe(1);

    duplex.destroy();
  });
});

describe('PGliteDuplex RowDescription rewrite option', () => {
  const startupBytes = (): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(8, 0);
    buf.writeUInt32BE(0x00030000, 4);
    return buf;
  };

  const writeAndAwait = (duplex: PGliteDuplex, chunk: Buffer): Promise<Error | undefined> =>
    new Promise((resolve) => {
      duplex.write(chunk, (err) => resolve(err ?? undefined));
    });

  // RowDescription ('T') with a single pg_class.relkind field — tableOID 1259
  // (system catalog), dataTypeOID 18 ("char"), size 1. The 18→25 rewrite
  // targets exactly this shape.
  const FIELD_NAME = 'relkind';
  const OID_OFFSET = 1 + 4 + 2 + FIELD_NAME.length + 1 + 4 + 2;
  const catalogCharRowDescription = (): Buffer => {
    const name = Buffer.from(`${FIELD_NAME}\0`);
    const payload = Buffer.alloc(2 + name.length + 18);
    payload.writeInt16BE(1, 0); // field count
    name.copy(payload, 2);
    let p = 2 + name.length;
    payload.writeUInt32BE(1259, p); // pg_class — system catalog table oid
    p += 4;
    payload.writeInt16BE(1, p); // column attribute number
    p += 2;
    payload.writeUInt32BE(18, p); // "char"
    p += 4;
    payload.writeInt16BE(1, p); // dataTypeSize
    p += 2;
    payload.writeInt32BE(-1, p); // typeModifier
    p += 4;
    payload.writeInt16BE(0, p); // formatCode
    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 0x54; // 'T'
    frame.writeUInt32BE(4 + payload.length, 1);
    payload.copy(frame, 5);
    return frame;
  };

  const createRowDescriptionPGlite = (frame: Buffer) =>
    createMockPGlite({
      execProtocolRawStream: vi.fn(async (_message, options) => {
        options.onRawData(frame);
        options.onRawData(RFQ_IDLE_MESSAGE);
      }),
    });

  it('pushes a system-catalog char RowDescription with oid 18 intact when the rewrite is disabled', async () => {
    const frame = catalogCharRowDescription();
    const duplex = new PGliteDuplex(createRowDescriptionPGlite(frame), {
      rewriteSystemCatalogCharOids: false,
    });
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();

    const emitted: Buffer = duplex.read() ?? Buffer.alloc(0);
    expect(emitted.length).toBe(frame.length + RFQ_IDLE_MESSAGE.length);
    expect(emitted.subarray(0, frame.length).equals(frame)).toBe(true);
    expect(emitted.readUInt32BE(OID_OFFSET)).toBe(18);

    duplex.destroy();
  });

  it('rewrites a system-catalog char RowDescription to oid 25 by default', async () => {
    const frame = catalogCharRowDescription();
    const duplex = new PGliteDuplex(createRowDescriptionPGlite(frame));
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();

    const emitted: Buffer = duplex.read() ?? Buffer.alloc(0);
    expect(emitted.length).toBe(frame.length + RFQ_IDLE_MESSAGE.length);
    expect(emitted.readUInt32BE(OID_OFFSET)).toBe(25);
    expect(emitted.readInt16BE(OID_OFFSET + 4)).toBe(-1);

    duplex.destroy();
  });
});
