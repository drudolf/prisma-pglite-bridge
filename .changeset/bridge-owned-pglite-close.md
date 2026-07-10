---
"prisma-pglite-bridge": patch
---

Close the bridge-owned PGlite instance when adapter construction fails. When `new PGliteBridge()` creates its own PGlite (no `pglite` option) and the Prisma adapter constructor throws, the constructor released the pool's shared-instance slot but left the WASM instance open — unreachable and unclosable, since `close()` cannot be called on a half-constructed bridge. The failure path now ends the pool and then closes the owned instance (best-effort; a rejecting `close()` is swallowed so the original construction error propagates). Caller-supplied instances are left open, as before.
