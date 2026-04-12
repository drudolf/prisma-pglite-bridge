import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing/create-pglite-adapter.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  splitting: false,
  external: ['@electric-sql/pglite', 'pg', '@prisma/adapter-pg', '@prisma/client'],
});
