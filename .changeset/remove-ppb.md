---
"prisma-pglite-bridge": major
---

Remove the `ppb` CLI. The `bin/ppb.ts` entry point and the
published `ppb` binary are gone, along with the `citty` runtime
dependency.

**Migration:** use `createPGliteServer` directly and pass its
`url` to the Prisma CLI. The `prisma db push --url <url>` flow
covers the same ground:

```ts
import { PGlite } from '@electric-sql/pglite';
import { createPGliteServer } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const server = await createPGliteServer({ pglite });
// run: prisma db push --url server.url
```
