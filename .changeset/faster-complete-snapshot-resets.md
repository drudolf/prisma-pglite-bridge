---
"prisma-pglite-bridge": patch
---

Speed up snapshot resets with direct column-catalog lookups, a single batched
restore transaction, and set-based sequence restoration. Snapshot partitioned
and inherited tables without duplicating descendant rows, and preserve sequence
`is_called` state, including never-used sequences and databases with only
standalone sequences. Persisted snapshots from earlier versions remain readable.
