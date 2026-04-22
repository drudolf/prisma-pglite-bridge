---
"prisma-pglite-bridge": minor
---

Add `syncToFs` option to `createPool` / `createPgliteAdapter`, defaulting to
`'auto'`. For clearly in-memory PGlite instances (`new PGlite()` or a
`memory://…` dataDir) the bridge now passes `syncToFs: false` on each
wire-protocol call, avoiding per-query filesystem sync work that has no
durability value on volatile storage. Persistent `dataDir` usage keeps the
existing `syncToFs: true` behaviour. Pass an explicit `true` or `false` to
override — required if you supply a custom persistent `fs` without a
meaningful `dataDir`.
