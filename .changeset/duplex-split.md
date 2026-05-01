---
"prisma-pglite-bridge": patch
---

Internal refactor: split the 1109-line `pglite-duplex` module into a
`src/duplex/` folder with focused units (constants, RowDescription
rewrite, `FrontendMessageBuffer`, `BackendMessageFramer`,
`PGliteDuplex`). Tests are co-located per unit. Public API is
unchanged — `PGliteDuplex` is still exported from the package root.
