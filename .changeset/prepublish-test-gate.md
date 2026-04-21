---
'prisma-pglite-bridge': patch
---

Run the full test suite before `npm publish` / `pnpm publish`. The
`prepublishOnly` gate now runs `pnpm test && pnpm build && pnpm check:exports`,
so a tarball can never be published from a red working copy even
if a maintainer skipped the CI check.
