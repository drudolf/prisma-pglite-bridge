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
  | 'SERVER_NOT_IDLE'
  | 'PGLITE_CLOSED'
  | 'PGLITE_NOT_READY'
  | 'MIGRATIONS_UNAVAILABLE'
  | 'MIGRATIONS_APPLY_FAILED'
  | 'MIGRATIONS_HISTORY_INVALID'
  | 'SNAPSHOT_INVALID'
  | 'TEMPLATE_LOAD_FAILED';

/**
 * Package-relative path of the troubleshooting guide, as shipped in the npm
 * tarball. Resolves under `node_modules/` in any node_modules layout and is
 * an unambiguous grep target everywhere else (Yarn PnP, bundlers).
 */
export const TROUBLESHOOTING_DOC = 'prisma-pglite-bridge/docs/troubleshooting.md';

/**
 * Every code's troubleshooting anchor is the lowercased code: each code has
 * a heading in docs/troubleshooting.md whose text is exactly the code, so
 * the GitHub slug equals this by construction. `src/errors-docs.test.ts`
 * asserts every anchor resolves to a real heading.
 */
export const errorDocsPointer = (code: PgBridgeErrorCode): string =>
  `${TROUBLESHOOTING_DOC}#${code.toLowerCase()}`;

/**
 * Append the docs pointer to a human-facing message. Multi-line messages
 * (bulleted diagnostics) get the tail on its own line so it never fuses
 * onto the last bullet.
 */
export const withDocsTail = (message: string, pointer: string): string =>
  `${message}${message.includes('\n') ? '\n' : ' '}(docs: ${pointer})`;

/**
 * Error thrown at the bridge's user-actionable public boundaries
 * (misconfiguration, misuse, unusable inputs). `code` is the programmatic
 * discriminant — match on it, not on `message`, which is human-facing and
 * may be reworded in any release. Every message ends with a pointer into
 * the bundled troubleshooting guide; the same pointer is exposed as `docs`.
 * No parameter properties: the project compiles with `erasableSyntaxOnly`,
 * so fields are declared and assigned explicitly.
 */
export class PgBridgeError extends Error {
  override readonly name: string = 'PgBridgeError';
  readonly code: PgBridgeErrorCode;
  /** Package-relative docs pointer, e.g. `prisma-pglite-bridge/docs/troubleshooting.md#pool_not_idle`. */
  readonly docs: string;

  constructor(code: PgBridgeErrorCode, message: string, options?: ErrorOptions) {
    const docs = errorDocsPointer(code);
    super(withDocsTail(message, docs), options);
    this.code = code;
    this.docs = docs;
  }
}
