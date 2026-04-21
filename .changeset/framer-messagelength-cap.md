---
'prisma-pglite-bridge': patch
---

Reject backend message length headers greater than 1 GiB in
`BackendMessageFramer`. A corrupted or hostile byte stream claiming a
4 GiB message would otherwise drive the framer to attempt the
corresponding allocation; the cap throws fast with a descriptive
error instead. PGlite's actual messages are far below this bound —
valid traffic is unaffected.
