// Frontend message types
const PARSE = 0x50; // P
const BIND = 0x42; // B
const DESCRIBE = 0x44; // D
const EXECUTE = 0x45; // E
const CLOSE = 0x43; // C
export const FLUSH = 0x48; // H
export const SYNC = 0x53; // S (frontend)
export const TERMINATE = 0x58; // X
export const QUERY = 0x51; // Q — simple protocol
export const COPY_DATA = 0x64; // d (both directions)
export const COPY_DONE = 0x63; // c (both directions)
export const COPY_FAIL = 0x66; // f (frontend)

// Backend message types
export const READY_FOR_QUERY = 0x5a; // Z — 6 bytes: Z + length(5) + status
export const ERROR_RESPONSE = 0x45; // E — signals in-band SQL error (not a JS throw)
export const ROW_DESCRIPTION = 0x54; // T — column metadata; rewritten to widen oid 18
export const COPY_IN_RESPONSE = 0x47; // G — backend enters copy-in mode

// ReadyForQuery transaction status bytes (RFC: pg wire protocol §53.7)
export const RFQ_STATUS_IDLE = 0x49; // 'I' — no transaction
export const RFQ_STATUS_IN_TRANSACTION = 0x54; // 'T' — in transaction block
export const RFQ_STATUS_FAILED = 0x45; // 'E' — failed transaction block

// pg_catalog system columns (pg_constraint.contype, pg_type.typtype, pg_class.relkind,
// etc.) report type oid 18 ("char", 1-byte). @prisma/adapter-pg's fieldToColumnType
// has no case for oid 18 and throws UnsupportedNativeDataType. The bytes on the wire
// for these single-ASCII-char values decode identically as text, so we widen oid 18
// to oid 25 (text) in RowDescription frames before pg.Client sees them — but only
// when the field originates from a pg_catalog relation (tableOID below
// FirstNormalObjectId). User-defined "char" columns are left untouched so the
// upstream type-mapping gap surfaces instead of being silently papered over with a
// possibly-lossy text decode. Remove this rewrite once @prisma/adapter-pg gains a
// fieldToColumnType case for oid 18.
export const PG_TYPE_OID_CHAR = 18;
export const PG_TYPE_OID_TEXT = 25;
// Mirrors PostgreSQL's FirstNormalObjectId (src/include/access/transam.h): every
// system catalog relation has an OID below this; user-created objects start at it.
export const PG_FIRST_USER_OID = 16384;

// Extended Query Protocol message types — batched until a Sync or Flush
// boundary. Flush is a boundary, not a member: pg drives row-limited
// executions (rows: N, pg-cursor) with Flush and waits for the response.
export const EQP_MESSAGES: ReadonlySet<number> = new Set([PARSE, BIND, DESCRIBE, EXECUTE, CLOSE]);

/**
 * Upper bound on a single wire-protocol message length declared in its
 * 4-byte header — applied to backend messages by the framer and to
 * frontend/startup messages by the duplex. PostgreSQL's own wire protocol
 * maxes out around 1 GiB per message; anything larger indicates a
 * corrupted or hostile stream and must not be allocated against.
 */
export const MAX_MESSAGE_LENGTH = 1_073_741_824;

/**
 * Default cap on the AGGREGATE bytes a `COPY ... FROM STDIN` capture may
 * buffer before execution (the whole copy conversation must reach PGlite
 * as one call — the WASM backend treats an exhausted input buffer
 * mid-COPY as connection EOF and exits). Deliberately far below
 * {@link MAX_MESSAGE_LENGTH}: assembly transiently holds ~2× the payload
 * (captured messages plus the concatenated batch), and PGlite's WASM
 * heap (which also holds the database itself) tops out around 2 GiB.
 * Breaching the cap degrades
 * to a synthesized in-band error after the client finishes sending —
 * never a teardown. Override per duplex via
 * `PGliteDuplexOptions.copyAggregateCapBytes`.
 */
export const MAX_COPY_AGGREGATE_BYTES = 268_435_456;
