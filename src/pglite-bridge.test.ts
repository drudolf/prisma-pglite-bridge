import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockTelemetry } from './__tests__/mocks.ts';
import setupPGlite from './__tests__/pglite.ts';
import { createPool } from './create-pool.ts';
import { BackendMessageFramer, FrontendMessageBuffer, PGliteBridge } from './pglite-bridge.ts';
import type { TelemetrySink } from './utils/adapter-stats.ts';
import { SessionLock } from './utils/session-lock.ts';

const pglite = await setupPGlite();

beforeAll(async () => {
  await pglite.exec('CREATE TABLE IF NOT EXISTS conc_test (id serial PRIMARY KEY, val int)');
});
beforeEach(async () => {
  await pglite.exec('DROP TABLE IF EXISTS bridge_test CASCADE');
  await pglite.exec('DROP TABLE IF EXISTS shared_test CASCADE');
  await pglite.exec('TRUNCATE TABLE conc_test RESTART IDENTITY');
});

const createClient = (adapterId?: symbol, telemetry?: TelemetrySink) =>
  new pg.Client({
    user: 'postgres',
    database: 'postgres',
    stream: () => new PGliteBridge(pglite, undefined, adapterId, telemetry),
  });

describe('PGliteBridge', () => {
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
    const bridge = new PGliteBridge(pglite);
    expect(bridge.setKeepAlive()).toBe(bridge);
    expect(bridge.setNoDelay()).toBe(bridge);
    expect(bridge.setTimeout()).toBe(bridge);
    expect(bridge.ref()).toBe(bridge);
    expect(bridge.unref()).toBe(bridge);
    expect(bridge.connect()).toBe(bridge);
    bridge.destroy();
  });
});

