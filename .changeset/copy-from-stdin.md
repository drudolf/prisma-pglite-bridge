---
"prisma-pglite-bridge": minor
---

COPY support over the wire protocol: `COPY ... TO STDOUT` and `COPY ... FROM STDIN` now work through the pool (e.g. via `pg-copy-streams`). Previously any protocol-level copy-in was fatal — PGlite's WASM backend treats an exhausted input buffer mid-COPY as connection EOF and exits — so the duplex now captures the copy-in conversation: it answers the copy query with a synthetic `CopyInResponse`, buffers the client's `CopyData` stream (default cap 256 MiB, override via `PGliteDuplexOptions.copyAggregateCapBytes`), and executes the whole exchange as one atomic PGlite call on `CopyDone`/`CopyFail`.

Scope and shape notes: server-side COPY errors (missing table, malformed rows) surface after the client finishes sending, since the query executes with the assembled payload; peak transient memory is ~2× the payload; a cap breach degrades to a catchable in-band error, never a teardown. Multi-statement simple queries containing `COPY ... FROM STDIN` are rejected with a synthesized error rather than forwarded (fail closed), and extended-protocol COPY is not supported — `pg-copy-streams` and psql-style clients drive COPY over the simple protocol, which is the supported path.
