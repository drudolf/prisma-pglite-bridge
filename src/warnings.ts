/**
 * The `type` values the bridge passes to `process.emitWarning`. The names
 * themselves are public contract (each is documented in
 * docs/troubleshooting.md); this union exists to typo-proof the emit sites
 * and record the full set in one place. Internal — not exported from the
 * package barrel.
 */
export type BridgeWarningType =
  | 'PGliteBridgeAbandonedTransactionWarning'
  | 'PGliteBridgeSharedInstanceWarning'
  | 'PGliteBridgeLeakWarning';
