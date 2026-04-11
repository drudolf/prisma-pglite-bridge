import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    hookTimeout: 20_000,
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
