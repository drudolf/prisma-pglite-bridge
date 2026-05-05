---
"prisma-pglite-bridge": patch
---

Internal refactor: regroup `src/` into a folder-per-class layout.
Top-level `src/` now holds only the public barrel (`index.ts`)
plus seven cohesive folders:

- `duplex/`, `pglite-bridge/`, `pglite-server/`, `pool/`,
  `schema/`, `telemetry/`
- `utils/` slimmed to true cross-cutting helpers
  (`session-lock`, `time`, `resolve-sync-to-fs`,
  `wait-pglite-ready`)

Also rewrites `SnapshotManager` from a closure-based factory
into a class, matching the rest of the codebase. Public API is
unchanged.
