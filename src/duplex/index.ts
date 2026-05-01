/**
 * PGlite duplex stream.
 *
 * A Duplex stream that replaces the TCP socket in pg.Client, routing
 * wire protocol messages directly to an in-process PGlite instance.
 *
 * pg.Client writes wire protocol bytes → duplex frames messages →
 * PGlite processes via execProtocolRawStream → duplex pushes responses back.
 *
 * Extended Query Protocol pipelines (Parse→Bind→Describe→Execute→Sync) are
 * concatenated into a single buffer and sent as one atomic execProtocolRawStream
 * call within one runExclusive. This prevents portal interleaving between
 * concurrent streams AND reduces async overhead (1 WASM call instead of 5).
 *
 * The response from a batched pipeline contains spurious ReadyForQuery messages
 * after each sub-message (PGlite's single-user mode). These are stripped,
 * keeping only the final ReadyForQuery after Sync.
 */
export { BackendMessageFramer } from './backend-framer.ts';
export { FrontendMessageBuffer } from './frontend-buffer.ts';
export { PGliteDuplex } from './pglite-duplex.ts';
