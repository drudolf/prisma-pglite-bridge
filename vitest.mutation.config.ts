import { defineConfig, type ViteUserConfigExport } from 'vitest/config';

// Dedicated flat config for the Stryker vitest-runner (no projects — the runner
// forces coverageAnalysis perTest, single-thread pool, bail:1). Scopes the
// killing suite to the duplex/pool unit + property tests. The split-check file
// validates the copy-in ORACLE against real PGlite and imports no production
// code, so it is excluded here (it stays in the normal `pnpm test` unit glob).
// See .claude/plans/mutation-testing-duplex-pool.md.
const config: ViteUserConfigExport = defineConfig({
  test: {
    hookTimeout: 20_000,
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    include: [
      'src/duplex/**/*.test.ts',
      'src/pool/**/*.test.ts',
      'src/utils/session-lock.test.ts',
      'src/utils/statement-names.test.ts',
      'src/utils/quote-ident.test.ts',
      'src/schema/pg18-not-null.test.ts',
    ],
    exclude: ['**/__tests__/**', '**/*.gc.test.ts', '**/copy-in.split-check.test.ts'],
    env: { FC_NUM_RUNS: '50' },
    setupFiles: ['./scripts/mutation-fc-setup.ts'],
    // Mirror the Stryker vitest-runner's forced execution model (it injects
    // pool: 'threads', maxWorkers 1, maxConcurrency 1 — vitest-test-runner.js).
    // The runner overrides these at mutation time, so they only shape the raw
    // pre-flight run: with WASM PGlite pool/duplex tests booting real
    // instances, any file-level parallelism starves the slowest teardown-timing
    // tests past testTimeout (false Timeouts, not assertion failures).
    // Single-threaded here makes the pre-flight measure exactly what Stryker
    // runs and keeps the killing suite deterministic (the tribunal
    // pre-flight-stability condition). Pool files are the runtime tail by
    // design. (Vitest 4 removed poolOptions; maxWorkers is the top-level knob.)
    pool: 'threads',
    maxWorkers: 1,
    maxConcurrency: 1,
    fileParallelism: false,
  },
});

export default config;
