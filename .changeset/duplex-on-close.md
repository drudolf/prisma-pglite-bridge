---
"prisma-pglite-bridge": minor
---

Add `PGliteDuplex#onClose`, a single-shot `Promise<void>` that
resolves once the stream has fully torn down (post-`_final`
rollback, post-`_destroy`). Mirrors the `'close'` event but is
safe to await even after close has already happened, which makes
it convenient for orchestrators that need to wait for in-flight
duplexes during shutdown.
