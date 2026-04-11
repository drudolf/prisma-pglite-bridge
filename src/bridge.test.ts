import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGliteBridge } from './bridge.ts';

const { Client } = pg;

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
});
