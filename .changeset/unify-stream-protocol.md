---
"prisma-pglite-bridge": patch
---

Internal refactor: unify `runPipelineBatch` and `execAndPush` into a single `streamProtocol` method. The two methods were byte-identical except for one boolean (`suppressIntermediateReadyForQuery`). No behavior change.
