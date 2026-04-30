import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { createPGliteServer, type PGliteServer } from './create-pglite-server.ts';

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;

const buildPrelude = (length: number, code: number): Buffer => {
  const buf = Buffer.alloc(length);
  buf.writeInt32BE(length, 0);
  buf.writeInt32BE(code, 4);
  return buf;
};

describe('createPGliteServer', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      await fn?.();
    }
  });

  const startServer = async (): Promise<{ pglite: PGlite; server: PGliteServer }> => {
    const pglite = new PGlite();
    const server = await createPGliteServer({ pglite });
    cleanups.push(async () => {
      await server.close();
      await pglite.close();
    });
    return { pglite, server };
  };

  it('binds to an ephemeral port on loopback', async () => {
    const { server } = await startServer();
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`postgres://127.0.0.1:${server.port}/postgres`);
  });

  it('answers SELECT 1 over TCP via pg.Client', async () => {
    const { server } = await startServer();
    const client = new pg.Client({
      host: server.host,
      port: server.port,
      user: 'anyone',
      database: 'postgres',
    });
    await client.connect();
    try {
      const r = await client.query<{ one: number }>('SELECT 1::int AS one');
      expect(r.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('supports CREATE TABLE + INSERT + SELECT roundtrip', async () => {
    const { server } = await startServer();
    const client = new pg.Client({ host: server.host, port: server.port });
    await client.connect();
    try {
      await client.query('CREATE TABLE t (id int primary key, name text)');
      await client.query("INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b')");
      const r = await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM t ORDER BY id',
      );
      expect(r.rows).toEqual([
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ]);
    } finally {
      await client.end();
    }
  });

  it('serializes transactions across two concurrent clients', async () => {
    const { server } = await startServer();
    const a = new pg.Client({ host: server.host, port: server.port });
    const b = new pg.Client({ host: server.host, port: server.port });
    await a.connect();
    await b.connect();
    try {
      await a.query('CREATE TABLE counter (n int)');
      await a.query('INSERT INTO counter VALUES (0)');

      // A starts a transaction; B's update must wait until A commits.
      await a.query('BEGIN');
      await a.query('UPDATE counter SET n = n + 1');

      let bDone = false;
      const bWrite = b.query('UPDATE counter SET n = n + 10').then(() => {
        bDone = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bDone).toBe(false);

      await a.query('COMMIT');
      await bWrite;

      const r = await a.query<{ n: number }>('SELECT n FROM counter');
      expect(r.rows[0]?.n).toBe(11);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('rejects chained GSS+SSL preludes (coalesced and sequential) before StartupMessage', async () => {
    const { server } = await startServer();

    // Coalesced: both preludes arrive in one socket.write.
    const coalesced = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(server.port, server.host);
      socket.once('error', reject);
      let received = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= 2) {
          socket.removeListener('data', onData);
          socket.end();
          resolve(received.subarray(0, 2).toString('ascii'));
        }
      };
      socket.on('data', onData);
      socket.write(
        Buffer.concat([buildPrelude(8, GSSENC_REQUEST_CODE), buildPrelude(8, SSL_REQUEST_CODE)]),
      );
    });
    expect(coalesced).toBe('NN');

    // Sequential: GSS first, then SSL on a second socket.write — must also work.
    const sequential = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(server.port, server.host);
      socket.once('error', reject);
      let received = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= 2) {
          socket.removeListener('data', onData);
          socket.end();
          resolve(received.subarray(0, 2).toString('ascii'));
        }
      };
      socket.on('data', onData);
      socket.write(buildPrelude(8, GSSENC_REQUEST_CODE));
      setTimeout(() => socket.write(buildPrelude(8, SSL_REQUEST_CODE)), 30);
    });
    expect(sequential).toBe('NN');

    // After all those negotiations, a fresh client must still connect.
    const client = new pg.Client({ host: server.host, port: server.port });
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it("rejects SSLRequest with single 'N' byte then accepts plaintext", async () => {
    const { server } = await startServer();

    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket = net.createConnection(server.port, server.host);
      socket.once('error', reject);
      socket.once('data', (chunk: Buffer) => {
        socket.end();
        resolve(chunk);
      });
      socket.write(buildPrelude(8, SSL_REQUEST_CODE));
    });
    expect(reply.length).toBe(1);
    expect(reply.toString('ascii')).toBe('N');

    const client = new pg.Client({ host: server.host, port: server.port });
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('exposes a usable libpq query-form URL for IPv6 binds', async () => {
    const pglite = new PGlite();
    const server = await createPGliteServer({ pglite, host: '::1' });
    cleanups.push(async () => {
      await server.close();
      await pglite.close();
    });
    expect(server.host).toBe('::1');
    // Query-form, not authority-form: `pg-connection-string` keeps brackets in
    // `hostname` for `postgres://[::1]:port/...` and breaks DNS.
    expect(server.url).toBe(
      `postgres:///postgres?host=${encodeURIComponent('::1')}&port=${server.port}`,
    );

    const client = new pg.Client({ connectionString: server.url, database: 'postgres' });
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('listens on a Unix socket via `socketDir` and exposes a libpq-form URL', async () => {
    const sockDir = mkdtempSync(path.join(tmpdir(), 'pglite-sock-'));
    const pglite = new PGlite();
    const server = await createPGliteServer({ pglite, socketDir: sockDir });
    cleanups.push(async () => {
      await server.close();
      await pglite.close();
      rmSync(sockDir, { recursive: true, force: true });
    });

    expect(server.socketPath).toBe(path.join(sockDir, '.s.PGSQL.5432'));
    expect(server.host).toBe('');
    expect(server.port).toBe(5432);
    expect(server.url).toBe(`postgres:///postgres?host=${encodeURIComponent(sockDir)}&port=5432`);

    // Connect via the public URL contract — exercises the URL we returned.
    const client = new pg.Client({ connectionString: server.url, database: 'postgres' });
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('honors a custom socketPort suffix', async () => {
    const sockDir = mkdtempSync(path.join(tmpdir(), 'pglite-sock-'));
    const pglite = new PGlite();
    const server = await createPGliteServer({ pglite, socketDir: sockDir, socketPort: 5555 });
    cleanups.push(async () => {
      await server.close();
      await pglite.close();
      rmSync(sockDir, { recursive: true, force: true });
    });
    expect(server.socketPath).toBe(path.join(sockDir, '.s.PGSQL.5555'));
    expect(server.port).toBe(5555);
  });

  it('drops a CancelRequest by closing the socket cleanly', async () => {
    const { server } = await startServer();

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(server.port, server.host);
      socket.once('error', reject);
      socket.once('close', () => resolve());
      const cancel = buildPrelude(16, CANCEL_REQUEST_CODE);
      cancel.writeInt32BE(1234, 8); // pid
      cancel.writeInt32BE(5678, 12); // secret key
      socket.write(cancel);
    });
  });

  it('rolls back when client sends Terminate mid-transaction', async () => {
    // pg.Client.end() sends a normal Terminate ('X') message — exercises the
    // PGliteDuplex Terminate handler, not the server's socket-close cleanup.
    const { server } = await startServer();
    const a = new pg.Client({ host: server.host, port: server.port });
    await a.connect();
    await a.query('CREATE TABLE t (id int)');
    await a.query('BEGIN');
    await a.query('INSERT INTO t VALUES (1)');
    await a.end();

    const b = new pg.Client({ host: server.host, port: server.port });
    await b.connect();
    try {
      const r = await b.query<{ count: string }>('SELECT count(*)::text AS count FROM t');
      expect(r.rows[0]?.count).toBe('0');
    } finally {
      await b.end();
    }
  });

  it('rolls back on forced TCP disconnect mid-transaction', async () => {
    // Bypass pg.Client.end() (which would send Terminate) and destroy the
    // underlying socket so cleanup runs through PGliteDuplex._destroy.
    const { server } = await startServer();
    const a = new pg.Client({ host: server.host, port: server.port });
    await a.connect();
    await a.query('CREATE TABLE t (id int)');
    await a.query('BEGIN');
    await a.query('INSERT INTO t VALUES (1)');

    // biome-ignore lint/suspicious/noExplicitAny: pg internals
    const stream: net.Socket = (a as any).connection.stream;
    const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()));
    a.on('error', () => {}); // swallow ECONNRESET
    stream.destroy();
    await closed;

    const b = new pg.Client({ host: server.host, port: server.port });
    await b.connect();
    try {
      const r = await b.query<{ count: string }>('SELECT count(*)::text AS count FROM t');
      expect(r.rows[0]?.count).toBe('0');
    } finally {
      await b.end();
    }
  });

  it('drops queued queries from a forcibly disconnected waiter', async () => {
    // A holds the session lock in a transaction. B queues an INSERT that
    // blocks in SessionLock.acquire(). B disconnects forcibly. After A
    // commits, only A's row should be present — B's queued INSERT must not
    // run against the next bridge's session.
    const { server } = await startServer();
    const a = new pg.Client({ host: server.host, port: server.port });
    const b = new pg.Client({ host: server.host, port: server.port });
    await a.connect();
    await b.connect();

    await a.query('CREATE TABLE t (id int)');
    await a.query('BEGIN');
    await a.query('INSERT INTO t VALUES (1)');

    // Queue B's INSERT. It blocks waiting for A's lock.
    let bSettled: 'fulfilled' | 'rejected' | undefined;
    b.on('error', () => {}); // swallow ECONNRESET
    const bInsert = b.query('INSERT INTO t VALUES (2)').then(
      () => {
        bSettled = 'fulfilled';
      },
      () => {
        bSettled = 'rejected';
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bSettled).toBeUndefined();

    // Forcibly disconnect B mid-wait.
    // biome-ignore lint/suspicious/noExplicitAny: pg internals
    const bStream: net.Socket = (b as any).connection.stream;
    const bClosed = new Promise<void>((resolve) => bStream.once('close', () => resolve()));
    bStream.destroy();
    await bClosed;
    await bInsert;
    expect(bSettled).toBe('rejected');

    // A commits.  Then a fresh client checks the row count.
    await a.query('COMMIT');
    await a.end();

    const c = new pg.Client({ host: server.host, port: server.port });
    await c.connect();
    try {
      const r = await c.query<{ count: string }>('SELECT count(*)::text AS count FROM t');
      expect(r.rows[0]?.count).toBe('1');
    } finally {
      await c.end();
    }
  });

  it('close() resolves promptly while a client is still connected', async () => {
    const pglite = new PGlite();
    const server = await createPGliteServer({ pglite });
    const client = new pg.Client({ host: server.host, port: server.port });
    await client.connect();
    client.on('error', () => {}); // swallow ECONNRESET from forced close

    let pgliteClosed = false;
    try {
      await Promise.race([
        server.close(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('server.close() did not resolve in 2s')), 2000),
        ),
      ]);
    } finally {
      await client.end().catch(() => {});
      await pglite.close();
      pgliteClosed = true;
    }
    expect(pgliteClosed).toBe(true);
  });
});
