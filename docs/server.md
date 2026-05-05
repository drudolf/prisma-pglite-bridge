# `PGliteServer`

Expose a PGlite instance over TCP or a Unix domain socket so
standard PostgreSQL clients (`psql`, Prisma CLI, DBeaver, Studio,
etc.) can connect to it.

The bridge already pipes Prisma's queries through PGlite in-process
without a network hop — `PGliteServer` is for the cases where
you need an actual `host:port` (or socket path): driving the Prisma
CLI's shadow database, attaching a SQL GUI to inspect test state,
or running tools that hard-require a wire-protocol endpoint.

## Contents

- [Quickstart](#quickstart)
- [Options](#options)
- [The connection URL](#the-connection-url)
- [Use cases](#use-cases)
  - [Prisma CLI shadow database](#prisma-cli-shadow-database)
  - [`psql` and SQL GUIs](#psql-and-sql-guis)
  - [Unix domain sockets](#unix-domain-sockets)
- [Security](#security)

## Quickstart

```typescript
import { PGliteServer } from 'prisma-pglite-bridge';

const server = new PGliteServer();
const url = await server.listen();

console.log(url);
// → postgres://postgres@127.0.0.1:54321/postgres

// later
await server.close(); // closes listener + internally-created PGlite
```

The constructor is synchronous. The network bind happens in the
explicit `listen()` step (mirroring `net.Server`'s API), which
awaits `pglite.waitReady` internally and resolves to a connection
URL ready to pass to any `pg.Client` / `pg.Pool`. The PGlite
instance is always accessible as `server.pglite` so scripts can
pass it to helpers like
[`pushMigrations`](./api.md#pushmigrationspglite-options) or
[`hasMigrations`](./api.md#hasmigrationspglite) without threading a
separate variable.

By default the server binds to `127.0.0.1` on an ephemeral port
(`port: 0`). The actual bound port is reflected in the URL.

**Ownership:** when no `pglite` option is supplied the server creates
its own in-memory PGlite and `close()` shuts it down. When you supply
a `pglite`, `close()` leaves it open — you own its lifecycle.

`server.close()` stops accepting connections, force-closes active
sockets, and awaits per-connection cleanup.

## Options

```typescript
new PGliteServer({
  pglite,                 // optional — if omitted, an in-memory PGlite is created and owned
  host: '127.0.0.1',      // default '127.0.0.1' (loopback)
  port: 0,                // default 0 (ephemeral) in TCP mode;
                          // 5432 in Unix-socket mode (suffix of the socket file)
  dataDir: undefined,     // optional — switches to Unix-socket mode
  user: 'postgres',       // default 'postgres' — embedded in the URL
  syncToFs: 'auto',       // 'auto' | true | false (same policy as the bridge)
});
```

When `dataDir` is set, `host` is ignored and the server binds the
libpq-conventional path `<dataDir>/.s.PGSQL.<port>` so `psql -h <dataDir>`
connects without an explicit `port`.

PGlite has no real authentication, but Prisma 7's schema engine
rejects URLs without a username (P1010), so `user` is always
emitted in the URL and defaults to `'postgres'`.

## The connection URL

`listen()` returns a `postgres://` URL safe to pass straight to
`pg.Client({ connectionString })`:

- IPv4 TCP → `postgres://postgres@127.0.0.1:54321/postgres`
- IPv6 TCP → `postgres://postgres@/postgres?host=%3A%3A1&port=54321`
  (libpq query form — sidesteps `pg-connection-string`'s broken
  bracketed-IPv6 parsing)
- Unix → `postgres://postgres@/postgres?host=%2Ftmp%2Fpgl&port=5432`

## Use cases

### Prisma CLI shadow database

`prisma migrate dev` requires a separate **shadow database** to
diff schemas. Spin up a second `PGliteServer` instance and point
Prisma at it — no Docker, no second `pg_ctl` process:

```typescript
const main = new PGliteServer();
const shadow = new PGliteServer();

const [mainUrl, shadowUrl] = await Promise.all([main.listen(), shadow.listen()]);

// prisma.config.ts
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    shadowDatabaseUrl: shadowUrl,
  },
});

process.env.DATABASE_URL = mainUrl;
```

End-to-end usage — spawning `prisma migrate dev`, `prisma db
execute`, etc. — is exercised in the cli-compat suite under
`src/__tests__/cli-compat/`.

### `psql` and SQL GUIs

Want to peek at the database while a test is paused? Hold the
server open and connect with `psql`:

```sh
psql "postgres://postgres@127.0.0.1:54321/postgres"
```

DBeaver / Prisma Studio / TablePlus connect the same way — point
them at the host and port from the URL (user `postgres`, no
password). PGlite still runs single-user, so the GUI's queries
serialize through the same `SessionLock` as the test.

### Unix domain sockets

Bind to a Unix socket if you want to avoid TCP altogether
(slightly faster, no port collision concerns, and works in
sandboxed environments without network namespaces):

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(`${tmpdir()}/pgl-`);
const server = new PGliteServer({ dataDir });
const url = await server.listen();

// psql -h /var/folders/…/pgl-XXXXXX
// node: pg.Client({ connectionString: url })
```

`close()` does **not** unlink the socket file. If a previous
process crashed, `listen()` will fail with `EADDRINUSE` —
`fs.unlink` the stale socket before retrying. `mkdtemp` creates
the directory with mode `0700`, which is the right default for an
unauthenticated endpoint.

## Security

The server has **no authentication**. SSL / GSS pre-negotiation is
explicitly rejected with a single `N` byte so clients fall back to
plaintext. This is a development tool, not a hardened endpoint:

- Bind to loopback only (the default `host: '127.0.0.1'`). Do not
  expose `0.0.0.0` or a routable address.
- For Unix sockets, place `dataDir` somewhere only your user can
  write to — `fs.mkdtemp` defaults to `0700`.
- Treat the URL like any other secret-bearing string: don't log it
  to shared infrastructure.
