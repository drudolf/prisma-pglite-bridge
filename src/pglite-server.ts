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
 * explicit async `listen()` (mirroring `net.Server`'s API) which awaits
 * `pglite.waitReady` internally and resolves to the connection URL.
 * The caller-supplied PGlite must not be closed.
 *
 * ```typescript
 * const server = new PGliteServer({ pglite: new PGlite() });
 * const url = await server.listen();
 * console.log(url); // → postgres://postgres@127.0.0.1:54321/postgres
 * ```
 */
import net from 'node:net';
import nodePath from 'node:path';
import type { PGlite, PGliteInterface } from '@electric-sql/pglite';

import { PGliteDuplex } from './duplex/index.ts';
import { resolveSyncToFs, type SyncToFsMode } from './utils/resolve-sync-to-fs.ts';
import { SessionLock } from './utils/session-lock.ts';

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;
const PRELUDE_HEADER_BYTES = 8;
const DEFAULT_SOCKET_PORT = 5432;

type RequiredBy<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

export interface PGliteServerOptions {
  /**
   * PGlite instance to expose. Must not be closed; `listen()` awaits
   * `pglite.waitReady` internally, so it does not have to be ready at
   * construction time. The caller owns its lifecycle — `close()` shuts
   * the listener and tears down per-connection bridges only.
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
   * Maximum milliseconds to wait for the PGlite instance to become ready
   * before each bridge operation. Defaults to no timeout (waits indefinitely).
   */
  timeout?: number;
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
  /**
   * The caller-supplied PGlite instance this server fronts. Exposed so
   * scripts can reach `pglite.dataDir`, `pglite.waitReady`, and pass
   * the same handle to helpers like {@link pushMigrations} without
   * threading a separate variable.
   */
  readonly pglite: PGlite | PGliteInterface;

  readonly #options: RequiredBy<Omit<PGliteServerOptions, 'pglite'>, 'host' | 'port' | 'user'>;
  readonly #server: net.Server;
  readonly #sessionLock = new SessionLock();
  readonly #sockets = new Set<BridgedSocket>();

  #connectionString: string | undefined;

  constructor(options: PGliteServerOptions) {
    const { pglite, ...rest } = options;

    this.pglite = pglite;
    this.#options = {
      ...rest,
      host: rest.host || '127.0.0.1',
      port: rest.port ?? (!rest.dataDir ? 0 : DEFAULT_SOCKET_PORT),
      user: rest.user ? encodeURIComponent(rest.user) : 'postgres',
    };
    this.#server = net.createServer((socket) => this.#onConnection(socket));
  }

  listen = async (): Promise<string> => {
    if (this.#connectionString) return this.#connectionString;
    if (this.pglite.closed) {
      throw new Error('PGliteServer requires an open PGlite instance; got a closed one.');
    }

    return new Promise<string>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#server.once('error', onError);

      // Socket
      if (this.#options.dataDir) {
        const { dataDir, port, user } = this.#options;

        this.#server.listen(nodePath.join(dataDir, `.s.PGSQL.${port}`), () => {
          this.#server.removeListener('error', onError);
          this.#connectionString = `postgres://${user}@/postgres?host=${encodeURIComponent(dataDir)}&port=${port}`;
          return resolve(this.#connectionString);
        });

        return;
      }

      // TCP
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.removeListener('error', onError);

        const { user } = this.#options;
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
    socket.duplex = new PGliteDuplex(this.pglite, {
      sessionLock: this.#sessionLock,
      timeout: this.#options.timeout,
      syncToFs: resolveSyncToFs(this.pglite, this.#options.syncToFs),
    });
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
