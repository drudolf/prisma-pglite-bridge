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
 *
 * The constructor is synchronous; the network bind is exposed as an
 * explicit async `listen()` (mirroring `net.Server`'s API) which resolves
 * to the connection URL. The caller-supplied PGlite must already be ready
 * (`await pglite.waitReady`) and not closed.
 *
 * ```typescript
 * const pglite = new PGlite();
 * await pglite.waitReady;
 * const server = new PGliteServer({ pglite });
 * const url = await server.listen();
 * console.log(url); // → postgres://postgres@127.0.0.1:54321/postgres
 * ```
 */
import net from 'node:net';
import nodePath from 'node:path';
import type { PGlite, PGliteInterface } from '@electric-sql/pglite';

import { PGliteDuplex } from './duplex/index.ts';
import type { SyncToFsMode } from './pool.ts';
import { SessionLock } from './utils/session-lock.ts';

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;
const PRELUDE_HEADER_BYTES = 8;
const DEFAULT_SOCKET_PORT = 5432;

const resolveSyncToFs = (
  pglite: PGlite | PGliteInterface,
  mode: SyncToFsMode | undefined,
): boolean => {
  if (mode === true || mode === false) return mode;
  if (pglite.dataDir === undefined) return false;
  /* v8 ignore next */
  if (pglite.dataDir === '') return false;
  if (pglite.dataDir.startsWith('memory://')) return false;
  return true;
};

export interface PGliteServerOptions {
  /**
   * PGlite instance to expose. Must be ready (`pglite.ready === true`) and
   * not closed. The caller owns its lifecycle — `close()` shuts the listener
   * and tears down per-connection bridges only.
   */
  pglite: PGlite | PGliteInterface;
  /** Bind host. Default `'127.0.0.1'` (loopback only). Ignored when `dataDir` is set. */
  host?: string;
  /**
   * In TCP mode: the listen port. Default `0` (ephemeral — read back from
   * the URL returned by `listen()`).
   *
   * In Unix-socket mode (when `dataDir` is set): the libpq port-suffix used
   * to build the socket filename `<dataDir>/.s.PGSQL.<port>`. Default `5432`.
   */
  port?: number;
  /**
   * If set, switches to Unix-socket mode. The server binds the
   * libpq-conventional path `<dataDir>/.s.PGSQL.<port>` so `psql` and
   * `pg.Client` can connect with just `host=<dataDir>`. Takes precedence
   * over `host`. The caller is responsible for the directory's writability
   * and access mode; `close()` does not remove the socket file, and
   * `listen()` will fail with `EADDRINUSE` if a stale socket remains —
   * unlink first.
   */
  dataDir?: string;
  /** Filesystem sync policy. See {@link SyncToFsMode}. Default `'auto'`. */
  syncToFs?: SyncToFsMode;
  /**
   * Username embedded in the connection URL returned by `listen()`.
   * Default `'postgres'`. PGlite ignores this — there is no authentication —
   * but Prisma 7's schema engine rejects URLs without a user (P1010), so a
   * value is always emitted.
   */
  user?: string;
}

type BridgedSocket = net.Socket & { duplex?: PGliteDuplex };

export class PGliteServer {
  readonly #options: PGliteServerOptions;
  readonly #server: net.Server;
  readonly #sessionLock = new SessionLock();
  readonly #sockets = new Set<BridgedSocket>();

  #connectionString: string | undefined;

  constructor(options: PGliteServerOptions) {
    if (!options.pglite.ready) {
      throw new Error(
        'PGliteServer requires a ready PGlite instance. ' +
          'Call `await pglite.waitReady` after `new PGlite(...)` before constructing the server.',
      );
    }
    if (options.pglite.closed) {
      throw new Error('PGliteServer requires an open PGlite instance; got a closed one.');
    }

    this.#options = options;
    this.#options.host ||= '127.0.0.1';
    this.#options.port ??= !this.#options.dataDir ? 0 : DEFAULT_SOCKET_PORT;
    this.#options.user ||= 'postgres';

    this.#server = net.createServer((socket) => this.#onConnection(socket));
  }

  listen = async (): Promise<string> => {
    if (this.#connectionString) return this.#connectionString;

    return await new Promise<string>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#server.once('error', onError);

      const user = encodeURIComponent(this.#options.user as string);

      // Socket
      if (this.#options.dataDir) {
        const { dataDir } = this.#options;

        this.#server.listen(nodePath.join(dataDir, `.s.PGSQL.${this.#options.port}`), () => {
          this.#server.removeListener('error', onError);
          this.#connectionString = `postgres://${user}@/postgres?host=${encodeURIComponent(dataDir)}&port=${this.#options.port}`;
          return resolve(this.#connectionString);
        });

        return;
      }

      // TCP
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.removeListener('error', onError);

        const { address, family, port } = this.#server.address() as net.AddressInfo;
        this.#connectionString =
          family === 'IPv6'
            ? `postgres://${user}@/postgres?host=${encodeURIComponent(address)}&port=${port}`
            : `postgres://${user}@${address}:${port}/postgres`;
        this.#options.port = port; // re-assign used port

        return resolve(this.#connectionString);
      });
    });
  };

  close = async (): Promise<void> => {
    const sockets = [...this.#sockets];
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
    await Promise.all(sockets.map(({ duplex }) => duplex?.onClose));
  };

  #initDuplex(socket: BridgedSocket): PGliteDuplex {
    socket.duplex = new PGliteDuplex(
      this.#options.pglite,
      this.#sessionLock,
      undefined,
      undefined,
      resolveSyncToFs(this.#options.pglite, this.#options.syncToFs),
    );
    socket.duplex.on('error', () => socket.destroy());
    socket.once('close', () => {
      const { duplex } = socket;
      if (duplex && !duplex.destroyed) duplex.destroy();
    });
    socket.pipe(socket.duplex).pipe(socket);
    return socket.duplex;
  }

  #onConnection(socket: BridgedSocket): void {
    socket.setNoDelay(true);
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    let buffer: Buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      // Drain SSL/GSS preludes; libpq may chain them before StartupMessage.
      while (buffer.length >= PRELUDE_HEADER_BYTES) {
        const len = buffer.readInt32BE(0);
        const code = buffer.readInt32BE(4);
        if (len === 8 && (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE)) {
          socket.write('N');
          buffer = buffer.subarray(8);
          continue;
        }
        break;
      }
      if (buffer.length < PRELUDE_HEADER_BYTES) return;

      const len = buffer.readInt32BE(0);
      const code = buffer.readInt32BE(4);

      if (len === 16 && code === CANCEL_REQUEST_CODE) {
        if (buffer.length < 16) return;
        socket.removeListener('data', onData);
        socket.end();
        return;
      }

      socket.removeListener('data', onData);

      // Hand over to duplex stream
      socket.pause();
      this.#initDuplex(socket).write(buffer);
      socket.resume();
    };

    socket.on('data', onData);
  }
}
