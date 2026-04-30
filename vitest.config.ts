import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 20_000,
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: { 100: true },
    },
    projects: [
      defineProject({
        extends: true,
        test: {
          name: 'default',
          include: ['src/**/*.test.ts'],
          exclude: [
            'node_modules',
            'dist',
            'src/**/__tests__/**',
            'src/create-pglite-bridge.gc.test.ts',
          ],
        },
      }),
      defineProject({
        extends: true,
        test: {
          name: 'gc',
          include: ['src/create-pglite-bridge.gc.test.ts'],
          execArgv: ['--expose-gc'],
        },
      }),
      defineProject({
        extends: true,
        test: {
          name: 'integration',
          include: ['src/__tests__/integration/**/*.test.ts'],
          setupFiles: ['./src/__tests__/integration/setup.ts'],
          isolate: false,
          pool: 'forks',
          maxWorkers: 4,
        },
      }),
    ],
  },
});
