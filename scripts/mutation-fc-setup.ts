import fc from 'fast-check';

// Mutation-run fast-check pinning (see
// .claude/plans/mutation-testing-duplex-pool.md). A fixed seed makes every
// mutant-run deterministic and diffable; the reduced global numRuns covers
// asserts that pass NO explicit value (which would otherwise default to 100).
// Explicit per-assert 500/300 sites are reduced separately via the FC_NUM_RUNS
// env knob routed through propertyRuns(). Merge with the existing global config
// so no other option is clobbered.
fc.configureGlobal({
  ...fc.readConfigureGlobal(),
  seed: 20260729,
  numRuns: 50,
});
