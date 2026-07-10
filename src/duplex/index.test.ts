import { PGlite } from '@electric-sql/pglite';
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

  it('skips protocol cleanup when the runtime PGlite does not accumulate raw-stream results', async () => {
    const execProtocolStream = vi.fn().mockResolvedValue([]);
    const pglite = createMockPGlite({ execProtocolStream });
    const duplex = new PGliteDuplex(pglite, { protocolCleanupNeeded: false });
    duplex.on('error', () => {});

    const internals = duplex as unknown as { pendingProtocolCleanupCalls: number };
    internals.pendingProtocolCleanupCalls = 31; // one more call would hit the threshold

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
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

  it('recovers on the next protocol call after a framing error in the previous response', async () => {
    // Regression guard for the single-reused-framer refactor: a protocol call
    // whose response bytes throw mid-frame must not poison the next call.
    // This passes TODAY because streamProtocol builds a fresh
    // BackendMessageFramer per call; once the duplex reuses one framer,
    // reset() at the start of each call must preserve this behavior.
    let calls = 0;
    const pglite = createMockPGlite({
      execProtocolRawStream: vi.fn(async (_message, options) => {
        calls += 1;
        if (calls === 1) {
          // Deliver the type byte alone so the framer enters mid-message
          // state, then a malformed length header (< 4) that makes it throw.
          options.onRawData(Buffer.from([0x44]));
          options.onRawData(Buffer.from([0x00, 0x00, 0x00, 0x03]));
          return;
        }
        options.onRawData(RFQ_IDLE_MESSAGE);
      }),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    // duplex.write() auto-destroys the stream once a write callback errors,
    // so drive _write directly (same pattern as the drain-queueing test
    // above) to observe the duplex's own per-call isolation.
    const rawWriteAndAwait = (chunk: Buffer): Promise<Error | undefined> =>
      new Promise((resolve) => {
        duplex._write(chunk, 'utf-8', (err) => resolve(err ?? undefined));
      });

    const firstErr = await rawWriteAndAwait(startupBytes());
    expect(firstErr?.message).toMatch(/Malformed backend message length: 3/);

    // The first startup message was consumed but the error kept the phase at
    // pre_startup, so a second startup write is the next protocol call.
    const secondErr = await rawWriteAndAwait(startupBytes());
    expect(secondErr).toBeUndefined();

    const emitted: Buffer = duplex.read() ?? Buffer.alloc(0);
    expect(emitted.equals(RFQ_IDLE_MESSAGE)).toBe(true);

    duplex.destroy();
  });

  it('drops onRawData invocations that arrive outside an active protocol call', async () => {
    // PGlite retains the onRawData callback internally after
    // execProtocolRawStream resolves. Once the duplex passes a single
    // long-lived callback, bytes delivered outside an active protocol call
    // must be dropped instead of reaching the framer. Red today: the stale
    // per-call callback still forwards such bytes to its old framer, which
    // pushes them into the stream.
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const commandComplete = (tag: string): Buffer => {
      const payload = Buffer.from(`${tag}\0`);
      const buf = Buffer.alloc(5 + payload.length);
      buf[0] = 0x43; // 'C'
      buf.writeUInt32BE(4 + payload.length, 1);
      payload.copy(buf, 5);
      return buf;
    };

    let capturedOnRawData: ((chunk: Uint8Array) => void) | undefined;
    const pglite = createMockPGlite({
      execProtocolRawStream: vi.fn(async (_message, options) => {
        capturedOnRawData = options.onRawData;
        options.onRawData(RFQ_IDLE_MESSAGE);
      }),
    });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received: Buffer[] = [];
    duplex.on('data', (chunk: Buffer) => received.push(chunk));

    // Get past startup so later writes exercise the regular message path.
    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const afterStartup = Buffer.concat(received);
    expect(afterStartup.equals(RFQ_IDLE_MESSAGE)).toBe(true);
    expect(capturedOnRawData).toBeDefined();

    // Stale delivery outside any active call: a well-formed CommandComplete
    // must NOT surface as 'data' on the duplex.
    capturedOnRawData?.(commandComplete('SELECT 1'));
    await settle();
    await settle();
    expect(Buffer.concat(received).equals(afterStartup)).toBe(true);

    // The duplex still round-trips a regular protocol call afterwards.
    await expect(writeAndAwait(duplex, simpleQuery('SELECT 1'))).resolves.toBeUndefined();
    await settle();
    const afterQuery = Buffer.concat(received);
    expect(afterQuery.length).toBe(afterStartup.length + RFQ_IDLE_MESSAGE.length);
    expect(afterQuery.subarray(afterStartup.length).equals(RFQ_IDLE_MESSAGE)).toBe(true);

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

describe('PGliteDuplex flush portal boundary', () => {
  // Frontend message type bytes
  const PARSE = 0x50; // 'P'
  const BIND = 0x42; // 'B'
  const DESCRIBE_MSG = 0x44; // 'D'
  const EXECUTE = 0x45; // 'E'
  const FLUSH = 0x48; // 'H'
  const SYNC = 0x53; // 'S'

  const RFQ_IN_TRANSACTION_MESSAGE = Buffer.from([0x5a, 0x00, 0x00, 0x00, 0x05, 0x54]);

  // Minimal wire frame: type byte + 4-byte big-endian length including itself.
  const frame = (type: number): Buffer => {
    const buf = Buffer.alloc(5);
    buf[0] = type;
    buf.writeUInt32BE(4, 1);
    return buf;
  };

  // Backend frames — payload-free minimal shapes; the framer only needs headers.
  const DATA_ROW_MESSAGE = frame(0x44); // 'D'
  const PORTAL_SUSPENDED_MESSAGE = frame(0x73); // 's'
  const ERROR_RESPONSE_MESSAGE = frame(0x45); // 'E'

  const flushBatch = (): Buffer =>
    Buffer.concat([frame(PARSE), frame(BIND), frame(DESCRIBE_MSG), frame(EXECUTE), frame(FLUSH)]);
  const continuationBatch = (): Buffer => Buffer.concat([frame(EXECUTE), frame(FLUSH)]);
  const syncBatch = (): Buffer =>
    Buffer.concat([frame(PARSE), frame(BIND), frame(DESCRIBE_MSG), frame(EXECUTE), frame(SYNC)]);

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

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const writeAndAwait = (duplex: PGliteDuplex, chunk: Buffer): Promise<Error | undefined> =>
    new Promise((resolve) => {
      duplex.write(chunk, (err) => resolve(err ?? undefined));
    });

  /** Mock pglite whose execProtocolRawStream emits the scripted frames on
   *  each successive call (call 0 is the startup message). */
  const createScriptedPGlite = (
    responses: Buffer[][],
    overrides: Parameters<typeof createMockPGlite>[0] = {},
  ) => {
    let call = 0;
    const execProtocolRawStream = vi.fn(async (_message, options) => {
      const frames = responses[call] ?? [];
      call += 1;
      for (const f of frames) {
        options.onRawData(f);
      }
    });
    return {
      pglite: createMockPGlite({ ...overrides, execProtocolRawStream }),
      execProtocolRawStream,
    };
  };

  const collect = (duplex: PGliteDuplex): Buffer[] => {
    const received: Buffer[] = [];
    duplex.on('data', (chunk: Buffer) => received.push(chunk));
    return received;
  };

  it('streams a Flush-terminated pipeline immediately without waiting for Sync', {
    timeout: 1000,
  }, async () => {
    const { pglite, execProtocolRawStream } = createScriptedPGlite([[RFQ_IDLE_MESSAGE], []]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();

    const batch = flushBatch();
    await expect(writeAndAwait(duplex, batch)).resolves.toBeUndefined();

    // Red today: P,B,D,E,H sit in the pipeline until Sync — the batch call
    // never happens and pg deadlocks waiting on the Flush response.
    expect(execProtocolRawStream).toHaveBeenCalledTimes(2);
    const batchCall = execProtocolRawStream.mock.calls[1];
    expect(Buffer.from(batchCall?.[0] ?? []).equals(batch)).toBe(true);

    duplex.destroy();
  });

  it('drops the trailing ReadyForQuery of a successful flush-boundary batch', async () => {
    const { pglite } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [DATA_ROW_MESSAGE, PORTAL_SUSPENDED_MESSAGE, RFQ_IDLE_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const startupLen = Buffer.concat(received).length;

    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();
    await settle();

    const batchResponse = Buffer.concat(received).subarray(startupLen);
    expect(batchResponse.equals(Buffer.concat([DATA_ROW_MESSAGE, PORTAL_SUSPENDED_MESSAGE]))).toBe(
      true,
    );

    duplex.destroy();
  });

  it('passes a success flush batch without RFQ through unchanged (real PGlite shape)', async () => {
    const { pglite } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [DATA_ROW_MESSAGE, DATA_ROW_MESSAGE, PORTAL_SUSPENDED_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const startupLen = Buffer.concat(received).length;

    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();
    await settle();

    const batchResponse = Buffer.concat(received).subarray(startupLen);
    expect(
      batchResponse.equals(
        Buffer.concat([DATA_ROW_MESSAGE, DATA_ROW_MESSAGE, PORTAL_SUSPENDED_MESSAGE]),
      ),
    ).toBe(true);

    duplex.destroy();
  });

  it('delivers both ErrorResponse and the trailing RFQ of an error flush batch', async () => {
    const { pglite, execProtocolRawStream } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [ERROR_RESPONSE_MESSAGE, RFQ_IDLE_MESSAGE],
      [RFQ_IDLE_MESSAGE], // recovery Sync response — dropped by the bridge
    ]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const startupLen = Buffer.concat(received).length;

    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();
    await settle();

    // pg never sends a recovery Sync in rows-mode — withholding this RFQ
    // would wedge the connection.
    const batchResponse = Buffer.concat(received).subarray(startupLen);
    expect(batchResponse.equals(Buffer.concat([ERROR_RESPONSE_MESSAGE, RFQ_IDLE_MESSAGE]))).toBe(
      true,
    );

    // The backend enters ignore-till-sync on error; the bridge must issue a
    // recovery Sync itself (stock pg never does in rows-mode). Its response
    // was dropped — asserted by the byte-equality above.
    expect(execProtocolRawStream).toHaveBeenCalledTimes(3);
    const recoveryFrame = execProtocolRawStream.mock.calls[2]?.[0] as Uint8Array;
    expect(Buffer.from(recoveryFrame).equals(Buffer.from([0x53, 0x00, 0x00, 0x00, 0x04]))).toBe(
      true,
    );

    duplex.destroy();
  });

  it('tears the stream down when the recovery Sync itself fails', async () => {
    let call = 0;
    const execProtocolRawStream = vi.fn(
      async (_message: Uint8Array, options: { onRawData: (chunk: Uint8Array) => void }) => {
        call += 1;
        if (call === 1) {
          options.onRawData(RFQ_IDLE_MESSAGE);
          return;
        }
        if (call === 2) {
          options.onRawData(ERROR_RESPONSE_MESSAGE);
          options.onRawData(RFQ_IDLE_MESSAGE);
          return;
        }
        throw new Error('recovery failed');
      },
    );
    const pglite = createMockPGlite({ execProtocolRawStream });
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const startupLen = Buffer.concat(received).length;

    // pg already received the error RFQ and considers the connection
    // recovered; an unrecoverable backend would silently ignore every later
    // query. The duplex must destroy itself so pg surfaces a connection
    // error instead.
    const writeError = await writeAndAwait(duplex, flushBatch());
    expect(writeError).toBeInstanceOf(Error);
    await duplex.onClose;

    const batchResponse = Buffer.concat(received).subarray(startupLen);
    expect(batchResponse.equals(Buffer.concat([ERROR_RESPONSE_MESSAGE, RFQ_IDLE_MESSAGE]))).toBe(
      true,
    );
    expect(execProtocolRawStream).toHaveBeenCalledTimes(3);
    expect(duplex.destroyed).toBe(true);
  });

  it('does not leak a stale error into the next flush-boundary batch (errSeen reset)', async () => {
    const { pglite } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [ERROR_RESPONSE_MESSAGE, RFQ_IDLE_MESSAGE],
      [RFQ_IDLE_MESSAGE], // recovery Sync response — dropped by the bridge
      [DATA_ROW_MESSAGE, RFQ_IDLE_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();
    await settle();
    const afterErrorLen = Buffer.concat(received).length;

    // The second flush-boundary call succeeds — its trailing RFQ must be
    // dropped even though the previous call saw an ErrorResponse.
    await expect(writeAndAwait(duplex, continuationBatch())).resolves.toBeUndefined();
    await settle();

    const secondResponse = Buffer.concat(received).subarray(afterErrorLen);
    expect(secondResponse.equals(DATA_ROW_MESSAGE)).toBe(true);

    duplex.destroy();
  });

  it('streams a standalone Flush with an empty pipeline as a one-message batch', async () => {
    const { pglite, execProtocolRawStream } = createScriptedPGlite([[RFQ_IDLE_MESSAGE], []]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();

    const standaloneFlush = frame(FLUSH);
    await expect(writeAndAwait(duplex, standaloneFlush)).resolves.toBeUndefined();

    expect(execProtocolRawStream).toHaveBeenCalledTimes(2);
    const flushCall = execProtocolRawStream.mock.calls[1];
    expect(Buffer.from(flushCall?.[0] ?? []).equals(standaloneFlush)).toBe(true);

    duplex.destroy();
  });

  it('still suppresses intermediate RFQs on a Sync batch, emitting only the final one', async () => {
    const { pglite } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [RFQ_IDLE_MESSAGE, DATA_ROW_MESSAGE, RFQ_IDLE_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const startupLen = Buffer.concat(received).length;

    await expect(writeAndAwait(duplex, syncBatch())).resolves.toBeUndefined();
    await settle();

    const batchResponse = Buffer.concat(received).subarray(startupLen);
    expect(batchResponse.equals(Buffer.concat([DATA_ROW_MESSAGE, RFQ_IDLE_MESSAGE]))).toBe(true);

    duplex.destroy();
  });

  it('holds the session lock after a successful flush-boundary batch until a real idle RFQ', async () => {
    const lock = new SessionLock();
    const { pglite } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [DATA_ROW_MESSAGE, PORTAL_SUSPENDED_MESSAGE],
      [RFQ_IDLE_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite, { sessionLock: lock });
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();

    // The suspended unnamed portal must be protected between flush batches:
    // another bridge's acquire() has to queue behind the hold.
    const other = Symbol('other-bridge');
    let otherResolved = false;
    void lock.acquire(other).then(() => {
      otherResolved = true;
    });
    await settle();
    expect(otherResolved).toBe(false);

    // The next real RFQ with status 'I' (from Sync) releases the hold via
    // the existing updateStatus path and grants the waiter.
    await expect(writeAndAwait(duplex, frame(SYNC))).resolves.toBeUndefined();
    await settle();
    expect(otherResolved).toBe(true);

    duplex.destroy();
  });

  it('releases the portal hold when an error flush batch arrives without an RFQ', async () => {
    const lock = new SessionLock();
    const { pglite } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [DATA_ROW_MESSAGE, PORTAL_SUSPENDED_MESSAGE],
      [ERROR_RESPONSE_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite, { sessionLock: lock });
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();

    const other = Symbol('other-bridge');
    let otherResolved = false;
    void lock.acquire(other).then(() => {
      otherResolved = true;
    });
    await settle();
    expect(otherResolved).toBe(false);

    // Mock-only shape (no observed PGlite emits it): error with no RFQ in
    // the same call. Outside a real transaction (last RFQ status was 'I'),
    // the duplex must drop its hold so waiters aren't stuck behind a
    // wedged connection.
    await expect(writeAndAwait(duplex, continuationBatch())).resolves.toBeUndefined();
    await settle();
    expect(otherResolved).toBe(true);

    duplex.destroy();
  });

  it('keeps transaction ownership when a flush batch errors without RFQ mid-transaction', async () => {
    const lock = new SessionLock();
    const { pglite } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [RFQ_IN_TRANSACTION_MESSAGE],
      [ERROR_RESPONSE_MESSAGE], // mock-only: error with no RFQ in the call
      [RFQ_IDLE_MESSAGE], // recovery Sync response — dropped by the bridge
    ]);
    const duplex = new PGliteDuplex(pglite, { sessionLock: lock });
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(writeAndAwait(duplex, simpleQuery('BEGIN'))).resolves.toBeUndefined();

    const other = Symbol('other-bridge');
    let otherResolved = false;
    void lock.acquire(other).then(() => {
      otherResolved = true;
    });

    // Errored flush batch without RFQ inside an open transaction: the
    // wedged-portal release guard must NOT strip transaction ownership —
    // the transaction still needs its COMMIT/ROLLBACK.
    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();
    await settle();
    expect(otherResolved).toBe(false);

    duplex.destroy();
    await duplex.onClose;
  });

  it('releaseAbandonedPortalHold drops a portal hold outside a transaction', async () => {
    const lock = new SessionLock();
    const { pglite } = createScriptedPGlite([
      [RFQ_IDLE_MESSAGE],
      [DATA_ROW_MESSAGE, PORTAL_SUSPENDED_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite, { sessionLock: lock });
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();

    const other = Symbol('other-bridge');
    let otherResolved = false;
    void lock.acquire(other).then(() => {
      otherResolved = true;
    });
    await settle();
    expect(otherResolved).toBe(false);

    // The pool calls this when the client is released with the cursor
    // still open — no Sync is coming, so the hold must be dropped here.
    duplex.releaseAbandonedPortalHold();
    await settle();
    expect(otherResolved).toBe(true);

    duplex.destroy();
  });

  it('releaseAbandonedPortalHold keeps ownership inside an open transaction', async () => {
    const lock = new SessionLock();
    const { pglite } = createScriptedPGlite([[RFQ_IDLE_MESSAGE], [RFQ_IN_TRANSACTION_MESSAGE]]);
    const duplex = new PGliteDuplex(pglite, { sessionLock: lock });
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(writeAndAwait(duplex, simpleQuery('BEGIN'))).resolves.toBeUndefined();

    // Transaction ownership is not a portal hold — releasing a client
    // mid-transaction must not hand the session to another bridge before
    // the teardown ROLLBACK runs.
    duplex.releaseAbandonedPortalHold();

    const other = Symbol('other-bridge');
    let otherResolved = false;
    void lock.acquire(other).then(() => {
      otherResolved = true;
    });
    await settle();
    expect(otherResolved).toBe(false);

    duplex.destroy();
    await duplex.onClose;
  });

  it('issues ROLLBACK on teardown after flush-boundary batches inside a transaction', async () => {
    const queryCalls: string[] = [];
    const { pglite } = createScriptedPGlite(
      [
        [RFQ_IDLE_MESSAGE],
        [RFQ_IN_TRANSACTION_MESSAGE],
        [DATA_ROW_MESSAGE, PORTAL_SUSPENDED_MESSAGE],
      ],
      {
        query: vi.fn(async (sql: string) => {
          queryCalls.push(sql);
          return { rows: [] };
        }),
      },
    );
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(writeAndAwait(duplex, simpleQuery('BEGIN'))).resolves.toBeUndefined();
    // Flush batches carry no RFQ mid-transaction — lastSeenRfqStatus must
    // stay at the BEGIN's 'T' so teardown still rolls back.
    await expect(writeAndAwait(duplex, flushBatch())).resolves.toBeUndefined();

    duplex.destroy();
    await duplex.onClose;

    expect(queryCalls).toContain('ROLLBACK');
  });
});

describe('PGliteDuplex malformed frontend message lengths', () => {
  // Frontend message type bytes
  const QUERY = 0x51; // 'Q'
  const SYNC = 0x53; // 'S'

  // Above the 1 GiB sanity cap. Declared lengths are read unsigned, so even
  // high-bit values (≥ 2 GiB) stay positive and belong to the cap branch —
  // pinned by the 0x8000_0000 tests below — never to the malformed-length
  // (negative) case.
  const OVERSIZED_LENGTH = 1_100_000_000;

  const startupBytes = (): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(8, 0);
    buf.writeUInt32BE(0x00030000, 4);
    return buf;
  };

  /** Post-startup frame: [type byte][4-byte BE declared length incl. itself]. */
  const frameWithDeclaredLength = (type: number, declaredLength: number): Buffer => {
    const buf = Buffer.alloc(5);
    buf[0] = type;
    // Unsigned write: identical bytes for the existing sub-2 GiB values,
    // and it permits high-bit declared lengths without a RangeError.
    buf.writeUInt32BE(declaredLength, 1);
    return buf;
  };

  /** Startup frame header: [4-byte BE declared length incl. itself] — no type byte. */
  const startupWithDeclaredLength = (declaredLength: number): Buffer => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(declaredLength, 0);
    return buf;
  };

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const writeAndAwait = (duplex: PGliteDuplex, chunk: Buffer): Promise<Error | undefined> =>
    new Promise((resolve) => {
      duplex.write(chunk, (err) => resolve(err ?? undefined));
    });

  /** Duplex past a completed startup, so writes hit processMessages. */
  const createReadyDuplex = async (): Promise<PGliteDuplex> => {
    const duplex = new PGliteDuplex(createMockPGlite());
    duplex.on('error', () => {});
    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    return duplex;
  };

  it('fails the write when a post-startup frame declares a length below the 5-byte minimum', async () => {
    const duplex = await createReadyDuplex();

    // 'Q' with declared length 3 — cannot even cover its own 4 length bytes.
    // Today the duplex treats this as "incomplete, wait for more data": the
    // callback resolves null and the poisoned bytes buffer forever.
    const err = await writeAndAwait(duplex, frameWithDeclaredLength(QUERY, 3));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/Malformed frontend message length/);

    duplex.destroy();
  });

  it('fails the write when a post-startup frame declares a length above the 1 GiB sanity cap', async () => {
    const duplex = await createReadyDuplex();

    // Today the duplex "waits" for a gigabyte that never arrives, buffering
    // unboundedly while every write callback reports success.
    const err = await writeAndAwait(duplex, frameWithDeclaredLength(QUERY, OVERSIZED_LENGTH));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/exceeds sanity cap/);

    duplex.destroy();
  });

  it('fails the write when a post-startup frame declares a high-bit length (2 GiB, read unsigned)', async () => {
    const duplex = await createReadyDuplex();

    // 0x8000_0000 arrives as 2 147 483 648 through the unsigned length
    // reader — far above the sanity cap. It must never read negative into
    // the malformed-length branch.
    const err = await writeAndAwait(duplex, frameWithDeclaredLength(QUERY, 0x80_00_00_00));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/exceeds sanity cap/);

    duplex.destroy();
  });

  it('destroys the duplex after a malformed length error so subsequent writes fail', async () => {
    const duplex = await createReadyDuplex();

    const err = await writeAndAwait(duplex, frameWithDeclaredLength(QUERY, 3));
    expect(err).toBeInstanceOf(Error);

    // duplex.write() auto-destroys the stream once a write callback errors —
    // pin that the poisoned duplex cannot accept further traffic.
    await settle();
    expect(duplex.destroyed).toBe(true);

    // A well-formed Sync frame, so the failure is the destroyed stream — not
    // re-detection of the malformed bytes.
    const followUpErr = await writeAndAwait(duplex, frameWithDeclaredLength(SYNC, 4));
    expect(followUpErr).toBeInstanceOf(Error);
  });

  it('fails the write when the startup frame declares a length below the 8-byte SSL-probe minimum', async () => {
    const duplex = new PGliteDuplex(createMockPGlite());
    duplex.on('error', () => {});

    // Declared length 4 covers only the length field itself — below the
    // 8-byte SSL probe, the smallest valid pre-startup frame. Today this is
    // consumed as an empty-payload startup message and the phase flips to
    // 'ready', reinterpreting whatever follows as regular messages.
    const err = await writeAndAwait(duplex, startupWithDeclaredLength(4));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/Malformed startup message length/);

    duplex.destroy();
  });

  it('fails the write when the startup frame declares a length above the 1 GiB sanity cap', async () => {
    const duplex = new PGliteDuplex(createMockPGlite());
    duplex.on('error', () => {});

    // Today the pre-startup framer stalls buffering toward a length no sane
    // startup message reaches, with success write callbacks throughout.
    const err = await writeAndAwait(duplex, startupWithDeclaredLength(OVERSIZED_LENGTH));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/exceeds sanity cap/);

    duplex.destroy();
  });

  it('fails the write when the startup frame declares a high-bit length (2 GiB, read unsigned)', async () => {
    const duplex = new PGliteDuplex(createMockPGlite());
    duplex.on('error', () => {});

    // Same unsigned-read contract as the post-startup framer: 2 GiB lands
    // in the sanity-cap branch, not the malformed (< 8) branch.
    const err = await writeAndAwait(duplex, startupWithDeclaredLength(0x80_00_00_00));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/exceeds sanity cap/);

    duplex.destroy();
  });

  it('waits for more bytes when a startup frame is merely incomplete', async () => {
    const duplex = new PGliteDuplex(createMockPGlite());
    duplex.on('error', () => {});

    // Only the length field of a valid 8-byte startup — wait, don't throw.
    await expect(writeAndAwait(duplex, startupWithDeclaredLength(8))).resolves.toBeUndefined();

    // The remaining protocol-version bytes complete the startup.
    const rest = Buffer.alloc(4);
    rest.writeUInt32BE(0x00030000, 0);
    await expect(writeAndAwait(duplex, rest)).resolves.toBeUndefined();

    duplex.destroy();
  });

  it('waits for more bytes when a post-startup frame is merely incomplete', async () => {
    const duplex = await createReadyDuplex();

    // 'Q' declaring 10 bytes with only the 5-byte header present — wait.
    await expect(
      writeAndAwait(duplex, frameWithDeclaredLength(QUERY, 10)),
    ).resolves.toBeUndefined();

    // The remaining 6 payload bytes complete the frame.
    await expect(writeAndAwait(duplex, Buffer.from('sel;;\0'))).resolves.toBeUndefined();

    duplex.destroy();
  });
});

describe('PGliteDuplex COPY FROM STDIN capture (raw frames)', () => {
  // Frontend message type bytes for the copy conversation.
  const QUERY = 0x51; // 'Q'
  const COPY_DATA = 0x64; // 'd'
  const COPY_DONE = 0x63; // 'c'
  const COPY_FAIL = 0x66; // 'f'
  const SYNC = 0x53; // 'S'

  // Backend message type bytes the capture path synthesizes or forwards.
  const COPY_IN_RESPONSE = 0x47; // 'G'
  const COMMAND_COMPLETE = 0x43; // 'C'
  const ERROR_RESPONSE = 0x45; // 'E'
  const READY_FOR_QUERY = 0x5a; // 'Z'

  const RFQ_IN_TRANSACTION_MESSAGE = Buffer.from([0x5a, 0x00, 0x00, 0x00, 0x05, 0x54]);

  // Real-PGlite tests boot a dedicated instance per test: today the duplex
  // forwards COPY ... FROM STDIN and the backend dies (WASM exit(1)) — a
  // shared instance would poison every later test in this file. Sized for
  // the per-test cold boot under coverage instrumentation while staying
  // under the 30s global testTimeout so a wedge still fails fast.
  const COPY_GUARD_MS = 20_000;

  // Unlike the mock-only describes above, this one drives REAL PGlite
  // instances: the startup needs actual user/database parameters (the bare
  // 8-byte version-only frame is rejected by a real backend).
  const startupBytes = (): Buffer => {
    const params = Buffer.from('user\0postgres\0database\0postgres\0\0');
    const buf = Buffer.alloc(8 + params.length);
    buf.writeUInt32BE(8 + params.length, 0);
    buf.writeUInt32BE(0x00030000, 4);
    params.copy(buf, 8);
    return buf;
  };

  const simpleQuery = (sql: string): Buffer => {
    const payload = Buffer.from(`${sql}\0`);
    const len = 4 + payload.length;
    const buf = Buffer.alloc(1 + len);
    buf[0] = QUERY;
    buf.writeUInt32BE(len, 1);
    payload.copy(buf, 5);
    return buf;
  };

  /** Payload-free wire frame: type byte + 4-byte BE length including itself. */
  const frame = (type: number): Buffer => {
    const buf = Buffer.alloc(5);
    buf[0] = type;
    buf.writeUInt32BE(4, 1);
    return buf;
  };

  /** CopyData 'd' frame: raw payload bytes, no terminator. */
  const copyDataFrame = (payload: string): Buffer => {
    const body = Buffer.from(payload);
    const buf = Buffer.alloc(5 + body.length);
    buf[0] = COPY_DATA;
    buf.writeUInt32BE(4 + body.length, 1);
    body.copy(buf, 5);
    return buf;
  };

  /** CopyFail 'f' frame: cstring error message. */
  const copyFailFrame = (message: string): Buffer => {
    const body = Buffer.from(`${message}\0`);
    const buf = Buffer.alloc(5 + body.length);
    buf[0] = COPY_FAIL;
    buf.writeUInt32BE(4 + body.length, 1);
    body.copy(buf, 5);
    return buf;
  };

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const writeAndAwait = (duplex: PGliteDuplex, chunk: Buffer): Promise<Error | undefined> =>
    new Promise((resolve) => {
      duplex.write(chunk, (err) => resolve(err ?? undefined));
    });

  const collect = (duplex: PGliteDuplex): Buffer[] => {
    const received: Buffer[] = [];
    duplex.on('data', (chunk: Buffer) => received.push(chunk));
    return received;
  };

  interface BackendFrame {
    type: number;
    payload: Buffer;
  }

  const parseFrames = (data: Buffer): BackendFrame[] => {
    const frames: BackendFrame[] = [];
    let p = 0;
    while (p + 5 <= data.length) {
      const type = data[p] ?? 0;
      const len = data.readUInt32BE(p + 1);
      frames.push({ type, payload: data.subarray(p + 5, p + 1 + len) });
      p += 1 + len;
    }
    return frames;
  };

  const framesAfter = (received: Buffer[], skipBytes: number): BackendFrame[] =>
    parseFrames(Buffer.concat(received).subarray(skipBytes));

  const copyInResponses = (frames: BackendFrame[]): BackendFrame[] =>
    frames.filter((f) => f.type === COPY_IN_RESPONSE);

  /** Human-readable message ('M') field of an ErrorResponse payload. */
  const errorMessageField = (payload: Buffer): string => {
    let p = 0;
    while (p < payload.length) {
      const fieldType = payload[p];
      if (fieldType === undefined || fieldType === 0) break;
      const end = payload.indexOf(0, p + 1);
      if (fieldType === 0x4d) {
        return payload.subarray(p + 1, end).toString('utf8');
      }
      p = end + 1;
    }
    return '';
  };

  /** Mock pglite whose execProtocolRawStream emits the scripted frames on
   *  each successive call (call 0 is the startup message). */
  const createScriptedCopyPGlite = (responses: Buffer[][]) => {
    let call = 0;
    const execProtocolRawStream = vi.fn(
      async (_message: Uint8Array, options: { onRawData: (chunk: Uint8Array) => void }) => {
        const frames = responses[call] ?? [];
        call += 1;
        for (const f of frames) {
          options.onRawData(f);
        }
      },
    );
    return { pglite: createMockPGlite({ execProtocolRawStream }), execProtocolRawStream };
  };

  const createFreshPGlite = async (): Promise<PGlite> => {
    const instance = new PGlite();
    await instance.waitReady;
    return instance;
  };

  /** Today a forwarded COPY ... FROM STDIN kills the backend; close() on a
   *  dead instance may reject or hang, so teardown is best-effort and
   *  bounded instead of letting a red test burn its whole timeout. */
  const closeQuietly = async (instance: PGlite): Promise<void> => {
    if (instance.closed) return;
    await Promise.race([
      instance.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  };

  it('synthesizes one CopyInResponse, runs the copy as one atomic call, and completes idle', {
    timeout: COPY_GUARD_MS,
  }, async () => {
    const instance = await createFreshPGlite();
    try {
      await instance.exec('CREATE TABLE copy_frames (n int, label text)');
      const rawSpy = vi.spyOn(instance, 'execProtocolRawStream');
      const duplex = new PGliteDuplex(instance);
      duplex.on('error', () => {});
      const received = collect(duplex);

      await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
      await settle();
      const startupLen = Buffer.concat(received).length;
      const callsAfterStartup = rawSpy.mock.calls.length;

      // The synthetic 'G' must be emitted BEFORE any PGlite execution. The
      // write is deliberately not awaited first: a regressed duplex that
      // forwards the query kills the backend and would wedge this await.
      const copyQueryWrite = writeAndAwait(
        duplex,
        simpleQuery('COPY copy_frames (n, label) FROM STDIN'),
      );
      await settle();
      await settle();

      const preData = copyInResponses(framesAfter(received, startupLen));
      expect(preData.length).toBe(1);
      // Synthetic, not forwarded: PGlite has not been executed yet.
      expect(rawSpy.mock.calls.length).toBe(callsAfterStartup);
      // Body: int8 format 0 (text), int16 ncols 0.
      expect(preData[0]?.payload.length).toBe(3);
      expect(preData[0]?.payload[0]).toBe(0);
      expect(preData[0]?.payload.readInt16BE(1)).toBe(0);
      await expect(copyQueryWrite).resolves.toBeUndefined();

      await expect(writeAndAwait(duplex, copyDataFrame('1\tone\n'))).resolves.toBeUndefined();
      await expect(writeAndAwait(duplex, copyDataFrame('2\ttwo\n'))).resolves.toBeUndefined();
      await expect(writeAndAwait(duplex, frame(COPY_DONE))).resolves.toBeUndefined();
      await settle();

      // One atomic execProtocolRawStream call for the whole conversation:
      // Query + captured data + terminator.
      expect(rawSpy.mock.calls.length).toBe(callsAfterStartup + 1);
      const atomic = Buffer.from(rawSpy.mock.calls[callsAfterStartup]?.[0] as Uint8Array);
      expect(atomic[0]).toBe(QUERY);
      expect(atomic.subarray(atomic.length - 5).equals(frame(COPY_DONE))).toBe(true);
      expect(atomic.includes('1\tone\n')).toBe(true);
      expect(atomic.includes('2\ttwo\n')).toBe(true);

      const frames = framesAfter(received, startupLen);
      // Exactly ONE 'G' in total — the backend's duplicate was dropped.
      expect(copyInResponses(frames).length).toBe(1);
      const complete = frames.filter((f) => f.type === COMMAND_COMPLETE);
      expect(complete.length).toBe(1);
      expect(complete[0]?.payload.toString('utf8')).toBe('COPY 2\0');
      const rfq = frames.filter((f) => f.type === READY_FOR_QUERY).at(-1);
      expect(rfq?.payload[0]).toBe(0x49); // 'I'

      const { rows } = await instance.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM copy_frames',
      );
      expect(rows[0]?.c).toBe(2);

      duplex.destroy();
      // _destroy fires the transaction rollback asynchronously; closing PGlite
      // while that query is in flight wedges the WASM runtime. onClose is the
      // designed post-rollback synchronization point.
      await duplex.onClose;
    } finally {
      await closeQuietly(instance);
    }
  });

  it('reports in-transaction status on the ReadyForQuery of a COPY inside BEGIN', {
    timeout: COPY_GUARD_MS,
  }, async () => {
    const instance = await createFreshPGlite();
    try {
      await instance.exec('CREATE TABLE copy_frames_tx (n int)');
      const duplex = new PGliteDuplex(instance);
      duplex.on('error', () => {});
      const received = collect(duplex);

      await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
      await expect(writeAndAwait(duplex, simpleQuery('BEGIN'))).resolves.toBeUndefined();
      await settle();
      const preCopyLen = Buffer.concat(received).length;

      const copyQueryWrite = writeAndAwait(
        duplex,
        simpleQuery('COPY copy_frames_tx (n) FROM STDIN'),
      );
      await settle();
      await settle();
      expect(copyInResponses(framesAfter(received, preCopyLen)).length).toBe(1);
      await expect(copyQueryWrite).resolves.toBeUndefined();

      await expect(writeAndAwait(duplex, copyDataFrame('7\n'))).resolves.toBeUndefined();
      await expect(writeAndAwait(duplex, frame(COPY_DONE))).resolves.toBeUndefined();
      await settle();

      const frames = framesAfter(received, preCopyLen);
      expect(copyInResponses(frames).length).toBe(1);
      const rfq = frames.filter((f) => f.type === READY_FOR_QUERY).at(-1);
      expect(rfq?.payload[0]).toBe(0x54); // 'T' — still inside the transaction

      duplex.destroy();
      // _destroy fires the transaction rollback asynchronously; closing PGlite
      // while that query is in flight wedges the WASM runtime. onClose is the
      // designed post-rollback synchronization point.
      await duplex.onClose;
    } finally {
      await closeQuietly(instance);
    }
  });

  it('forwards the backend error after CopyFail with only the synthetic CopyInResponse', {
    timeout: COPY_GUARD_MS,
  }, async () => {
    const instance = await createFreshPGlite();
    try {
      await instance.exec('CREATE TABLE copy_frames_fail (n int)');
      const duplex = new PGliteDuplex(instance);
      duplex.on('error', () => {});
      const received = collect(duplex);

      await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
      await settle();
      const startupLen = Buffer.concat(received).length;

      const copyQueryWrite = writeAndAwait(
        duplex,
        simpleQuery('COPY copy_frames_fail (n) FROM STDIN'),
      );
      await settle();
      await settle();
      expect(copyInResponses(framesAfter(received, startupLen)).length).toBe(1);
      await expect(copyQueryWrite).resolves.toBeUndefined();

      await expect(writeAndAwait(duplex, copyDataFrame('1\n'))).resolves.toBeUndefined();
      await expect(
        writeAndAwait(duplex, copyFailFrame('client changed its mind')),
      ).resolves.toBeUndefined();
      await settle();

      const frames = framesAfter(received, startupLen);
      expect(copyInResponses(frames).length).toBe(1);
      const error = frames.find((f) => f.type === ERROR_RESPONSE);
      expect(error).toBeDefined();
      expect(errorMessageField(error?.payload ?? Buffer.alloc(0))).toMatch(
        /client changed its mind/,
      );
      const rfq = frames.filter((f) => f.type === READY_FOR_QUERY).at(-1);
      expect(rfq?.payload[0]).toBe(0x49); // 'I'

      // The failed COPY inserted nothing and the session survived.
      const { rows } = await instance.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM copy_frames_fail',
      );
      expect(rows[0]?.c).toBe(0);

      duplex.destroy();
      // _destroy fires the transaction rollback asynchronously; closing PGlite
      // while that query is in flight wedges the WASM runtime. onClose is the
      // designed post-rollback synchronization point.
      await duplex.onClose;
    } finally {
      await closeQuietly(instance);
    }
  });

  it('rejects a multi-statement COPY with a synthesized error without touching PGlite (idle)', async () => {
    const { pglite, execProtocolRawStream } = createScriptedCopyPGlite([
      [RFQ_IDLE_MESSAGE],
      [RFQ_IDLE_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const startupLen = Buffer.concat(received).length;

    await expect(
      writeAndAwait(duplex, simpleQuery('COPY copy_frames (n) FROM STDIN; SELECT 1')),
    ).resolves.toBeUndefined();
    await settle();

    // Fail closed: forwarding would kill the instance, so the query must
    // never reach PGlite.
    expect(execProtocolRawStream).toHaveBeenCalledTimes(1);

    const frames = framesAfter(received, startupLen);
    expect(frames.map((f) => f.type)).toEqual([ERROR_RESPONSE, READY_FOR_QUERY]);
    expect(errorMessageField(frames[0]?.payload ?? Buffer.alloc(0))).toMatch(/COPY/i);
    expect(frames[1]?.payload[0]).toBe(0x49); // idle

    // The rejection is catchable, not teardown: a normal query still works.
    await expect(writeAndAwait(duplex, simpleQuery('SELECT 1'))).resolves.toBeUndefined();
    expect(execProtocolRawStream).toHaveBeenCalledTimes(2);
    expect(duplex.destroyed).toBe(false);

    duplex.destroy();
    // _destroy fires the transaction rollback asynchronously; closing PGlite
    // while that query is in flight wedges the WASM runtime. onClose is the
    // designed post-rollback synchronization point.
    await duplex.onClose;
  });

  it('rejects a multi-statement COPY with in-transaction status inside a transaction', async () => {
    const { pglite, execProtocolRawStream } = createScriptedCopyPGlite([
      [RFQ_IDLE_MESSAGE],
      [RFQ_IN_TRANSACTION_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(writeAndAwait(duplex, simpleQuery('BEGIN'))).resolves.toBeUndefined();
    await settle();
    const preCopyLen = Buffer.concat(received).length;

    await expect(
      writeAndAwait(duplex, simpleQuery('COPY copy_frames (n) FROM STDIN; SELECT 1')),
    ).resolves.toBeUndefined();
    await settle();

    expect(execProtocolRawStream).toHaveBeenCalledTimes(2); // startup + BEGIN only

    const frames = framesAfter(received, preCopyLen);
    expect(frames.map((f) => f.type)).toEqual([ERROR_RESPONSE, READY_FOR_QUERY]);
    // The synthesized ReadyForQuery must mirror the open transaction.
    expect(frames[1]?.payload[0]).toBe(0x54); // 'T'

    duplex.destroy();
    // _destroy fires the transaction rollback asynchronously; closing PGlite
    // while that query is in flight wedges the WASM runtime. onClose is the
    // designed post-rollback synchronization point.
    await duplex.onClose;
  });

  it('synthesizes a catchable cap error on the terminator when the aggregate cap is breached', async () => {
    const { pglite, execProtocolRawStream } = createScriptedCopyPGlite([
      [RFQ_IDLE_MESSAGE],
      [RFQ_IDLE_MESSAGE],
    ]);
    const duplex = new PGliteDuplex(pglite, { copyAggregateCapBytes: 64 });
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const startupLen = Buffer.concat(received).length;

    await expect(
      writeAndAwait(duplex, simpleQuery('COPY copy_frames (n, label) FROM STDIN')),
    ).resolves.toBeUndefined();
    await settle();
    expect(copyInResponses(framesAfter(received, startupLen)).length).toBe(1);
    const preDataLen = Buffer.concat(received).length;

    // 3 × 40 payload bytes = 120 captured bytes — past the 64-byte cap. The
    // remainder is discarded silently: every write succeeds and nothing is
    // synthesized until the terminator arrives.
    const chunk = `${'x'.repeat(39)}\n`;
    for (let i = 0; i < 3; i++) {
      await expect(writeAndAwait(duplex, copyDataFrame(chunk))).resolves.toBeUndefined();
    }
    expect(Buffer.concat(received).length).toBe(preDataLen);

    await expect(writeAndAwait(duplex, frame(COPY_DONE))).resolves.toBeUndefined();
    await settle();

    // The backend never saw any part of the copy.
    expect(execProtocolRawStream).toHaveBeenCalledTimes(1);

    const frames = framesAfter(received, preDataLen);
    expect(frames.map((f) => f.type)).toEqual([ERROR_RESPONSE, READY_FOR_QUERY]);
    expect(errorMessageField(frames[0]?.payload ?? Buffer.alloc(0))).toMatch(/cap/i);

    // Catchable error, not teardown: the duplex keeps serving queries.
    await expect(writeAndAwait(duplex, simpleQuery('SELECT 1'))).resolves.toBeUndefined();
    expect(execProtocolRawStream).toHaveBeenCalledTimes(2);
    expect(duplex.destroyed).toBe(false);

    duplex.destroy();
    // _destroy fires the transaction rollback asynchronously; closing PGlite
    // while that query is in flight wedges the WASM runtime. onClose is the
    // designed post-rollback synchronization point.
    await duplex.onClose;
  });

  it('tears down on a non-copy frontend message while capturing', async () => {
    const { pglite, execProtocolRawStream } = createScriptedCopyPGlite([[RFQ_IDLE_MESSAGE]]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await settle();
    const startupLen = Buffer.concat(received).length;

    await expect(
      writeAndAwait(duplex, simpleQuery('COPY copy_frames (n) FROM STDIN')),
    ).resolves.toBeUndefined();
    await settle();
    expect(copyInResponses(framesAfter(received, startupLen)).length).toBe(1);

    // Sync is not part of a copy conversation — a client this confused
    // cannot be trusted with the session: protocol violation, teardown.
    const err = await writeAndAwait(duplex, frame(SYNC));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/COPY/i);
    await settle();
    expect(duplex.destroyed).toBe(true);
    expect(execProtocolRawStream).toHaveBeenCalledTimes(1); // never reached PGlite
  });

  it('forwards a stray copy frame outside any capture (backend ignores it)', {
    timeout: COPY_GUARD_MS,
  }, async () => {
    // Protocol spec: CopyData/CopyDone/CopyFail outside copy mode are
    // accepted-and-ignored by the backend (verified against PGlite) — the
    // duplex must pass them through like any standalone message, not
    // treat them as capture traffic.
    const instance = await createFreshPGlite();
    try {
      const duplex = new PGliteDuplex(instance);
      duplex.on('error', () => {});
      const received = collect(duplex);

      await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
      await settle();
      const startupLen = Buffer.concat(received).length;

      await expect(writeAndAwait(duplex, frame(COPY_DONE))).resolves.toBeUndefined();
      await expect(writeAndAwait(duplex, simpleQuery('SELECT 1'))).resolves.toBeUndefined();
      await settle();

      const frames = framesAfter(received, startupLen);
      const rfq = frames.filter((f) => f.type === READY_FOR_QUERY).at(-1);
      expect(rfq?.payload[0]).toBe(0x49); // session healthy after the stray frame

      duplex.destroy();
      await duplex.onClose;
    } finally {
      await closeQuietly(instance);
    }
  });

  it('synthesizes an idle ReadyForQuery when the backend never reported a status', async () => {
    // A scripted backend whose startup response carries no ReadyForQuery:
    // the fail-closed rejection still needs a status byte and falls back
    // to idle.
    const { pglite } = createScriptedCopyPGlite([[]]);
    const duplex = new PGliteDuplex(pglite);
    duplex.on('error', () => {});
    const received = collect(duplex);

    await expect(writeAndAwait(duplex, startupBytes())).resolves.toBeUndefined();
    await expect(
      writeAndAwait(duplex, simpleQuery('COPY t (n) FROM STDIN; SELECT 1')),
    ).resolves.toBeUndefined();
    await settle();

    const frames = parseFrames(Buffer.concat(received));
    expect(frames.some((f) => f.type === ERROR_RESPONSE)).toBe(true);
    const rfq = frames.filter((f) => f.type === READY_FOR_QUERY).at(-1);
    expect(rfq?.payload[0]).toBe(0x49); // 'I' — the fallback

    duplex.destroy();
    await duplex.onClose;
  });
});
