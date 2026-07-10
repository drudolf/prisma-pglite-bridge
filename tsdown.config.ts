import { defineConfig } from 'tsdown';

const neverBundle = [
  '@electric-sql/pglite',
  'pg',
  '@prisma/adapter-pg',
  '@prisma/client',
  '@prisma/config',
  '@prisma/driver-adapter-utils',
  '@prisma/schema-engine-wasm',
  'vitest',
  '@jest/globals',
];

export default defineConfig({
  entry: ['src/index.ts', 'src/testing/vitest.ts', 'src/testing/jest.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle },
});
