---
"prisma-pglite-bridge": minor
---

New fast path for adapter-pg-shaped queries: named statements executed with
`rowMode: 'array'` and a caller-supplied `types` object now run through a
lean pg Submittable that caches result-field metadata per statement and
skips the Describe round-trip on repeat executions, instead of pg's stock
Query/Result machinery. In the reference probe (two interleaved passes of
n=1500, warmup 150, values pass-1/pass-2) point lookups dropped from
108/98µs to 66/74µs (~30-35%) and the 100-row read's worst case tightened
from ~9-11ms to ~1.3ms at the pool layer; p50 on 100-row reads improved
~7-9%. Result values are identical (verified by a dual-bridge parity suite
covering DML, arrays, JSON, Decimal, NULL parameters, errors, and
transactions); type conversion still runs through the caller's
`types.getTypeParser` on every execution.

Observable difference: fast-path results resolve to a plain
`{ rows, fields, rowCount, command, oid }` object rather than a `pg.Result`
instance. Every other query shape — unnamed statements, object row mode,
Submittables, COPY, row-limited queries — uses the stock pg path unchanged.
Opt out with the new `PgBridgePoolOptions.fastQueryPath: false`.
