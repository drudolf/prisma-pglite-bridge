---
"prisma-pglite-bridge": patch
---

Ship `docs/` and a new `AGENTS.md` in the npm tarball. README links to
the API reference, cookbook, troubleshooting, and server docs now
resolve inside `node_modules/prisma-pglite-bridge/`, so offline readers
and coding agents can follow them without leaving the project.
`AGENTS.md` is a short agent-facing map of the entry points, the
minimal recipes, error codes, warnings, and foot-guns.
