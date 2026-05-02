import { defineConfig, type ViteUserConfigExport } from 'vitest/config';

const config: ViteUserConfigExport = defineConfig({
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
    maxWorkers: 8,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['node_modules', 'dist', 'src/**/__tests__/**', 'src/**/*.gc.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'gc',
          include: ['src/**/*.gc.test.ts'],
          execArgv: ['--expose-gc'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/__tests__/integration/**/*.test.ts'],
          setupFiles: ['./src/__tests__/integration/utils/setup.ts'],
          isolate: false,
          pool: 'forks',
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'cli-compat',
          include: ['src/__tests__/cli-compat/**/*.test.ts'],
          pool: 'forks',
          maxWorkers: 2,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});

export default config;
