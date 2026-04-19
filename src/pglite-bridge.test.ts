import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BackendMessageFramer,
  FrontendMessageBuffer,
  PGliteBridge,
  stripIntermediateReadyForQuery,
} from './pglite-bridge.ts';

const { Client, Pool } = pg;

const createClient = (pglite: PGlite) =>
  new Client({
    user: 'postgres',
    database: 'postgres',
    stream: () => new PGliteBridge(pglite),
  });

describe('PGliteBridge', () => {
  let pglite: PGlite;

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.waitReady;
  });

  afterAll(async () => {
    await pglite.close();
  });

  it('pg.Client connects through the bridge', async () => {
    const client = createClient(pglite);
    await client.connect();
    await client.end();
  });

  it('executes a simple query', async () => {
    const client = createClient(pglite);
    await client.connect();
    const { rows } = await client.query('SELECT 1 + 1 AS result');
    expect(rows[0]?.result).toBe(2);
    await client.end();
  });

  it('executes parameterized queries', async () => {
    const client = createClient(pglite);
    await client.connect();
    const { rows } = await client.query('SELECT $1::int + $2::int AS result', [3, 4]);
    expect(rows[0]?.result).toBe(7);
    await client.end();
  });

  it('handles DDL and DML', async () => {
    const client = createClient(pglite);
    await client.connect();

    await client.query('CREATE TABLE IF NOT EXISTS bridge_test (id serial PRIMARY KEY, name text)');
    await client.query("INSERT INTO bridge_test (name) VALUES ('hello')");
    const { rows } = await client.query('SELECT name FROM bridge_test');
    expect(rows[0]?.name).toBe('hello');
    await client.query('DROP TABLE bridge_test');

    await client.end();
  });

  it('multiple sequential clients share the same PGlite', async () => {
    const c1 = createClient(pglite);
    await c1.connect();
    await c1.query('CREATE TABLE IF NOT EXISTS shared_test (id serial PRIMARY KEY, val int)');
    await c1.query('INSERT INTO shared_test (val) VALUES (42)');
    await c1.end();

    const c2 = createClient(pglite);
    await c2.connect();
    const { rows } = await c2.query('SELECT val FROM shared_test');
    expect(rows[0]?.val).toBe(42);
    await c2.query('DROP TABLE shared_test');
    await c2.end();
  });

  it('propagates SQL errors correctly', async () => {
    const client = createClient(pglite);
    await client.connect();
    await expect(client.query('SELECT * FROM nonexistent_table')).rejects.toThrow(/does not exist/);
    // Client should still be usable after error
    const { rows } = await client.query('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);
    await client.end();
  });
});

