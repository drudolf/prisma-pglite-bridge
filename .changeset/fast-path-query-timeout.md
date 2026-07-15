---
"prisma-pglite-bridge": patch
---

Honor `query_timeout` on the fast query path. A query matching the fast-path shape (named + `rowMode: 'array'` + caller-supplied `types`) that carries a truthy `query_timeout` previously ran through the lean submittable, which does not implement pg's read timeout — the caller's bound was silently dropped and the query could wait indefinitely. Such queries now route through the stock pg path, which owns the full read-timeout lifecycle, and accordingly resolve to a `pg.Result` instance. `query_timeout: 0` keeps stock pg's meaning (unset) and stays on the fast path. Note the timeout bounds the caller's promise, not the backend work: PGlite still finishes the statement, and subsequent queries serialize behind it. Because PGlite executes on the JS thread, the timer can only fire while the event loop is free (typically while the query waits on the shared instance), never against the query's own WASM execution.
