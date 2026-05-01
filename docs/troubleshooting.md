# Troubleshooting & limitations

## Limitations

- **Node.js 20+ only** — requires `node:stream` and `node:fs`.
  Does not work in browsers despite PGlite's browser support.
- **WASM cold start** — first `createPGliteBridge()` call takes
  ~2s for PGlite WASM compilation. Subsequent calls in the same
  process reuse the compiled module.
- **Single PostgreSQL session** — PGlite runs in single-user mode.
  All pool connections share one session. With `max > 1`, a
  `SessionLock` serializes transactions (one at a time), but `SET`
  variables leak between connections within a single test. `resetDb()`
  clears more of this between tests via `DISCARD ALL`. The default
  `max: 1` avoids extra bridge connections and session-lock overhead.
- **Schema source required** — pick one of
  [`pushMigrations`](./api.md#pushmigrationstarget-options) (run
  `prisma migrate dev` first or pass `sql` directly) or
  [`pushSchema`](./api.md#pushschematarget-options) (apply
  `schema.prisma` directly). `createPGliteBridge` alone returns
  an empty database.

## `this.pglite.execProtocolRawStream is not a function`

The bridge uses PGlite 0.4's streaming protocol API. Some packages
in the Prisma ecosystem (e.g. `@prisma/dev`) still pin
`@electric-sql/pglite` to 0.3.x, which pnpm will install alongside
0.4 — and the bridge can end up with the older copy.

Check your tree:

```sh
pnpm why @electric-sql/pglite
```

If you see more than one version, force a single 0.4.x via
`pnpm.overrides` in your project's `package.json`:

```json
{
  "pnpm": {
    "overrides": {
      "@electric-sql/pglite": "^0.4.4"
    }
  }
}
```

Then `pnpm install`.

## `ExperimentalWarning: Importing WebAssembly module instances is an experimental feature`

Emitted by Node when `pushSchema` / `resetSchema` loads
`@prisma/schema-engine-wasm`, which uses ESM static `.wasm`
imports. The warning is harmless and prints once per Node process.

If you only need to apply already-generated migration SQL, use
[`pushMigrations`](./api.md#pushmigrationstarget-options) instead — it does
not load the schema engine, so the warning never fires.

To silence it in tests or CI, pass Node's `--disable-warning` flag:

```sh
NODE_OPTIONS=--disable-warning=ExperimentalWarning pnpm test
```

Or scope it to Vitest workers via `vitest.config.ts`:

```ts
export default defineConfig({
  test: {
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
```

Requires Node ≥ 22. The warning will go away once Node stabilizes
WebAssembly ESM imports.
