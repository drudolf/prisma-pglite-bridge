import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      '@electric-sql/pglite',
      'pg',
      '@prisma/adapter-pg',
      '@prisma/client',
      '@prisma/config',
    ],
  },
});
