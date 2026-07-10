---
"prisma-pglite-bridge": patch
---

`wrapTypesWithFastArrayParsers` now binds `getTypeParser` to its receiver.
Passing a `this`-dependent `types` object — notably pg's own `TypeOverrides`
class — as a query-level `types` previously made every parser resolution throw
`Cannot read properties of undefined (reading 'getOverrides')`.
