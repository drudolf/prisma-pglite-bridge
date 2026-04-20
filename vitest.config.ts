import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 20_000,
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
