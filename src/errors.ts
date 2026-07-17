/**
 * Typed public-boundary errors. Single-purpose module (leaf: imports
 * nothing from the package) so every layer can throw through it without
 * disturbing the `utils ← duplex ← pool ← pglite-bridge` dependency
 * direction. Protocol-invariant throws (duplex framing, pg-parity errors)
 * deliberately stay plain `Error` — they travel pg's own error channels
 * where class identity is invisible; see docs/api.md "Errors".
 */

/** Machine-readable discriminants for {@link PgBridgeError}. Stable within
 *  a major version: new codes may be added in minors; no code is renamed,
 *  removed, or re-assigned to a different failure without a major bump. */
export type PgBridgeErrorCode =
  | 'UNSUPPORTED_PG_INTERNALS'
  | 'BRIDGE_OPTIONS_REQUIRED'
  | 'POOL_NOT_IDLE'
  | 'INVALID_STATS_LEVEL'
  | 'SERVER_CLOSED'
  | 'SERVER_PGLITE_CLOSED'
  | 'PGLITE_CLOSED'
  | 'PGLITE_NOT_READY'
  | 'MIGRATIONS_UNAVAILABLE'
  | 'MIGRATIONS_APPLY_FAILED'
  | 'SNAPSHOT_INVALID';

/**
 * Error thrown at the bridge's user-actionable public boundaries
 * (misconfiguration, misuse, unusable inputs). `code` is the programmatic
 * discriminant — match on it, not on `message`, which is human-facing and
 * may be reworded in any release. No parameter properties: the project
 * compiles with `erasableSyntaxOnly`, so fields are declared and assigned
 * explicitly.
 */
export class PgBridgeError extends Error {
  override readonly name: string = 'PgBridgeError';
  readonly code: PgBridgeErrorCode;

  constructor(code: PgBridgeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
