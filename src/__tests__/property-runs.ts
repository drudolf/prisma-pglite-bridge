// Reduced-numRuns knob for mutation runs (see
// .claude/plans/mutation-testing-duplex-pool.md). Property files route their
// explicit per-assert numRuns through this helper: normal `pnpm test` leaves
// FC_NUM_RUNS unset, so the default is returned byte-identically; the mutation
// config sets FC_NUM_RUNS=50 to shrink the reduced-suite runtime.
//
// __tests__/ placement keeps it out of the coverage gate and the unit glob,
// same as the arbitraries helpers.
export const propertyRuns = (defaultRuns: number): number => {
  const env = Number(process.env.FC_NUM_RUNS);
  return Number.isInteger(env) && env > 0 ? env : defaultRuns;
};
