---
"prisma-pglite-bridge": patch
---

The pool's connect-time `DEALLOCATE ALL` cleanup now runs only when
the new client has no live siblings. With `max > 1`, a lazily created
second client used to wipe the first client's named prepared
statements in the shared PGlite session (Postgres error 26000 on the
next execution). Named statements within a `max > 1` pool remain
unsupported (shared namespace) — now documented.
