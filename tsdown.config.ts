import { defineConfig } from 'tsdown';

const neverBundle = [
  '@electric-sql/pglite',
  'pg',
  '@prisma/adapter-pg',
  '@prisma/client',
  '@prisma/config',
  '@prisma/driver-adapter-utils',
  '@prisma/schema-engine-wasm',
];

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    deps: { neverBundle },
  },
  {
    entry: ['bin/ppb.ts'],
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    outExtensions: () => ({ js: '.mjs' }),
    deps: { neverBundle },
  },
]);
