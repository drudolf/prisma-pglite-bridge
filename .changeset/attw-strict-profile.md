---
'prisma-pglite-bridge': patch
---

Tighten `check:exports` by switching the `arethetypeswrong` profile
from `node16` to `strict`. `strict` is a superset — it keeps all the
`node16`/`nodenext` resolution checks and additionally flags
unexpected module syntax (ESM entrypoint emitting CJS, or the
reverse). Our dual CJS/ESM output from `tsdown` already passes it
cleanly, so this only guards against future drift.
