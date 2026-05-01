/**
 * TCP / Unix-socket server that exposes a PGlite instance to standard
 * PostgreSQL clients (`psql`, Prisma CLI shadow database, DBeaver, Studio,
 * etc.).
 *
 * Each accepted socket gets its own {@link PGliteDuplex}, all sharing one
 * {@link SessionLock} so transactions across connections serialize correctly.
 * SSL / GSS pre-negotiation is rejected with a single `N` byte so clients
 * fall back to plaintext; there is no authentication. Bind to loopback only
 * — this is a development tool, not a hardened endpoint.
 */
import net from 'node:net';
import nodePath from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { SyncToFsMode } from './create-pool.ts';
import { PGliteDuplex } from './duplex/index.ts';
import { SessionLock } from './utils/session-lock.ts';

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;
const PRELUDE_HEADER_BYTES = 8;
const DEFAULT_SOCKET_PORT = 5432;

export interface CreatePGliteServerOptions {
  /**
   * PGlite instance to expose. Caller owns its lifecycle — `close()` shuts
   * the listener and tears down per-connection bridges only.
   */
  pglite: PGlite;
  /** Bind host. Default `'127.0.0.1'` (loopback only). Ignored when `socketDir` is set. */
  host?: string;
  /** Listen port. Default `0` (ephemeral — read back via `server.port`). Ignored when `socketDir` is set. */
  port?: number;
  /**
   * Unix domain socket directory. If set, takes precedence over `host`/`port`.
   * The library binds the libpq-conventional path
   * `<socketDir>/.s.PGSQL.<socketPort>` so `psql` and `pg.Client` connect with
   * just `host=<socketDir>`.
   *
   * The caller is responsible for the directory's writability and access
   * mode: `close()` does not remove the socket file, and `listen()` will
   * fail with `EADDRINUSE` if the socket exists from a previous crashed
   * process — unlink first. Since the server has no auth, place the
   * directory somewhere only you can write to (e.g., `fs.mkdtemp` defaults
   * to `0700`).
   */
  socketDir?: string;
  /** Port suffix for the Unix socket file. Default `5432`. Ignored unless `socketDir` is set. */
  socketPort?: number;
  /** Filesystem sync policy. See {@link SyncToFsMode}. Default `'auto'`. */
  syncToFs?: SyncToFsMode;
}

export interface PGliteServer {
  /**
   * Connection URL. For IPv4 TCP: `postgres://host:port/postgres`.
   * For Unix sockets and IPv6 TCP: libpq query-form
   * `postgres:///postgres?host=<host>&port=<port>`. IPv6 uses query-form
   * because `pg-connection-string` mishandles bracketed `[::1]` hostnames.
   * Safe to pass to `pg.Client({ connectionString })` in all cases.
   */
  url: string;
  /** Bound TCP port for TCP servers, or `socketPort` for Unix-socket servers. */
  port: number;
  /** Bound TCP host, or empty string for Unix-socket servers. */
  host: string;
  /** Bound Unix socket file (`<socketDir>/.s.PGSQL.<socketPort>`), or `undefined` for TCP servers. */
  socketPath?: string;
  /** Stop accepting, force-close active sockets, await per-socket cleanup. Does not close PGlite. */
  close: () => Promise<void>;
}

const resolveSyncToFs = (pglite: PGlite, mode: SyncToFsMode | undefined): boolean => {
  if (mode === true || mode === false) return mode;
  const dataDir = pglite.dataDir;
  if (dataDir === undefined) return false;
  // PGlite construction rejects an empty-string dataDir, so this branch is
  // defensive — keep the guard, exclude it from coverage.
  /* v8 ignore next */
  if (dataDir === '') return false;
  if (dataDir.startsWith('memory://')) return false;
  return true;
};

/**
 * Start a server that serves the PGlite wire protocol over TCP or a Unix
 * socket.
 *
 * ```ts
 * const server = await createPGliteServer({ pglite });
 * // server.url === 'postgres://127.0.0.1:54321/postgres'
 *
 * const unix = await createPGliteServer({ pglite, socketDir: '/tmp/pgl' });
 * // unix.url === 'postgres:///postgres?host=%2Ftmp%2Fpgl&port=5432'
 * ```
 */
