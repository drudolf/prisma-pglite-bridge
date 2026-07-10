import { PG_FIRST_USER_OID, PG_TYPE_OID_CHAR, PG_TYPE_OID_TEXT } from './constants.ts';

const readUInt32BE = (buf: Uint8Array, offset: number): number => {
  /* c8 ignore start — callers guard fixed-width reads */
  const b1 = buf[offset] ?? 0;
  const b2 = buf[offset + 1] ?? 0;
  const b3 = buf[offset + 2] ?? 0;
  const b4 = buf[offset + 3] ?? 0;
  /* c8 ignore stop */
  return ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
};

const readUInt16BE = (buf: Uint8Array, offset: number): number => {
  /* c8 ignore start — callers guard fixed-width reads */
  const b1 = buf[offset] ?? 0;
  const b2 = buf[offset + 1] ?? 0;
  /* c8 ignore stop */
  return (b1 << 8) | b2;
};

export const rowDescriptionNeedsRewrite = (
  buf: Uint8Array,
  start: number = 0,
  end: number = buf.length,
): boolean => {
  if (end - start < 7) return false;

  const fieldCount = readUInt16BE(buf, start + 5);
  let p = start + 7;
  for (let i = 0; i < fieldCount; i++) {
    while (p < end && buf[p] !== 0) p++;
    p++; // NUL terminator
    /* c8 ignore next — defense-in-depth: framer caller passes a complete frame */
    if (p + 18 > end) return false;
    const tableOID = readUInt32BE(buf, p);
    p += 4 + 2; // tableOID, columnAttr
    const oid = readUInt32BE(buf, p);
    if (oid === PG_TYPE_OID_CHAR && tableOID !== 0 && tableOID < PG_FIRST_USER_OID) {
      return true;
    }
    p += 4 + 2 + 4 + 2; // dataTypeOID, dataTypeSize, typeModifier, formatCode
  }

  return false;
};

/**
 * Widens any field whose dataTypeOID is 18 ("char") to oid 25 (text) — but
 * only when the field originates from a pg_catalog relation (tableOID is
 * non-zero and below FirstNormalObjectId). Single-ASCII-byte payloads from
 * pg_catalog views (pg_constraint.contype, pg_type.typtype, etc.) decode
 * identically as text, so the row data needs no transformation. Fields with
 * tableOID === 0 (computed expressions) and user-table fields are left
 * untouched, since arbitrary bytes in user "char" data can't safely be
 * relabelled as text. Frame length is unchanged because all rewrites are
 * fixed-size in place.
 *
 * Walks unconditionally — the loop's per-field guard is the filter. Callers
 * that need to avoid copying a frame gate on {@link
 * rowDescriptionNeedsRewrite} first (the framer's zero-copy fast path);
 * callers that already hold an owned buffer just call this.
 */
export const rewriteRowDescriptionInPlace = (buf: Buffer): void => {
  // A complete RowDescription is at least 7 bytes (type byte, int32 length,
  // int16 field count); pass a shorter, protocol-invalid frame through
  // untouched instead of throwing RangeError on the field-count read.
  if (buf.length < 7) return;
  const fieldCount = buf.readInt16BE(5);
  let p = 7;
  for (let i = 0; i < fieldCount; i++) {
    while (p < buf.length && buf[p] !== 0) p++;
    p++; // NUL terminator
    // Per-field fixed suffix is 18 bytes: tableOID(4) + columnAttr(2) +
    // dataTypeOID(4) + dataTypeSize(2) + typeModifier(4) + formatCode(2).
    // Bail if the frame is truncated rather than throwing RangeError mid-loop.
    /* c8 ignore next — defense-in-depth: framer caller passes a complete frame */
    if (p + 18 > buf.length) return;
    const tableOID = buf.readUInt32BE(p);
    p += 4 + 2; // tableOID, columnAttr
    const oid = buf.readUInt32BE(p);
    if (oid === PG_TYPE_OID_CHAR && tableOID !== 0 && tableOID < PG_FIRST_USER_OID) {
      buf.writeUInt32BE(PG_TYPE_OID_TEXT, p);
      buf.writeInt16BE(-1, p + 4);
    }
    p += 4 + 2 + 4 + 2; // dataTypeOID, dataTypeSize, typeModifier, formatCode
  }
};
