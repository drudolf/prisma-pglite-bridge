import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockPGlite } from '../__tests__/mocks.ts';
import { setupPGlite } from '../__tests__/pglite.ts';
import { PGliteServer, type PGliteServerOptions } from './index.ts';

// One shared PGlite for the ~19 tests that only need a caller-supplied instance
// with no special dataDir/fs/ownership semantics. Saves ~1s WASM cold-boot per
// test; the server lifecycle (cheap) is still created+closed per test.
// Tests that assert ownership, use a custom dataDir/URI, need mocks, or test
// bind-in-use / IPv6 / Unix socket keep their own dedicated instances below.
// reset: false — this file resets in the afterEach below (after the server
// cleanups drain), not in setupPGlite's default beforeEach.
const sharedDb = await setupPGlite({ reset: false });

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;

const buildPrelude = (length: number, code: number): Buffer => {
  const buf = Buffer.alloc(length);
  buf.writeInt32BE(length, 0);
  buf.writeInt32BE(code, 4);
  return buf;
};

const tcpConnect = (url: string): net.Socket => {
  const u = new URL(url);
  return net.createConnection(Number(u.port), u.hostname);
};

const readFirstNBytes = (socket: net.Socket, n: number): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    socket.once('error', reject);
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= n) {
        socket.removeListener('data', onData);
        socket.end();
        resolve(received.subarray(0, n));
      }
    };
    socket.on('data', onData);
  });

