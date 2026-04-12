import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  splitting: false,
  external: [
    '@electric-sql/pglite',
    'pg',
    '@prisma/adapter-pg',
    '@prisma/client',
    '@prisma/config',
  ],
});
