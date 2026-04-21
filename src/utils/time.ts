/** Convert a nanosecond `bigint` (as returned by `process.hrtime.bigint()`) to milliseconds. */
export const nsToMs = (ns: bigint): number => Number(ns) / 1_000_000;
