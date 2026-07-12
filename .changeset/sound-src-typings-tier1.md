---
"prisma-pglite-bridge": patch
---

Internal: remove five `as`-casts that circumvented the type system in
non-pool `src/`, replacing each with sound narrowing. Indexed reads in
the copy-in SQL scanner use `String.charAt` (which returns `''` past the
end instead of `undefined`); the statement-name LRU evicts its oldest
entry via a first-entry `for…of` instead of casting
`.keys().next().value`/`.get()`, which also drops a redundant re-lookup
and no longer evicts from an empty map at `capacity: 0`; the EQP
pipeline fast path narrows `messages[0]` with a definedness guard; and
the server's `address()` read narrows Node's `AddressInfo | string |
null` union with a runtime guard that throws on the (unreachable)
non-TCP cases. No behavior change on supported configurations.
