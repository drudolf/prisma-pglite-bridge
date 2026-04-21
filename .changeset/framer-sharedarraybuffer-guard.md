---
'prisma-pglite-bridge': patch
---

Guard the `BackendMessageFramer` zero-copy path against
`SharedArrayBuffer`-backed chunks. When PGlite hands the framer a
`Uint8Array` whose backing store is a `SharedArrayBuffer`, the emitted
slice is now a copy rather than a live view. Prevents the WASM runtime
from mutating bytes that `pg` is still consuming. Current PGlite 0.4.x
does not use shared memory, so behaviour is unchanged today; the guard
is defensive against future PGlite builds that might use
`WebAssembly.Memory({ shared: true })`.