describe('PGliteBridge concurrency', () => {
  it('concurrent parameterized queries through pool do not cause portal errors', async () => {
    const { pool } = await createPool({ max: 5, pglite });

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
    const { pool } = await createPool({ max: 3, pglite });

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

describe('PGliteBridge error paths', () => {
  const makeMockPglite = (overrides: {
    runExclusive?: (fn: () => Promise<unknown>) => Promise<void>;
    execProtocolRawStream?: (
      msg: Uint8Array,
      opts: { onRawData: (chunk: Uint8Array) => void },
    ) => Promise<void>;
  }): PGlite =>
    ({
      runExclusive:
        overrides.runExclusive ??
        (async (fn: () => Promise<unknown>) => {
          await fn();
        }),
      execProtocolRawStream: overrides.execProtocolRawStream ?? (async () => {}),
    }) as unknown as PGlite;

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

  const writeAndAwait = (bridge: PGliteBridge, chunk: Buffer): Promise<Error | undefined> =>
    new Promise((resolve) => {
      bridge.write(chunk, (err) => resolve(err ?? undefined));
    });

  it('fires pending write callbacks with the destroy error when torn down mid-drain', async () => {
    const mock = makeMockPglite({
      runExclusive: () => new Promise<void>(() => {}),
    });
    const bridge = new PGliteBridge(mock);
    bridge.on('error', () => {});

    const writeResult = writeAndAwait(bridge, startupBytes());
    await new Promise((resolve) => setImmediate(resolve));

    const destroyErr = new Error('bridge torn down');
    bridge.destroy(destroyErr);

    await expect(writeResult).resolves.toBe(destroyErr);
  });

  it('releases the session lock and surfaces the error when runExclusive throws', async () => {
    const mock = makeMockPglite({
      runExclusive: async () => {
        throw new Error('pglite kaput');
      },
    });
    const lock = new SessionLock();
    const releaseSpy = vi.spyOn(lock, 'release');
    const bridge = new PGliteBridge(mock, lock);
    bridge.on('error', () => {});

    const err = await writeAndAwait(bridge, startupBytes());
    expect(err?.message).toBe('pglite kaput');
    expect(releaseSpy).toHaveBeenCalled();

    bridge.destroy();
  });

  it('records a failed query and rethrows when runExclusive throws after startup', async () => {
    let call = 0;
    const mock = makeMockPglite({
      runExclusive: async (fn) => {
        call += 1;
        if (call === 1) {
          await fn();
          return;
        }
        throw new Error('query kaput');
      },
    });

    const telemetry = createMockTelemetry();

    const bridge = new PGliteBridge(mock, undefined, Symbol('adapter'), telemetry);
    bridge.on('error', () => {});

    const startupErr = await writeAndAwait(bridge, startupBytes());
    expect(startupErr).toBeUndefined();

    const queryErr = await writeAndAwait(bridge, simpleQuery('SELECT 1'));
    expect(queryErr?.message).toBe('query kaput');
    expect(telemetry.recordQuery).toHaveBeenCalledWith(expect.any(Number), false);

    bridge.destroy();
  });

  it('holds processing until a partial startup message completes', async () => {
    let runCalls = 0;
    const mock = makeMockPglite({
      runExclusive: async (fn) => {
        runCalls += 1;
        await fn();
      },
    });
    const bridge = new PGliteBridge(mock);
    bridge.on('error', () => {});

    const firstHalf = startupBytes().subarray(0, 3);
    const secondHalf = startupBytes().subarray(3);

    const partialErr = await writeAndAwait(bridge, Buffer.from(firstHalf));
    expect(partialErr).toBeUndefined();
    expect(runCalls).toBe(0);

    const restErr = await writeAndAwait(bridge, Buffer.from(secondHalf));
    expect(restErr).toBeUndefined();
    expect(runCalls).toBe(1);

    bridge.destroy();
  });

  it('breaks out of processMessages on a malformed length header', async () => {
    const mock = makeMockPglite({});
    const bridge = new PGliteBridge(mock);
    bridge.on('error', () => {});

    const startupErr = await writeAndAwait(bridge, startupBytes());
    expect(startupErr).toBeUndefined();

    const malformed = Buffer.from([0x51, 0x00, 0x00, 0x00, 0x03]);
    const err = await writeAndAwait(bridge, malformed);
    expect(err).toBeUndefined();

    bridge.destroy();
  });

  it('releases the session lock and ends the stream on TERMINATE', async () => {
    const mock = makeMockPglite({});
    const lock = new SessionLock();
    const releaseSpy = vi.spyOn(lock, 'release');
    const bridge = new PGliteBridge(mock, lock);
    bridge.on('error', () => {});

    await writeAndAwait(bridge, startupBytes());
    releaseSpy.mockClear();

    const terminate = Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]);
    await writeAndAwait(bridge, terminate);

    expect(releaseSpy).toHaveBeenCalled();

    bridge.destroy();
  });

  it('wraps a non-Error throw into an Error when runExclusive rejects', async () => {
    const mock = makeMockPglite({
      runExclusive: async () => {
        throw 'plain string boom';
      },
    });
    const bridge = new PGliteBridge(mock);
    bridge.on('error', () => {});

    const err = await writeAndAwait(bridge, startupBytes());
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('plain string boom');

    bridge.destroy();
  });

  it('queues additional writes while a drain is already running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runCalls = 0;
    const mock = makeMockPglite({
      runExclusive: async (fn) => {
        runCalls += 1;
        if (runCalls === 1) await gate;
        await fn();
      },
    });
    const bridge = new PGliteBridge(mock);
    bridge.on('error', () => {});

    // Call _write directly twice in the same tick so the second one sees
    // `draining === true` (Node's Writable would otherwise serialize).
    type WriteInternal = (
      chunk: Buffer,
      enc: BufferEncoding,
      cb: (err?: Error | null) => void,
    ) => void;
    const rawWrite = (bridge as unknown as { _write: WriteInternal })._write.bind(bridge);

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

    bridge.destroy();
  });

  it('records a failed query when an EQP pipeline returns ErrorResponse', async () => {
    const telemetry = createMockTelemetry();

    const client = createClient(Symbol('adapter'), telemetry);
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
    const blockedBridge = new PGliteBridge(
      makeMockPglite({
        runExclusive: async (fn) => {
          destroyedBridgeRan = true;
          await fn();
        },
      }),
      lock,
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
    const nextBridge = new PGliteBridge(
      makeMockPglite({
        runExclusive: async (fn) => {
          nextBridgeRan = true;
          await fn();
        },
      }),
      lock,
    );
    nextBridge.on('error', () => {});

    await expect(writeAndAwait(nextBridge, startupBytes())).resolves.toBeUndefined();
    expect(nextBridgeRan).toBe(true);

    nextBridge.destroy();
  });
});

describe('BackendMessageFramer', () => {
  const encodeMessage = (type: number, payload: Uint8Array): Uint8Array => {
    const result = new Uint8Array(1 + 4 + payload.length);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    result[0] = type;
    view.setUint32(1, 4 + payload.length);
    result.set(payload, 5);
    return result;
  };

  const splitEvery = (input: Uint8Array, size: number): Uint8Array[] => {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < input.length; offset += size) {
      chunks.push(input.subarray(offset, offset + size));
    }
    return chunks;
  };

  const collect = (chunks: Uint8Array[]): Uint8Array => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  };

  const makeHarness = (suppressIntermediateReadyForQuery = false) => {
    const outputs: Uint8Array[] = [];
    const statuses: number[] = [];
    let errorCount = 0;
    const framer = new BackendMessageFramer({
      suppressIntermediateReadyForQuery,
      onChunk: (chunk) => outputs.push(chunk.slice()),
      onErrorResponse: () => {
        errorCount++;
      },
      onReadyForQuery: (status) => {
        statuses.push(status);
      },
    });

    return {
      framer,
      outputs,
      statuses,
      get errorCount() {
        return errorCount;
      },
    };
  };

  const RFQ_IDLE = encodeMessage(0x5a, new Uint8Array([0x49]));
  const RFQ_FAILED = encodeMessage(0x5a, new Uint8Array([0x45]));
  const DATA = encodeMessage(0x44, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
  const ERROR = encodeMessage(0x45, new Uint8Array([0x53, 0x62, 0x6f, 0x6f, 0x6d, 0x00]));

  it('ignores zero-length chunks', () => {
    const { framer, outputs, statuses, errorCount } = makeHarness();
    framer.write(new Uint8Array(0));
    framer.flush();
    expect(outputs).toHaveLength(0);
    expect(statuses).toEqual([]);
    expect(errorCount).toBe(0);
  });

  it('handles a type byte alone, then length and payload', () => {
    const { framer, outputs } = makeHarness();
    framer.write(DATA.subarray(0, 1));
    expect(outputs).toHaveLength(0);
    framer.write(DATA.subarray(1));
    framer.flush();
    expect(collect(outputs)).toEqual(DATA);
  });

  it('handles a split in the middle of the length prefix', () => {
    const { framer, outputs } = makeHarness();
    framer.write(DATA.subarray(0, 3));
    expect(outputs).toHaveLength(0);
    framer.write(DATA.subarray(3));
    framer.flush();
    expect(collect(outputs)).toEqual(DATA);
  });

  it('emits header-only chunks without buffering the payload', () => {
    const payload = new Uint8Array([0xaa]);
    const message = encodeMessage(0x43, payload);
    const { framer, outputs } = makeHarness();
    framer.write(message.subarray(0, 5));
    expect(outputs.map((chunk) => chunk.length)).toEqual([5]);
    framer.write(message.subarray(5));
    framer.flush();
    expect(collect(outputs)).toEqual(message);
  });

  it('tracks ReadyForQuery only after the full frame arrives', () => {
    const { framer, outputs, statuses } = makeHarness();
    framer.write(RFQ_IDLE.subarray(0, 3));
    expect(outputs).toHaveLength(0);
    expect(statuses).toEqual([]);
    framer.write(RFQ_IDLE.subarray(3));
    framer.flush();
    expect(statuses).toEqual([0x49]);
    expect(collect(outputs)).toEqual(RFQ_IDLE);
  });

  it('drops intermediate RFQs and keeps the final one when suppression is enabled', () => {
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(RFQ_IDLE.subarray(0, 3));
    framer.write(RFQ_IDLE.subarray(3));
    framer.write(DATA);
    framer.write(RFQ_FAILED);
    framer.flush();
    expect(statuses).toEqual([0x49, 0x45]);
    expect(collect(outputs)).toEqual(collect([DATA, RFQ_FAILED]));
  });

  it('handles multiple back-to-back RFQs when the last one is split', () => {
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(RFQ_IDLE);
    framer.write(RFQ_FAILED.subarray(0, 3));
    framer.write(RFQ_FAILED.subarray(3));
    framer.flush();
    expect(statuses).toEqual([0x49, 0x45]);
    expect(collect(outputs)).toEqual(RFQ_FAILED);
  });

  it('emits a final RFQ when it is the last bytes in the stream', () => {
    const { framer, outputs } = makeHarness(true);
    framer.write(DATA);
    framer.write(RFQ_IDLE);
    framer.flush();
    expect(collect(outputs)).toEqual(collect([DATA, RFQ_IDLE]));
  });

  it('detects ErrorResponse at header decode time before forwarding payload bytes', () => {
    const events: string[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => events.push(`chunk:${chunk.length}`),
      onErrorResponse: () => {
        events.push('error');
      },
    });

    framer.write(ERROR.subarray(0, 1));
    framer.write(ERROR.subarray(1, 5));
    framer.write(ERROR.subarray(5));
    framer.flush();

    expect(events[0]).toBe('error');
    expect(events.slice(1)).toEqual(['chunk:5', `chunk:${ERROR.length - 5}`]);
  });

  it('forwards large payloads in streaming chunks instead of one large allocation', () => {
    const payload = new Uint8Array(64 * 1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i % 251;
    }
    const largeMessage = encodeMessage(0x44, payload);
    const chunks = splitEvery(largeMessage, 4 * 1024);
    const { framer, outputs } = makeHarness();

    for (const chunk of chunks) {
      framer.write(chunk);
    }
    framer.flush();

    expect(collect(outputs)).toEqual(largeMessage);
    expect(Math.max(...outputs.map((chunk) => chunk.length))).toBeLessThanOrEqual(4 * 1024);
    expect(outputs.length).toBeGreaterThan(4);
  });

  it('emits whole in-chunk messages as a single zero-copy slice', () => {
    const combined = collect([DATA, encodeMessage(0x43, new Uint8Array([0xaa]))]);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(combined);
    framer.flush();

    expect(collect(outputs)).toEqual(combined);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.buffer).toBe(combined.buffer);
    expect(outputs[1]?.buffer).toBe(combined.buffer);
  });

  it('copies whole-message slices when the chunk is a view into a larger buffer', () => {
    const padded = new Uint8Array(DATA.length + 4);
    padded.set(DATA, 2);
    const viewChunk = padded.subarray(2, 2 + DATA.length);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(viewChunk);
    framer.flush();

    expect(collect(outputs)).toEqual(DATA);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.buffer).not.toBe(padded.buffer);
  });

  it('does not treat a non-RFQ 0x5a frame as ReadyForQuery in the fast path', () => {
    const malformedZ = encodeMessage(0x5a, new Uint8Array([0x49, 0xaa]));
    const { framer, outputs, statuses } = makeHarness();

    framer.write(malformedZ);
    framer.flush();

    expect(statuses).toEqual([]);
    expect(collect(outputs)).toEqual(malformedZ);
  });

  it('copies when the chunk is backed by a SharedArrayBuffer', () => {
    const shared = new SharedArrayBuffer(DATA.length);
    const sharedChunk = new Uint8Array(shared);
    sharedChunk.set(DATA);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(sharedChunk);
    framer.flush();

    expect(collect(outputs)).toEqual(DATA);
    for (const chunk of outputs) {
      expect(chunk.buffer).not.toBe(shared);
      expect(chunk.buffer instanceof SharedArrayBuffer).toBe(false);
    }
  });

  it('throws on a backend message with a length header < 4', () => {
    const { framer } = makeHarness();
    const malformed = new Uint8Array([0x44, 0x00, 0x00, 0x00, 0x03]);
    expect(() => framer.write(malformed)).toThrow(/Malformed backend message length: 3/);
  });

  it('throws when the backend message length header exceeds the 1 GiB sanity cap', () => {
    const { framer } = makeHarness();
    const tooLarge = new Uint8Array([0x44, 0x7f, 0xff, 0xff, 0xff]);
    expect(() => framer.write(tooLarge)).toThrow(/exceeds sanity cap/);
  });

  it('throws on a malformed length header assembled via the slow path', () => {
    const { framer } = makeHarness();
    framer.write(new Uint8Array([0x44]));
    expect(() => framer.write(new Uint8Array([0x00, 0x00, 0x00, 0x03]))).toThrow(
      /Malformed backend message length: 3/,
    );
  });

  it('throws on an oversized length header assembled via the slow path', () => {
    const { framer } = makeHarness();
    framer.write(new Uint8Array([0x44]));
    expect(() => framer.write(new Uint8Array([0x7f, 0xff, 0xff, 0xff]))).toThrow(
      /exceeds sanity cap/,
    );
  });

  it('finishes a zero-payload message whose header arrives split across chunks', () => {
    const { framer, outputs } = makeHarness();
    // CopyDone ('c') has length == 4 (header only, no payload).
    framer.write(new Uint8Array([0x63]));
    framer.write(new Uint8Array([0x00, 0x00, 0x00, 0x04]));
    framer.flush();
    expect(collect(outputs)).toEqual(new Uint8Array([0x63, 0x00, 0x00, 0x00, 0x04]));
  });

  it('drops a held final RFQ when flush is asked to discard it', () => {
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(DATA);
    framer.write(RFQ_IDLE);
    expect(outputs.some((chunk) => chunk.length === RFQ_IDLE.length)).toBe(false);
    framer.flush({ dropHeldReadyForQuery: true });
    expect(statuses).toEqual([0x49]);
    expect(collect(outputs)).toEqual(DATA);
  });

  it('can reset between flushPipeline-style boundaries without leaking partial state', () => {
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(RFQ_IDLE.subarray(0, 3));
    framer.reset();
    framer.write(DATA);
    framer.write(RFQ_FAILED);
    framer.flush();
    expect(statuses).toEqual([0x45]);
    expect(collect(outputs)).toEqual(collect([DATA, RFQ_FAILED]));
  });
});