describe('PGliteBridge concurrency', () => {
  let pglite: PGlite;

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.waitReady;
    await pglite.exec('CREATE TABLE conc_test (id serial PRIMARY KEY, val int)');
  });

  afterAll(async () => {
    await pglite.close();
  });

  it('concurrent parameterized queries through pool do not cause portal errors', async () => {
    const pool = new Pool({
      Client: class extends Client {
        constructor(config?: string | pg.ClientConfig) {
          const cfg = typeof config === 'string' ? { connectionString: config } : (config ?? {});
          super({
            ...cfg,
            user: 'postgres',
            database: 'postgres',
            stream: () => new PGliteBridge(pglite),
          } as pg.ClientConfig);
        }
      } as typeof Client,
      max: 5,
    });

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
    const pool = new Pool({
      Client: class extends Client {
        constructor(config?: string | pg.ClientConfig) {
          const cfg = typeof config === 'string' ? { connectionString: config } : (config ?? {});
          super({
            ...cfg,
            user: 'postgres',
            database: 'postgres',
            stream: () => new PGliteBridge(pglite),
          } as pg.ClientConfig);
        }
      } as typeof Client,
      max: 3,
    });

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

describe('stripIntermediateReadyForQuery', () => {
  // ReadyForQuery: Z(5a) + length(00000005) + status(49='I')
  const RFQ = new Uint8Array([0x5a, 0x00, 0x00, 0x00, 0x05, 0x49]);
  // ParseComplete: 1(31) + length(00000004)
  const PARSE_COMPLETE = new Uint8Array([0x31, 0x00, 0x00, 0x00, 0x04]);
  // BindComplete: 2(32) + length(00000004)
  const BIND_COMPLETE = new Uint8Array([0x32, 0x00, 0x00, 0x00, 0x04]);
  // CommandComplete: C + length + "INSERT 0 1\0"
  const CMD_COMPLETE = new Uint8Array([
    0x43, 0x00, 0x00, 0x00, 0x0f, 0x49, 0x4e, 0x53, 0x45, 0x52, 0x54, 0x20, 0x30, 0x20, 0x31, 0x00,
  ]);

  const cat = (...parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      result.set(p, offset);
      offset += p.length;
    }
    return result;
  };

  it('returns empty response unchanged', () => {
    const empty = new Uint8Array(0);
    expect(stripIntermediateReadyForQuery(empty)).toEqual(empty);
  });

  it('returns response with 0 RFQ unchanged', () => {
    expect(stripIntermediateReadyForQuery(PARSE_COMPLETE)).toEqual(PARSE_COMPLETE);
  });

  it('returns response with 1 RFQ unchanged', () => {
    const input = cat(PARSE_COMPLETE, RFQ);
    expect(stripIntermediateReadyForQuery(input)).toEqual(input);
  });

  it('strips intermediate RFQ, keeps last', () => {
    // Simulates: ParseComplete + RFQ + BindComplete + RFQ + CommandComplete + RFQ
    const input = cat(PARSE_COMPLETE, RFQ, BIND_COMPLETE, RFQ, CMD_COMPLETE, RFQ);
    const expected = cat(PARSE_COMPLETE, BIND_COMPLETE, CMD_COMPLETE, RFQ);
    expect(stripIntermediateReadyForQuery(input)).toEqual(expected);
  });

  it('handles response that is only RFQ messages', () => {
    const input = cat(RFQ, RFQ, RFQ);
    expect(stripIntermediateReadyForQuery(input)).toEqual(RFQ);
  });

  it('does not false-match RFQ bytes inside a DataRow payload', () => {
    // DataRow with payload that happens to contain the RFQ byte pattern
    // D + length(16) + fieldCount(1) + fieldLen(6) + "Z\x00\x00\x00\x05I"
    // Total = 1 (type) + 16 (length field value) = 17 bytes
    const dataRow = new Uint8Array([
      0x44,
      0x00,
      0x00,
      0x00,
      0x10, // D + length 16
      0x00,
      0x01, // 1 field
      0x00,
      0x00,
      0x00,
      0x06, // field length 6
      0x5a,
      0x00,
      0x00,
      0x00,
      0x05,
      0x49, // field data = RFQ bytes
    ]);
    const input = cat(dataRow, RFQ);
    // Should NOT strip — the RFQ-like bytes are inside the DataRow, not a standalone message
    expect(stripIntermediateReadyForQuery(input)).toEqual(input);
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

  it('reuses owning chunk storage for partial payload slices', () => {
    const combined = collect([DATA, encodeMessage(0x43, new Uint8Array([0xaa]))]);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(combined);
    framer.flush();

    expect(collect(outputs)).toEqual(combined);
    expect(outputs).toHaveLength(4);
    expect(outputs[1]).toBeDefined();
    expect(outputs[1]?.buffer).toBe(combined.buffer);
    expect(outputs[3]).toBeDefined();
    expect(outputs[3]?.buffer).toBe(combined.buffer);
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
    expect(buffer.readInt32BE(0)).toBeNull();
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
    expect(buffer.readInt32BE(1)).toBeNull();
    buffer.push(message.subarray(1, 4));
    expect(buffer.readInt32BE(1)).toBeNull();
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

  it('copies exact bytes when consuming only part of a larger head chunk', () => {
    const buffer = new FrontendMessageBuffer();
    const first = frontendMessage(0x53, new Uint8Array(0));
    const second = frontendMessage(0x58, new Uint8Array(0));
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first, 0);
    combined.set(second, first.length);
    buffer.push(combined);
    const consumed = buffer.consume(first.length);
    expect(consumed).toEqual(first);
    expect(consumed.buffer).not.toBe(combined.buffer);
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
});
