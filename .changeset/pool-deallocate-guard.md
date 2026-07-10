---
"prisma-pglite-bridge": patch
---

The pool's connect-time `DEALLOCATE ALL` cleanup now runs only when
the new client has no live siblings. With `max > 1`, a lazily created
second client used to wipe the first client's named prepared
statements in the shared PGlite session (Postgres error 26000 on the
next execution). User-supplied statement names (`query({ name: ... })`)
remain single-client-only (shared namespace) — now documented.
