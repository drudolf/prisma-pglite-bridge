---
"prisma-pglite-bridge": patch
---

Internal cleanup flagged by knip:

- Drop `export` on six frontend message-type constants in
  `src/duplex/constants.ts` (`PARSE`, `BIND`, `DESCRIBE`,
  `EXECUTE`, `CLOSE`, `FLUSH`) — only used to build
  `EQP_MESSAGES` inside the same file.
- Fold `src/duplex/pglite-duplex.ts` into `src/duplex/index.ts`,
  the only remaining content of the duplex barrel. Dead
  re-exports of `BackendMessageFramer` and `FrontendMessageBuffer`
  removed (consumers and tests already imported them directly
  from their unit files).

Public API is unchanged — `PGliteDuplex` is still exported from
the package root via `./duplex/index.ts`.
