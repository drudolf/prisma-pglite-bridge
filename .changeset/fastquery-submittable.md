---
"prisma-pglite-bridge": patch
---

Internal: `FastQuery` now `implements pg.Submittable` (typing `submit`'s
parameter as pg's real `Connection`), so the pool's fast-path submission uses a
checked `as pg.Submittable` upcast instead of an unchecked `as unknown as`
reinterpret — TypeScript now verifies the conformance. No behavior change.
