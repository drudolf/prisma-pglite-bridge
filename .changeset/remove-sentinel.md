---
"prisma-pglite-bridge": patch
---

Replace sentinel-table detection of already-initialized persistent
`dataDir` databases with a filesystem check for PGlite's `PG_VERSION`
marker. Removes the reserved `_pglite_bridge` schema, the collision
error path, and ~100 lines of transactional sentinel logic. Behavior
for ephemeral (in-memory) adapters is unchanged. For persistent
`dataDir` adapters, a partially-applied migration now requires
deleting the dataDir to recover rather than auto-recovering on the
next open.
