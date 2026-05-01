import { PG_FIRST_USER_OID, PG_TYPE_OID_CHAR, PG_TYPE_OID_TEXT } from './constants.ts';

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
 */
export const rewriteRowDescriptionInPlace = (buf: Buffer): void => {
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
