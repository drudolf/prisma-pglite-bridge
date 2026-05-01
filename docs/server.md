# `createPGliteServer`

Expose a PGlite instance over TCP or a Unix domain socket so
standard PostgreSQL clients (`psql`, Prisma CLI, DBeaver, Studio,
etc.) can connect to it.

The bridge already pipes Prisma's queries through PGlite in-process
without a network hop — `createPGliteServer` is for the cases where
you need an actual `host:port` (or socket path): driving the Prisma
CLI's shadow database, attaching a SQL GUI to inspect test state,
or running tools that hard-require a wire-protocol endpoint.

## Contents

- [Quickstart](#quickstart)
- [Options](#options)
- [Return value](#return-value)
- [Use cases](#use-cases)
  - [Prisma CLI shadow database](#prisma-cli-shadow-database)
  - [`psql` and SQL GUIs](#psql-and-sql-guis)
  - [Unix domain sockets](#unix-domain-sockets)
- [Security](#security)

## Quickstart

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPGliteServer } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const server = await createPGliteServer({ pglite });

console.log(server.url);
// → postgres://127.0.0.1:54321/postgres

// later
await server.close();
await pglite.close();
```

By default the server binds to `127.0.0.1` on an ephemeral port
(`port: 0`). Read the actual bound port from `server.port` or use
`server.url` directly with any `pg.Client` / `pg.Pool`.

`server.close()` stops accepting connections, force-closes active
sockets, and awaits per-connection cleanup. **It does not close the
PGlite instance** — you own its lifecycle.

## Options

```typescript
await createPGliteServer({
  pglite,                 // required — caller owns lifecycle
  host: '127.0.0.1',      // default '127.0.0.1' (loopback)
  port: 0,                // default 0 (ephemeral)
  socketDir: undefined,   // optional — switch to Unix socket mode
  socketPort: 5432,       // socket file suffix; ignored unless socketDir set
  syncToFs: 'auto',       // 'auto' | true | false (same policy as the bridge)
});
```

When `socketDir` is set, `host` and `port` are ignored. The server
binds the libpq-conventional path
`<socketDir>/.s.PGSQL.<socketPort>` so `psql -h <socketDir>`
connects without an explicit `port`.

## Return value

```typescript
interface PGliteServer {
  url: string;            // postgres:// connection string ready for pg.Client
  port: number;           // bound TCP port (or socketPort for Unix)
  host: string;           // bound host (empty string for Unix sockets)
  socketPath?: string;    // bound Unix socket file, when applicable
  close: () => Promise<void>;
}
```

The `url` is library-emitted and safe to pass to `pg.Client({
connectionString })`:

- IPv4 TCP → `postgres://127.0.0.1:54321/postgres`
- IPv6 TCP → `postgres:///postgres?host=%3A%3A1&port=54321`
  (libpq query form — sidesteps `pg-connection-string`'s broken
  bracketed-IPv6 parsing)
- Unix → `postgres:///postgres?host=%2Ftmp%2Fpgl&port=5432`

The server has no authentication, so the URL has no user. Prisma
7's schema engine rejects URLs without a username (P1010); inject
one before handing the URL to Prisma:

```typescript
const prismaUrl = server.url.replace('://', '://postgres@');
```

## Use cases

### Prisma CLI shadow database

`prisma migrate dev` requires a separate **shadow database** to
diff schemas. Spin up a second `createPGliteServer` instance and
point Prisma at it — no Docker, no second `pg_ctl` process:

```typescript
const main = await createPGliteServer({ pglite: new PGlite() });
const shadow = await createPGliteServer({ pglite: new PGlite() });

// prisma.config.ts
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    shadowDatabaseUrl: shadow.url.replace('://', '://postgres@'),
  },
});

process.env.DATABASE_URL = main.url.replace('://', '://postgres@');
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
them at `server.host` and `server.port` (user `postgres`, no
password). PGlite still runs single-user, so the GUI's queries
serialize through the same `SessionLock` as the test.

### Unix domain sockets

Bind to a Unix socket if you want to avoid TCP altogether
(slightly faster, no port collision concerns, and works in
sandboxed environments without network namespaces):

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const socketDir = mkdtempSync(`${tmpdir()}/pgl-`);
const server = await createPGliteServer({ pglite, socketDir });

// psql -h /var/folders/…/pgl-XXXXXX
// node: pg.Client({ connectionString: server.url })
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
- For Unix sockets, place `socketDir` somewhere only your user can
  write to — `fs.mkdtemp` defaults to `0700`.
- Treat the URL like any other secret-bearing string: don't log it
  to shared infrastructure.
