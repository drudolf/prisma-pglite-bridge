---
"prisma-pglite-bridge": minor
---

Remove the `ppb` CLI. The `bin/ppb.ts` entry point and the
published `ppb` binary are gone, along with the `citty` runtime
dependency.

**Migration:** spin up a `PGliteServer` and pass its URL to the
Prisma CLI. The `prisma db push --url <url>` flow covers the same
ground:

```ts
import { PGlite } from '@electric-sql/pglite';
import { PGliteServer } from 'prisma-pglite-bridge';

const server = new PGliteServer({ pglite: new PGlite() });
const url = await server.listen();
// run: prisma db push --url "$url"
```
