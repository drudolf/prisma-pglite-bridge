---
"prisma-pglite-bridge": patch
---

Serialize `pg.Client.query` submissions in the bridge's Client subclass so
upstream fan-out (notably Prisma's readback phase on `create` with multi-
relation `include`, or `Promise.all` inside an interactive `$transaction`)
never trips pg's "client.query() while another query is executing"
deprecation warning. Promise- and callback-form queries are chained through
a per-Client submission queue; the Submittable form (pg.Query, cursors,
streaming) is passed through unserialized to preserve its event contract.
