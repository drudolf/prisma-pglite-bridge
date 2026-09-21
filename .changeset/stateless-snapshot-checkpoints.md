---
"prisma-pglite-bridge": patch
---

Use PostgreSQL's checkpoint state for snapshot/reset WAL maintenance so manual
and peer checkpoints are observed without per-manager bookkeeping. Batch reset
metadata reads to offset the control-file probe cost and reduce reset overhead.