describe('FrontendMessageBuffer', () => {
  const int32 = (value: number): Uint8Array => {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value);
    return buf;
  };

  const frontendMessage = (type: number, payload: Uint8Array): Uint8Array => {
    const result = new Uint8Array(1 + 4 + payload.length);
    result[0] = type;
    result.set(int32(4 + payload.length), 1);
    result.set(payload, 5);
    return result;
  };

  it('reads startup lengths across split chunks', () => {
    const buffer = new FrontendMessageBuffer();
    const startup = new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00]);
    buffer.push(startup.subarray(0, 2));
    expect(buffer.readInt32BE(0)).toBeUndefined();
    buffer.push(startup.subarray(2));
    expect(buffer.readInt32BE(0)).toBe(8);
    expect(buffer.consume(8)).toEqual(startup);
    expect(buffer.length).toBe(0);
  });

  it('reads regular message lengths across split type and header bytes', () => {
    const buffer = new FrontendMessageBuffer();
    const message = frontendMessage(
      0x51,
      new Uint8Array([0x73, 0x65, 0x6c, 0x65, 0x63, 0x74, 0x00]),
    );
    buffer.push(message.subarray(0, 1));
    expect(buffer.readInt32BE(1)).toBeUndefined();
    buffer.push(message.subarray(1, 4));
    expect(buffer.readInt32BE(1)).toBeUndefined();
    buffer.push(message.subarray(4));
    expect(buffer.readInt32BE(1)).toBe(11);
    expect(buffer.consume(message.length)).toEqual(message);
  });

  it('returns a zero-copy view when a full message is already in one chunk', () => {
    const buffer = new FrontendMessageBuffer();
    const message = frontendMessage(0x53, new Uint8Array(0));
    buffer.push(message);
    const consumed = buffer.consume(message.length);
    expect(consumed).toEqual(message);
    expect(consumed.buffer).toBe(message.buffer);
    expect(buffer.length).toBe(0);
  });

  it('allocates once when a message spans chunks', () => {
    const buffer = new FrontendMessageBuffer();
    const message = frontendMessage(0x50, new Uint8Array([0x61, 0x00, 0x62, 0x00, 0x00]));
    buffer.push(message.subarray(0, 3));
    buffer.push(message.subarray(3));
    const consumed = buffer.consume(message.length);
    expect(consumed).toEqual(message);
    expect(consumed.buffer).not.toBe(message.buffer);
    expect(buffer.length).toBe(0);
  });

  it('returns a zero-copy view when consuming only part of a larger head chunk', () => {
    const buffer = new FrontendMessageBuffer();
    const first = frontendMessage(0x53, new Uint8Array(0));
    const second = frontendMessage(0x58, new Uint8Array(0));
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first, 0);
    combined.set(second, first.length);
    buffer.push(combined);
    const consumed = buffer.consume(first.length);
    expect(consumed).toEqual(first);
    expect(consumed.buffer).toBe(combined.buffer);
    expect(buffer.consume(second.length)).toEqual(second);
  });

  it('can consume one framed message and leave the next queued', () => {
    const buffer = new FrontendMessageBuffer();
    const first = frontendMessage(0x53, new Uint8Array(0));
    const second = frontendMessage(0x58, new Uint8Array(0));
    buffer.push(first);
    buffer.push(second);
    expect(buffer.consume(first.length)).toEqual(first);
    expect(buffer.peekByte(0)).toBe(0x58);
    expect(buffer.readInt32BE(1)).toBe(4);
    expect(buffer.consume(second.length)).toEqual(second);
  });

  it('leaves the tail of a chunk queued when consume ends mid-chunk', () => {
    const buffer = new FrontendMessageBuffer();
    const first = frontendMessage(0x53, new Uint8Array(0));
    const second = frontendMessage(0x58, new Uint8Array(0));
    buffer.push(first.subarray(0, 3));
    const tail = new Uint8Array(first.length - 3 + second.length);
    tail.set(first.subarray(3), 0);
    tail.set(second, first.length - 3);
    buffer.push(tail);
    expect(buffer.consume(first.length)).toEqual(first);
    expect(buffer.length).toBe(second.length);
    expect(buffer.consume(second.length)).toEqual(second);
  });

  it('throws when consuming more bytes than are buffered', () => {
    const buffer = new FrontendMessageBuffer();
    expect(() => buffer.consume(1)).toThrow(/Cannot consume 1 bytes from 0-byte buffer/);
    buffer.push(new Uint8Array([0x01, 0x02]));
    expect(() => buffer.consume(3)).toThrow(/Cannot consume 3 bytes from 2-byte buffer/);
    expect(() => buffer.consume(-1)).toThrow(/Cannot consume -1 bytes/);
  });

  it('ignores empty pushes and supports consume(0)', () => {
    const buffer = new FrontendMessageBuffer();
    buffer.push(new Uint8Array(0));
    expect(buffer.length).toBe(0);
    expect(buffer.consume(0)).toEqual(new Uint8Array(0));
    buffer.push(new Uint8Array([0x41]));
    expect(buffer.consume(0)).toEqual(new Uint8Array(0));
    expect(buffer.length).toBe(1);
  });
});
