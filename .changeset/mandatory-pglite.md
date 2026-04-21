---
"prisma-pglite-bridge": minor
---

**Breaking:** `createPgliteAdapter` and `createPool` now require a
caller-supplied `pglite: PGlite` option. The adapter no longer
constructs or owns the PGlite instance — callers create it with
`new PGlite(...)` and pass it in, so the full PGlite option
surface (dataDir, extensions, debug, loadDataDir, etc.) becomes
available without the bridge having to re-expose every knob.

Removed options: `dataDir`, `extensions`. The `max` option stays.

Removed return fields: `pglite` (caller already owns it),
`wasmInitMs` (caller owns PGlite construction timing). The
`wasmInitMs` stats field is also removed from `Stats`.

`close()` now shuts down the pool only — the PGlite instance is
not closed, since the caller owns its lifecycle.

Schema application is now explicit: `createPgliteAdapter` applies
migration SQL only when `sql`, `migrationsPath`, or `configRoot`
is provided. With no migration config, the PGlite instance is
assumed to already hold the schema — this is the intended path
for reopening a persistent `dataDir`. Previously the bridge
auto-detected initialization via a `PG_VERSION` file check; that
detection is no longer needed since the caller controls when
migrations run.

Migration example:

```diff
- const { adapter } = await createPgliteAdapter({
-   dataDir: './data',
-   extensions: { uuid_ossp },
- });
+ import { PGlite } from '@electric-sql/pglite';
+ const pglite = new PGlite('./data', { extensions: { uuid_ossp } });
+ const { adapter } = await createPgliteAdapter({
+   pglite,
+   migrationsPath: './prisma/migrations',
+ });
```
