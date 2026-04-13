---
"prisma-pglite-bridge": patch
---

# Migrate build toolchain to tsdown and TypeScript 6

Switch from tsup (esbuild) to tsdown (Rolldown) for bundling, and
upgrade TypeScript from 5.9 to 6.0. Also updates Biome from 1.9 to
2.4 and @types/node from 22 to 25.
