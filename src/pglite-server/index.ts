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
 * **Ownership:** When no `pglite` option is supplied the server creates its
 * own in-memory `PGlite` instance and owns it — `close()` shuts down the
 * listener _and_ the PGlite instance. When you supply a `pglite` the server
 * treats it as caller-owned and `close()` leaves it open.
 *
 * The constructor is synchronous; the network bind is exposed as an
 * explicit async `listen()` (mirroring `net.Server`'s API) which awaits
 * `pglite.waitReady` internally and resolves to the connection URL.
 *
 * ```typescript
 * // Server creates and owns its own in-memory PGlite:
 * const server = new PGliteServer();
 * const url = await server.listen();
 * console.log(url); // → postgres://postgres@127.0.0.1:54321/postgres
 * await server.close(); // closes listener + pglite (server owns it)
 *
 * // Caller-supplied PGlite — caller owns the lifecycle:
 * import { PGlite } from '@electric-sql/pglite';
 * const pglite = new PGlite();
 * const server = new PGliteServer({ pglite });
 * await server.close(); // closes listener only; pglite stays open
 * await pglite.close(); // caller is responsible
 * ```
 */
import net from 'node:net';
import nodePath from 'node:path';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';

import { PGliteDuplex } from '../duplex';
import { PgBridgeError } from '../errors.ts';
import { SnapshotManager } from '../pglite-bridge/snapshot-manager.ts';
import { resolveSyncToFs, type SyncToFsMode } from '../utils/resolve-sync-to-fs.ts';
import { SessionLock } from '../utils/session-lock.ts';

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;
const PRELUDE_HEADER_BYTES = 8;
const DEFAULT_SOCKET_PORT = 5432;

type RequiredBy<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

export interface PGliteServerOptions {
  /**
   * PGlite instance to expose. When omitted the server creates its own
   * in-memory `PGlite` and owns its lifecycle — `close()` shuts it down.
   * When provided the caller owns the lifecycle — `close()` leaves it open.
   *
   * `listen()` awaits `pglite.waitReady` internally, so the instance does
   * not have to be ready at construction time.
   */
  pglite?: PGlite | PGliteInterface;
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

/** Options for {@link PGliteServer.resetDb}, {@link PGliteServer.snapshotDb}, and {@link PGliteServer.resetSnapshot}. */
export interface ServerSessionOptions {
  /**
   * Upper bound on waiting for a running statement to finish, in
   * milliseconds. Default 5000. `0` (and any negative value, which Node
   * clamps to `0`) means "do not wait": the call throws `SERVER_NOT_IDLE`
   * unless the session is free right now.
   */
  timeoutMs?: number;
}

const DEFAULT_SESSION_TIMEOUT_MS = 5_000;

const notIdle = (method: string, detail: string): PgBridgeError =>
  new PgBridgeError('SERVER_NOT_IDLE', `${method}() ${detail}`);

const openTransactionsDetail = (open: number): string =>
  `requires no open transaction on any connection; got ${open}. ` +
  'Finish the request (COMMIT or ROLLBACK) before calling.';

export class PGliteServer {
  /**
   * The PGlite instance this server fronts. Created internally when no
   * `pglite` option was supplied; otherwise the caller-supplied instance.
   * Exposed so scripts can reach `pglite.dataDir`, `pglite.waitReady`, and
   * pass the same handle to helpers like {@link pushMigrations} without
   * threading a separate variable.
   */
  readonly pglite: PGlite | PGliteInterface;

  readonly #options: RequiredBy<Omit<PGliteServerOptions, 'pglite'>, 'host' | 'port' | 'user'>;
  readonly #server: net.Server;
  readonly #sessionLock = new SessionLock();
  readonly #sockets = new Set<BridgedSocket>();
  readonly #ownsPglite: boolean;
  readonly #snapshot: SnapshotManager;
  /** Lock ids of `resetDb`/`snapshotDb`/`resetSnapshot` calls still waiting
   *  for the session; `close()` cancels them. */
  readonly #sessionWaiters = new Set<symbol>();
  /** Snapshot operations that hold the session; `close()` drains them. */
  readonly #sessionOps = new Set<Promise<unknown>>();

  /** In-flight or completed bind; memoizes repeat `listen()` calls and lets
   *  `close()` wait out a still-binding listener. Cleared on bind failure so
   *  the documented EADDRINUSE unlink-and-retry flow keeps working. */
  #listening: Promise<string> | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: PGliteServerOptions = {}) {
    const { pglite, ...rest } = options;

    this.#ownsPglite = !pglite;
    this.pglite = pglite ?? new PGlite();
    this.#snapshot = new SnapshotManager(this.pglite);
    this.#options = {
      ...rest,
      host: rest.host || '127.0.0.1',
      port: rest.port ?? (!rest.dataDir ? 0 : DEFAULT_SOCKET_PORT),
      user: rest.user ? encodeURIComponent(rest.user) : 'postgres',
    };
    this.#server = net.createServer((socket) => {
      /* c8 ignore next 4 — reachable only if node's accept path races close() before the listener unbinds */
      if (this.#closing) {
        socket.destroy();
        return;
      }
      this.#onConnection(socket);
    });
  }

  /**
   * @throws {PgBridgeError} `SERVER_CLOSED` after `close()` (create a new
   *   instance to listen again); `SERVER_PGLITE_CLOSED` when the provided
   *   PGlite instance is already closed.
   */
  listen = async (): Promise<string> => {
    if (this.#closing) {
      throw new PgBridgeError(
        'SERVER_CLOSED',
        'PGliteServer is closed — create a new instance to listen again.',
      );
    }
    if (this.#listening) return this.#listening;
    if (this.pglite.closed) {
      throw new PgBridgeError(
        'SERVER_PGLITE_CLOSED',
        'PGliteServer requires an open PGlite instance; got a closed one.',
      );
    }

    const attempt = new Promise<string>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#server.once('error', onError);

      // Socket
      if (this.#options.dataDir) {
        const { dataDir, port, user } = this.#options;

        this.#server.listen(nodePath.join(dataDir, `.s.PGSQL.${port}`), () => {
          this.#server.removeListener('error', onError);
          return resolve(
            `postgres://${user}@/postgres?host=${encodeURIComponent(dataDir)}&port=${port}`,
          );
        });

        return;
      }

      // TCP
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.removeListener('error', onError);

        const { user } = this.#options;
        // Inside the TCP listen callback the server is bound to a port, so
        // address() is always AddressInfo — never the Unix-socket string or the
        // pre-listen null that Node's union return type also allows.
        const addr = this.#server.address();
        /* c8 ignore next 3 — unreachable inside the bound TCP listen callback */
        if (typeof addr !== 'object' || addr === null) {
          throw new Error(
            `PGliteServer: expected TCP AddressInfo after listen(), got ${JSON.stringify(addr)}`,
          );
        }
        const { address, family, port } = addr;

        this.#options.port = port; // re-assign used port

        return resolve(
          family === 'IPv6'
            ? `postgres://${user}@/postgres?host=${encodeURIComponent(address)}&port=${port}`
            : `postgres://${user}@${address}:${port}/postgres`,
        );
      });
    });

    this.#listening = attempt;
    try {
      return await attempt;
    } catch (err) {
      // A failed bind stays retryable — the Unix-socket EADDRINUSE flow in
      // docs/server.md unlinks the stale socket and calls listen() again.
      this.#listening = undefined;
      throw err;
    }
  };

  /**
   * Shut down the listener. When the server created its own PGlite (no
   * `pglite` option at construction), also closes that instance. When the
   * caller supplied a `pglite`, it is left open — the caller is responsible
   * for closing it.
   *
   * Idempotent: repeat calls return the same promise, and closing a server
   * that never listened resolves cleanly.
   */
  close = (): Promise<void> => {
    this.#closing ??= this.#doClose();
    return this.#closing;
  };

  #doClose = async (): Promise<void> => {
    // Wait out an in-flight bind — node silently drops a close() issued
    // mid-bind, which would leak the listener and leave listen() unsettled.
    await this.#listening?.catch(() => {});
    // Queued snapshot operations never get the session; one that holds it
    // runs to completion before the PGlite goes away.
    for (const id of this.#sessionWaiters) {
      this.#sessionLock.cancel(
        id,
        new PgBridgeError('SERVER_CLOSED', 'PGliteServer closed while waiting for the session.'),
      );
    }
    await Promise.allSettled(this.#sessionOps);
    // Stop accepting BEFORE destroying sockets: a connection accepted
    // between the two would escape the sweep. server.close() only settles
    // once all live sockets are gone, so it is awaited after the sweep.
    // Its callback error (ERR_SERVER_NOT_RUNNING) is unreachable here — the
    // listening guard plus close() memoization rule it out.
    const listenerClosed = this.#server.listening
      ? new Promise<void>((resolve) => {
          this.#server.close(() => resolve());
        })
      : undefined;
    const sockets = [...this.#sockets];
    for (const socket of sockets) socket.destroy();
    await listenerClosed;
    await Promise.all(sockets.map(({ duplex }) => duplex?.onClose));
    if (this.#ownsPglite && !this.pglite.closed) {
      await this.pglite.close();
    }
  };

  /**
   * Restore every user table to the last {@link snapshotDb} state — or
   * truncate to empty without one — after waiting for the shared session to
   * go idle. Fails fast with `SERVER_NOT_IDLE` while any connection is inside
   * a transaction, and after `timeoutMs` (default 5000) if a statement is
   * still running. Sequences restart (`RESTART IDENTITY`).
   *
   * Connection state is **not** reset: the session belongs to the connected
   * app, so its `SET`s, `LISTEN`s, temp tables, and advisory locks survive
   * (unlike `PGliteBridge.resetDb`). Use a fresh connection when a test
   * depends on session state.
   *
   * Hard precondition: anything that reaches `server.pglite` outside this
   * server — a direct `pglite.exec`/`query`, a companion `PGliteBridge` or
   * `PgBridgePool` over it — must be idle. The server's lock cannot see them.
   *
   * @throws {PgBridgeError} `SERVER_NOT_IDLE`, `SERVER_CLOSED`,
   *   `SERVER_PGLITE_CLOSED`, `SNAPSHOT_INVALID` (schema changed since the
   *   snapshot).
   */
  resetDb = (options?: ServerSessionOptions): Promise<void> =>
    this.#withSession('resetDb', options, () => this.#snapshot.resetDb({ scrubSession: false }));

  /**
   * Capture every user table and sequence value so later {@link resetDb}
   * calls restore to it. Same idle rules and precondition as `resetDb`. A
   * snapshot taken through a `PGliteBridge` over the same PGlite is visible
   * here, and vice versa — the state lives in the database.
   */
  snapshotDb = (options?: ServerSessionOptions): Promise<void> =>
    this.#withSession('snapshotDb', options, () => this.#snapshot.snapshotDb());

  /** Drop the snapshot so later {@link resetDb} calls truncate to empty. Same idle rules as `resetDb`. */
  resetSnapshot = (options?: ServerSessionOptions): Promise<void> =>
    this.#withSession('resetSnapshot', options, () => this.#snapshot.resetSnapshot());

  #openTransactions(): number {
    let open = 0;
    for (const { duplex } of this.#sockets) if (duplex?.inTransaction) open += 1;
    return open;
  }

  /**
   * Run a snapshot operation as the session owner: fail fast on an open
   * transaction (it would hold the lock until COMMIT), then queue behind any
   * in-flight statement — admission is lock-first on every duplex path — with
   * a bounded wait, run, release. Only this method releases the hold; a
   * duplex's idle-ReadyForQuery release matches its own id, never ours.
   */
  async #withSession<T>(
    method: string,
    options: ServerSessionOptions | undefined,
    op: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    if (this.#closing) {
      throw new PgBridgeError('SERVER_CLOSED', `${method}() was called on a closed PGliteServer.`);
    }
    if (this.pglite.closed) {
      throw new PgBridgeError(
        'SERVER_PGLITE_CLOSED',
        `${method}() requires an open PGlite instance; got a closed one.`,
      );
    }
    const open = this.#openTransactions();
    if (open > 0) throw notIdle(method, openTransactionsDetail(open));

    const id = Symbol(`PGliteServer.${method}`);
    this.#sessionWaiters.add(id);
    let granted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acquired = this.#sessionLock.acquire(id).then(() => {
      granted = true;
    });
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // The grant can land in the same tick the timer fires; cancelling an
        // owner would release a hold we are about to use.
        if (granted) return;
        const error = notIdle(
          method,
          `timed out after ${timeoutMs}ms waiting for the session; a connection is still busy.`,
        );
        this.#sessionLock.cancel(id, error);
        reject(error);
      }, timeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([acquired, expiry]);
    } finally {
      clearTimeout(timer);
      this.#sessionWaiters.delete(id);
    }

    const run = (async () => {
      try {
        // A transaction holds the lock from BEGIN to COMMIT, so none can be
        // open now that we own it. Kept as an invariant check, not a
        // reachable path.
        const stillOpen = this.#openTransactions();
        /* v8 ignore next */
        if (stillOpen > 0) throw notIdle(method, openTransactionsDetail(stillOpen));
        return await op();
      } finally {
        this.#sessionLock.release(id);
      }
    })();
    this.#sessionOps.add(run);
    try {
      return await run;
    } finally {
      this.#sessionOps.delete(run);
    }
  }

  #initDuplex(socket: BridgedSocket): PGliteDuplex {
    socket.duplex = new PGliteDuplex(this.pglite, {
      sessionLock: this.#sessionLock,
      timeout: this.#options.timeout,
      syncToFs: resolveSyncToFs(this.pglite, this.#options.syncToFs),
      // Native clients (Prisma CLI engine, psql, GUIs) need real catalog
      // OIDs; the 18→25 widening is an @prisma/adapter-pg accommodation that
      // belongs to the bridge path only. With it, the CLI engine misreads
      // pg_constraint.contype as text and fails on PostgreSQL 18's
      // NOT NULL rows (contype 'n') — see prisma/prisma#29635.
      rewriteSystemCatalogCharOids: false,
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
