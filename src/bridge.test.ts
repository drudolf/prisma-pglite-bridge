import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGliteBridge, stripIntermediateReadyForQuery } from './bridge.ts';

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
      Array.from({ length: 50 }, (_, i) =>
        pool.query('SELECT $1::int AS val', [i]),
      ),
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
    0x43, 0x00, 0x00, 0x00, 0x0f,
    0x49, 0x4e, 0x53, 0x45, 0x52, 0x54, 0x20, 0x30, 0x20, 0x31, 0x00,
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
      0x44, 0x00, 0x00, 0x00, 0x10, // D + length 16
      0x00, 0x01,                     // 1 field
      0x00, 0x00, 0x00, 0x06,         // field length 6
      0x5a, 0x00, 0x00, 0x00, 0x05, 0x49, // field data = RFQ bytes
    ]);
    const input = cat(dataRow, RFQ);
    // Should NOT strip — the RFQ-like bytes are inside the DataRow, not a standalone message
    expect(stripIntermediateReadyForQuery(input)).toEqual(input);
  });
});