describe('PGliteServer', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      await fn?.();
    }
    // Reset the shared PGlite between tests. The server is already closed by
    // the time cleanups drain, so this query serializes cleanly. ROLLBACK is a
    // no-op when idle; DROP TABLE errors are NOT swallowed — a failure here
    // means the prior test left the shared instance dirty.
    await sharedDb.query('ROLLBACK').catch(() => {});
    const { rows } = await sharedDb.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'",
    );
    for (const { t } of rows) {
      await sharedDb.exec(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
    await sharedDb.exec('DISCARD ALL');
  });

  const db = new PGlite();

  const startServer = async (
    options: Partial<PGliteServerOptions> = {},
  ): Promise<{
    pglite: PGlite | PGliteInterface;
    server: PGliteServer;
    connectionString: string;
  }> => {
    const pglite = options.pglite ?? (await db.clone());
    await pglite.waitReady;
    const server = new PGliteServer({ ...options, pglite });
    const connectionString = await server.listen();
    cleanups.push(async () => {
      await server.close();
      if (!options.pglite) await pglite.close();
    });
    return { pglite, server, connectionString };
  };

  it('listen() throws when the PGlite instance is closed', async () => {
    const closed = createMockPGlite({ closed: true });
    const server = new PGliteServer({ pglite: closed });
    await expect(server.listen()).rejects.toThrow(/requires an open PGlite instance/);
  });

  it('listen() is idempotent and returns the same address', async () => {
    const { server, connectionString } = await startServer({ pglite: sharedDb });
    expect(await server.listen()).toBe(connectionString);
    expect(await server.listen()).toBe(connectionString);
  });

  it('binds with custom user in connection string', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb, user: 'test' });
    expect(url).toMatch(/postgres:\/\/test@127\.0\.0\.1:[0-9]+\/postgres/);
  });

  it('binds to an ephemeral port on loopback', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });
    expect(url).toMatch(/postgres:\/\/postgres@127\.0\.0\.1:[0-9]+\/postgres/);
  });

  it('answers SELECT 1 over TCP via pg.Client', async () => {
    const { connectionString } = await startServer({ pglite: sharedDb });
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const r = await client.query<{ one: number }>('SELECT 1::int AS one');
      expect(r.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('supports CREATE TABLE + INSERT + SELECT roundtrip', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });
    const client = new pg.Client(url);
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

  it('serves system-catalog "char" columns with their real oid 18 (no RowDescription rewrite)', async () => {
    // Native clients (e.g. the Prisma CLI schema engine) need the real oid 18;
    // the 18→25 widening exists only for @prisma/adapter-pg. The server path
    // must create its duplexes with the rewrite disabled — on PostgreSQL 18
    // a rewritten oid breaks `prisma db pull`.
    const { connectionString: url } = await startServer({ pglite: sharedDb });
    const client = new pg.Client(url);
    await client.connect();
    try {
      const r = await client.query('SELECT relkind FROM pg_class LIMIT 1');
      expect(r.rows).toHaveLength(1);
      expect(r.fields[0]?.dataTypeID).toBe(18);
    } finally {
      await client.end();
    }
  });

  it('serializes transactions across two concurrent clients', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });
    const a = new pg.Client(url);
    const b = new pg.Client(url);
    await a.connect();
    await b.connect();
    try {
      await a.query('CREATE TABLE counter (n int)');
      await a.query('INSERT INTO counter VALUES (0)');

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
    const { connectionString: url } = await startServer({ pglite: sharedDb });

    const coalescedSocket = tcpConnect(url);
    const coalescedBytes = readFirstNBytes(coalescedSocket, 2);
    coalescedSocket.write(
      Buffer.concat([buildPrelude(8, GSSENC_REQUEST_CODE), buildPrelude(8, SSL_REQUEST_CODE)]),
    );
    expect((await coalescedBytes).toString('ascii')).toBe('NN');

    const sequentialSocket = tcpConnect(url);
    const sequentialBytes = readFirstNBytes(sequentialSocket, 2);
    sequentialSocket.write(buildPrelude(8, GSSENC_REQUEST_CODE));
    setTimeout(() => sequentialSocket.write(buildPrelude(8, SSL_REQUEST_CODE)), 30);
    expect((await sequentialBytes).toString('ascii')).toBe('NN');

    const client = new pg.Client(url);
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it("rejects SSLRequest with single 'N' byte then accepts plaintext", async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });

    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket = tcpConnect(url);
      socket.once('error', reject);
      socket.once('data', (chunk: Buffer) => {
        socket.end();
        resolve(chunk);
      });
      socket.write(buildPrelude(8, SSL_REQUEST_CODE));
    });
    expect(reply.length).toBe(1);
    expect(reply.toString('ascii')).toBe('N');

    const client = new pg.Client(url);
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('exposes a usable libpq query-form URL for IPv6 binds', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb, host: '::1' });
    expect(url).toMatch(
      new RegExp(`^postgres://postgres@/postgres\\?host=${encodeURIComponent('::1')}&port=\\d+$`),
    );

    const client = new pg.Client({ connectionString: url, database: 'postgres' });
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('listens on a Unix socket via `dataDir` and exposes a libpq-form URL', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pglite-sock-'));
    const { connectionString: url } = await startServer({ dataDir });
    cleanups.push(async () => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    expect(url).toBe(`postgres://postgres@/postgres?host=${encodeURIComponent(dataDir)}&port=5432`);

    const client = new pg.Client({ connectionString: url, database: 'postgres' });
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('honors a custom socket-port suffix via `port`', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pglite-sock-'));
    const { connectionString: url } = await startServer({ dataDir, port: 5555 });
    cleanups.push(async () => {
      rmSync(dataDir, { recursive: true, force: true });
    });
    expect(url).toBe(`postgres://postgres@/postgres?host=${encodeURIComponent(dataDir)}&port=5555`);
  });

  it('drops a CancelRequest by closing the socket cleanly', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });

    await new Promise<void>((resolve, reject) => {
      const socket = tcpConnect(url);
      socket.once('error', reject);
      socket.once('close', () => resolve());
      const cancel = buildPrelude(16, CANCEL_REQUEST_CODE);
      cancel.writeInt32BE(1234, 8);
      cancel.writeInt32BE(5678, 12);
      socket.write(cancel);
    });
  });

  it('rolls back when client sends Terminate mid-transaction', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });
    const a = new pg.Client(url);
    await a.connect();
    await a.query('CREATE TABLE t (id int)');
    await a.query('BEGIN');
    await a.query('INSERT INTO t VALUES (1)');
    await a.end();

    const b = new pg.Client(url);
    await b.connect();
    try {
      const r = await b.query<{ count: string }>('SELECT count(*)::text AS count FROM t');
      expect(r.rows[0]?.count).toBe('0');
    } finally {
      await b.end();
    }
  });

  it('rolls back on forced TCP disconnect mid-transaction', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });
    const a = new pg.Client(url);
    await a.connect();
    await a.query('CREATE TABLE t (id int)');
    await a.query('BEGIN');
    await a.query('INSERT INTO t VALUES (1)');

    // biome-ignore lint/suspicious/noExplicitAny: pg internals
    const stream: net.Socket = (a as any).connection.stream;
    const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()));
    a.on('error', () => {});
    stream.destroy();
    await closed;

    const b = new pg.Client(url);
    await b.connect();
    try {
      const r = await b.query<{ count: string }>('SELECT count(*)::text AS count FROM t');
      expect(r.rows[0]?.count).toBe('0');
    } finally {
      await b.end();
    }
  });

  it('drops queued queries from a forcibly disconnected waiter', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });
    const a = new pg.Client(url);
    const b = new pg.Client(url);
    await a.connect();
    await b.connect();

    await a.query('CREATE TABLE t (id int)');
    await a.query('BEGIN');
    await a.query('INSERT INTO t VALUES (1)');

    let bSettled: 'fulfilled' | 'rejected' | undefined;
    b.on('error', () => {});
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

    // biome-ignore lint/suspicious/noExplicitAny: pg internals
    const bStream: net.Socket = (b as any).connection.stream;
    const bClosed = new Promise<void>((resolve) => bStream.once('close', () => resolve()));
    bStream.destroy();
    await bClosed;
    await bInsert;
    expect(bSettled).toBe('rejected');

    await a.query('COMMIT');
    await a.end();

    const c = new pg.Client(url);
    await c.connect();
    try {
      const r = await c.query<{ count: string }>('SELECT count(*)::text AS count FROM t');
      expect(r.rows[0]?.count).toBe('1');
    } finally {
      await c.end();
    }
  });

  it('honors an explicit syncToFs override (true)', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb, syncToFs: true });
    const client = new pg.Client(url);
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('honors an explicit syncToFs override (false)', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb, syncToFs: false });
    const client = new pg.Client(url);
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('infers syncToFs=true from an on-disk dataDir', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pglite-disk-'));
    const pglite = new PGlite(dataDir);
    const { connectionString: url } = await startServer({ pglite });
    cleanups.push(async () => {
      rmSync(dataDir, { recursive: true, force: true });
    });
    const client = new pg.Client(url);
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('infers syncToFs from a memory:// dataDir', async () => {
    const pglite = new PGlite('memory://test');
    const { connectionString: url } = await startServer({ pglite });
    const client = new pg.Client(url);
    await client.connect();
    try {
      const r = await client.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('drops a CancelRequest delivered as two partial chunks', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });

    await new Promise<void>((resolve, reject) => {
      const socket = tcpConnect(url);
      socket.once('error', reject);
      socket.once('close', () => resolve());
      socket.write(buildPrelude(16, CANCEL_REQUEST_CODE).subarray(0, 8));
      setTimeout(() => {
        const tail = Buffer.alloc(8);
        tail.writeInt32BE(1234, 0);
        tail.writeInt32BE(5678, 4);
        socket.write(tail);
      }, 30);
    });
  });

  it('handles an SSLRequest split across two TCP chunks', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });

    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket = tcpConnect(url);
      socket.once('error', reject);
      socket.once('data', (chunk: Buffer) => {
        socket.end();
        resolve(chunk);
      });
      const prelude = buildPrelude(8, SSL_REQUEST_CODE);
      socket.write(prelude.subarray(0, 4));
      setTimeout(() => socket.write(prelude.subarray(4)), 30);
    });
    expect(reply.toString('ascii')).toBe('N');
  });

  it('rejects when the bind target is already in use', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pglite-busy-'));
    const pgliteA = new PGlite();
    const pgliteB = new PGlite();
    await pgliteA.waitReady;
    await pgliteB.waitReady;
    const a = new PGliteServer({ pglite: pgliteA, dataDir });
    await a.listen();
    cleanups.push(async () => {
      await a.close();
      await pgliteB.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const b = new PGliteServer({ pglite: pgliteB, dataDir });
    await expect(b.listen()).rejects.toThrow(/EADDRINUSE/);
  });

  it('keeps serving after a forced client RST (server-side ECONNRESET)', async () => {
    const { connectionString: url } = await startServer({ pglite: sharedDb });
    const a = new pg.Client(url);
    await a.connect();
    a.on('error', () => {});

    // biome-ignore lint/suspicious/noExplicitAny: pg internals
    const stream: net.Socket = (a as any).connection.stream;
    const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()));
    stream.resetAndDestroy();
    await closed;

    const b = new pg.Client(url);
    await b.connect();
    try {
      const r = await b.query<{ ok: number }>('SELECT 1::int AS ok');
      expect(r.rows).toEqual([{ ok: 1 }]);
    } finally {
      await b.end();
    }
  });

  it("destroys the socket when the duplex emits 'error'", async () => {
    // Fake PGlite whose execProtocolRawStream throws — drain catches, fires
    // the _write callback with an error → Node emits 'error' on the duplex →
    // server's handler destroys the socket.
    const pglite = createMockPGlite({
      execProtocolRawStream: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    });

    const server = new PGliteServer({ pglite });
    const url = await server.listen();
    cleanups.push(async () => {
      await server.close();
    });

    await new Promise<void>((resolve, reject) => {
      const socket = tcpConnect(url);
      const timer = setTimeout(() => reject(new Error('socket did not close')), 5000);
      socket.on('error', () => {});
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      // Minimal startup message: len=8, protocol 3.0 (196608).
      const buf = Buffer.alloc(8);
      buf.writeInt32BE(8, 0);
      buf.writeInt32BE(196608, 4);
      socket.write(buf);
    });
  });

  it('close() closes the internally-created PGlite (server owns it)', async () => {
    const server = new PGliteServer();
    await server.listen();
    await server.close();
    expect(server.pglite.closed).toBe(true);
  });

  it('close() leaves a caller-supplied PGlite open (caller owns it)', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const server = new PGliteServer({ pglite });
    await server.listen();
    try {
      await server.close();
      expect(pglite.closed).toBe(false);
    } finally {
      await pglite.close();
    }
  });

  it('close() resolves promptly while a client is still connected', async () => {
    const server = new PGliteServer();
    const url = await server.listen();
    const client = new pg.Client(url);
    await client.connect();
    client.on('error', () => {});

    await Promise.race([
      server.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('server.close() did not resolve in 2s')), 2000),
      ),
    ]);
    await client.end().catch(() => {});
    expect(server.pglite.closed).toBe(true);
  });

  describe('lifecycle idempotency', () => {
    it('close() resolves when called a second time after a successful close', async () => {
      const pglite = await db.clone();
      await pglite.waitReady;
      const server = new PGliteServer({ pglite });
      cleanups.push(async () => {
        await pglite.close();
      });
      await server.listen();

      await server.close();
      await expect(server.close()).resolves.toBeUndefined();
    });

    it('close() before listen() resolves cleanly', async () => {
      const pglite = await db.clone();
      await pglite.waitReady;
      const server = new PGliteServer({ pglite });
      cleanups.push(async () => {
        await pglite.close();
      });

      await expect(server.close()).resolves.toBeUndefined();
    });

    it('listen() after close() rejects instead of returning the stale URL', async () => {
      const pglite = await db.clone();
      await pglite.waitReady;
      const server = new PGliteServer({ pglite });
      cleanups.push(async () => {
        await pglite.close();
      });
      await server.listen();
      await server.close();

      await expect(server.listen()).rejects.toThrow(/closed/);
    });

    it('close() during a pending listen() resolves and tears down the bound listener', async () => {
      const pglite = await db.clone();
      await pglite.waitReady;
      const server = new PGliteServer({ pglite });

      const pendingListen = server.listen();
      const pendingClose = server.close();
      cleanups.push(async () => {
        // Today close() silently cancels the mid-bind listen (Node drops the
        // dns-lookup continuation), so pendingListen may never settle —
        // don't block cleanup on it.
        await Promise.race([
          pendingListen.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
        await server.close().catch(() => {});
        await pglite.close();
      });

      await expect(pendingClose).resolves.toBeUndefined();

      // close() awaits the in-flight bind before tearing down, so listen()
      // settles either way; a resolved URL is acceptable — but nothing may
      // be listening behind it afterwards.
      const url = await pendingListen.catch(() => undefined);
      if (url === undefined) return;
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = tcpConnect(url);
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', reject);
        }),
      ).rejects.toThrow(/ECONNREFUSED/);
    });

    it('a failed listen() stays retryable — bind errors are not memoized', async () => {
      const pglite = await db.clone();
      await pglite.waitReady;

      // Occupy an ephemeral port with a plain TCP server.
      const blocker = net.createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(0, '127.0.0.1', () => resolve());
      });
      const { port } = blocker.address() as net.AddressInfo;

      const server = new PGliteServer({ pglite, port });
      cleanups.push(async () => {
        await server.close().catch(() => {});
        await pglite.close();
        // Swallow ERR_SERVER_NOT_RUNNING when the test already closed it.
        await new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        });
      });

      await expect(server.listen()).rejects.toThrow(/EADDRINUSE/);

      // Free the port, then retry on the same server instance.
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()));
      });

      const url = await server.listen();
      expect(url).toBe(`postgres://postgres@127.0.0.1:${port}/postgres`);
    });

    it('close() during a failing bind resolves and swallows the bind error', async () => {
      const pglite = await db.clone();
      await pglite.waitReady;

      const blocker = net.createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(0, '127.0.0.1', () => resolve());
      });
      const { port } = blocker.address() as net.AddressInfo;

      const server = new PGliteServer({ pglite, port });
      cleanups.push(async () => {
        await server.close().catch(() => {});
        await pglite.close();
        await new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        });
      });

      // The bind is doomed (EADDRINUSE); close() must wait it out and
      // resolve rather than reject or leak the pending listen.
      const pending = server.listen();
      await expect(server.close()).resolves.toBeUndefined();
      await expect(pending).rejects.toThrow(/EADDRINUSE/);
    });
  });
});