export const createPGliteServer = async (
  options: CreatePGliteServerOptions,
): Promise<PGliteServer> => {
  const { pglite, socketDir, host = '127.0.0.1', port = 0 } = options;
  const socketPort = options.socketPort ?? DEFAULT_SOCKET_PORT;
  const syncToFs = resolveSyncToFs(pglite, options.syncToFs);

  await pglite.waitReady;

  const sessionLock = new SessionLock();
  const activeSockets = new Set<net.Socket>();
  const activeDuplexes = new Set<PGliteDuplex>();

  const startBridge = (socket: net.Socket, initial: Buffer): void => {
    const duplex = new PGliteDuplex(pglite, sessionLock, undefined, undefined, syncToFs);
    // Rollback-on-disconnect lives in PGliteDuplex._final/_destroy — letting
    // the duplex own its session-lock teardown avoids races with this handler.
    activeDuplexes.add(duplex);
    duplex.once('close', () => activeDuplexes.delete(duplex));
    // PGliteDuplex never emits 'error' under normal flow — the handler is a
    // safety net that tears down the socket if the duplex ever does.
    /* v8 ignore next */
    duplex.on('error', () => socket.destroy());
    // socket.pipe forwards 'end' but not 'close', so a forced socket.destroy()
    // never reaches the duplex. We must drive teardown ourselves. Use destroy()
    // (not end()) so duplexes blocked in SessionLock.acquire() are cancelled
    // synchronously rather than waiting for their queued query to drain after
    // the lock frees — otherwise a disconnected client's query would still
    // execute against the next bridge's session.
    socket.once('close', () => {
      if (!duplex.destroyed) duplex.destroy();
    });
    socket.pipe(duplex).pipe(socket);
    // startBridge is only called from the StartupMessage path, where we've
    // already validated `preludeBuf.length >= PRELUDE_HEADER_BYTES`. The guard
    // is defensive — the empty-initial branch is unreachable in practice.
    /* v8 ignore next */
    if (initial.length > 0) duplex.write(initial);
  };

  const handleConnection = (socket: net.Socket): void => {
    socket.setNoDelay(true);
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    // Raw socket errors (e.g., abrupt RST while idle) are rare; the handler
    // ensures we tear down rather than letting Node throw an uncaught error.
    /* v8 ignore next */
    socket.on('error', () => socket.destroy());

    let preludeBuf: Buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      preludeBuf = preludeBuf.length === 0 ? chunk : Buffer.concat([preludeBuf, chunk]);

      // Stay in pre-startup mode across multiple negotiations. libpq with
      // `gssencmode=prefer sslmode=prefer` chains GSSENCRequest then SSLRequest
      // before sending StartupMessage, possibly coalesced in one buffer.
      while (preludeBuf.length >= PRELUDE_HEADER_BYTES) {
        const len = preludeBuf.readInt32BE(0);
        const code = preludeBuf.readInt32BE(4);

        if (len === 8 && (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE)) {
          socket.write('N');
          preludeBuf = preludeBuf.subarray(8);
          continue;
        }

        if (len === 16 && code === CANCEL_REQUEST_CODE) {
          // Wait for the full 16-byte frame before closing — even though we
          // drop the request, parsing on a partial buffer would be wrong.
          if (preludeBuf.length < 16) return;
          socket.removeListener('data', onData);
          socket.end();
          return;
        }

        // Direct StartupMessage. Hand off whatever is buffered to the duplex.
        socket.removeListener('data', onData);
        socket.pause();
        startBridge(socket, preludeBuf);
        socket.resume();
        return;
      }
    };

    socket.on('data', onData);
  };

  const server = net.createServer(handleConnection);

  const socketPath =
    socketDir === undefined ? undefined : nodePath.join(socketDir, `.s.PGSQL.${socketPort}`);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    if (socketPath !== undefined) {
      server.listen(socketPath, onListening);
    } else {
      server.listen(port, host, onListening);
    }
  });

  const close = async (): Promise<void> => {
    const closed = new Promise<void>((resolve, reject) => {
      // server.close() only errors when the server isn't running — `close` is
      // not exposed before listen() resolves, so the err branch is unreachable.
      /* v8 ignore next */
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const duplexClosings = [...activeDuplexes].map(
      (duplex) =>
        new Promise<void>((resolve) => {
          duplex.once('close', () => resolve());
        }),
    );
    for (const socket of activeSockets) {
      socket.destroy();
    }
    await closed;
    // Wait for any in-flight rollback / lock release inside _final to finish
    // before we hand control back to the caller (who likely closes PGlite next).
    await Promise.all(duplexClosings);
  };

  if (socketPath !== undefined) {
    return {
      url: `postgres:///postgres?host=${encodeURIComponent(socketDir as string)}&port=${socketPort}`,
      port: socketPort,
      host: '',
      socketPath,
      close,
    };
  }

  // Non-null after a successful TCP listen() — see net.Server#address docs.
  const address = server.address() as net.AddressInfo;
  // IPv6 uses libpq query-form because `pg-connection-string` keeps brackets in
  // `hostname` when parsing `postgres://[::1]:port/...`, which then breaks the
  // DNS lookup. Query-form sidesteps URL hostname parsing entirely.
  const url =
    address.family === 'IPv6'
      ? `postgres:///postgres?host=${encodeURIComponent(address.address)}&port=${address.port}`
      : `postgres://${address.address}:${address.port}/postgres`;
  return {
    url,
    port: address.port,
    host: address.address,
    close,
  };
};
