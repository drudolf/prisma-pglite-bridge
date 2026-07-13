---
"prisma-pglite-bridge": patch
---

Preserve call order when a Submittable follows chain-delayed queries. `query(submittable)` still returns the submittable synchronously, but its admission to pg's internal queue now waits for the pending submission chain, so it can no longer jump ahead of an earlier promise-form query on the same client. The chain is not extended past it: ordering after admission (including completion) remains pg's own FIFO contract, and an admission failure on an ended client is delivered through the submittable's error path.
