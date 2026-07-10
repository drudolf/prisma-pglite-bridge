---
"prisma-pglite-bridge": patch
---

Malformed or absurdly large frontend message lengths now fail the
connection instead of stalling it. Both framing phases (startup and
regular messages) previously treated an impossible declared length as
"incomplete, wait for more data", buffering unboundedly with success
write callbacks — reachable from arbitrary TCP clients via
`PGliteServer`. They now throw, mirroring the backend framer's
malformed-length and 1 GiB sanity-cap checks, which tears the
connection down cleanly.
