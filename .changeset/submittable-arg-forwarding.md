---
"prisma-pglite-bridge": patch
---

Forward the full argument list through Submittable admission. Stock pg
attaches a trailing positional callback to the submittable itself, which is
how pg-pool's release callback reaches `pool.query(new pg.Query(...))` — the
bridge dropped it, so the pool promise never settled, the client stayed
checked out forever, and `pool.end()` hung. `pool.query(Submittable)` and
`client.query(submittable, cb)` now behave like stock pg.
