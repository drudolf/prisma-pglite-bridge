/**
 * The `type` values the bridge passes to `process.emitWarning`. The names
 * themselves are public contract (each has a heading in
 * docs/troubleshooting.md whose text is exactly the name); this module
 * typo-proofs the emit sites and records the full set in one place.
 * Internal — not exported from the package barrel.
 */
import { TROUBLESHOOTING_DOC, withDocsTail } from './errors.ts';

export type BridgeWarningType =
  | 'PGliteBridgeAbandonedTransactionWarning'
  | 'PGliteBridgeSharedInstanceWarning'
  | 'PGliteBridgeLeakWarning';

/** Package-relative docs pointer for a warning type (slug = lowercased name). */
export const warningDocsPointer = (type: BridgeWarningType): string =>
  `${TROUBLESHOOTING_DOC}#${type.toLowerCase()}`;

/** Emit a bridge warning with its docs pointer appended to the message. */
export const emitBridgeWarning = (type: BridgeWarningType, message: string): void => {
  process.emitWarning(withDocsTail(message, warningDocsPointer(type)), { type });
};
