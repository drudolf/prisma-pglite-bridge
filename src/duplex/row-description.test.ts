import { describe, expect, it } from 'vitest';

import { rewriteRowDescriptionInPlace, rowDescriptionNeedsRewrite } from './row-description.ts';

const encodeMessage = (type: number, payload: Uint8Array): Uint8Array => {
  const result = new Uint8Array(1 + 4 + payload.length);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  result[0] = type;
  view.setUint32(1, 4 + payload.length);
  result.set(payload, 5);
  return result;
};

const encodeRowDescription = (
  fields: Array<{
    name: string;
    tableOID?: number;
    columnAttr?: number;
    oid: number;
    size: number;
  }>,
): Uint8Array => {
  const headerSize = 2;
  const perField = (f: (typeof fields)[number]) =>
    Buffer.byteLength(f.name) + 1 + 4 + 2 + 4 + 2 + 4 + 2;
  const payloadSize = headerSize + fields.reduce((sum, f) => sum + perField(f), 0);
  const payload = Buffer.alloc(payloadSize);
  payload.writeInt16BE(fields.length, 0);
  let p = 2;
  for (const f of fields) {
    const written = payload.write(f.name, p);
    p += written;
    payload[p++] = 0;
    payload.writeUInt32BE(f.tableOID ?? 0, p);
    p += 4;
    payload.writeInt16BE(f.columnAttr ?? 0, p);
    p += 2;
    payload.writeUInt32BE(f.oid, p);
    p += 4;
    payload.writeInt16BE(f.size, p);
    p += 2;
    payload.writeInt32BE(-1, p); // typeModifier
    p += 4;
    payload.writeInt16BE(0, p); // formatCode
    p += 2;
  }
  return encodeMessage(0x54, payload);
};

const readField = (frame: Uint8Array, fieldIndex: number) => {
  const buf = Buffer.from(frame);
  let p = 7; // type + length + fieldCount
  for (let i = 0; i < fieldIndex; i++) {
    while (buf[p] !== 0) p++;
    p += 1 + 4 + 2 + 4 + 2 + 4 + 2;
  }
  const nameStart = p;
  while (buf[p] !== 0) p++;
  const name = buf.subarray(nameStart, p).toString('utf8');
  p++;
  p += 4 + 2;
  const oid = buf.readUInt32BE(p);
  const size = buf.readInt16BE(p + 4);
  return { name, oid, size };
};

describe('rowDescriptionNeedsRewrite', () => {
  it('returns false for a buffer shorter than the minimal frame header', () => {
    expect(rowDescriptionNeedsRewrite(new Uint8Array(6))).toBe(false);
  });

  it('returns false for a sub-range shorter than the minimal frame header', () => {
    const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
    expect(rowDescriptionNeedsRewrite(frame, 0, 6)).toBe(false);
  });
});

describe('rewriteRowDescriptionInPlace', () => {
  it('leaves the frame byte-identical when no field needs a rewrite', () => {
    const frame = Buffer.from(
      encodeRowDescription([
        { name: 'flag', tableOID: 16384, oid: 18, size: 1 }, // user-table "char" — keep
        { name: 'name', tableOID: 16384, oid: 25, size: -1 }, // text — keep
      ]),
    );
    const before = Buffer.from(frame);

    rewriteRowDescriptionInPlace(frame);

    expect(frame.equals(before)).toBe(true);
  });

  it('widens only system-catalog "char" fields to text in place', () => {
    const frame = Buffer.from(
      encodeRowDescription([
        { name: 'id', tableOID: 0, oid: 23, size: 4 }, // int4 — keep
        { name: 'expr', tableOID: 0, oid: 18, size: 1 }, // computed "char" — keep
        { name: 'flag', tableOID: 16384, oid: 18, size: 1 }, // user-table "char" — keep
        { name: 'contype', tableOID: 2606, oid: 18, size: 1 }, // pg_constraint.contype — rewrite
      ]),
    );

    rewriteRowDescriptionInPlace(frame);

    expect(readField(frame, 0)).toEqual({ name: 'id', oid: 23, size: 4 });
    expect(readField(frame, 1)).toEqual({ name: 'expr', oid: 18, size: 1 });
    expect(readField(frame, 2)).toEqual({ name: 'flag', oid: 18, size: 1 });
    expect(readField(frame, 3)).toEqual({ name: 'contype', oid: 25, size: -1 });
  });
});
