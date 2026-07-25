import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FrontendMessageBuffer } from './frontend-buffer.ts';

describe('FrontendMessageBuffer properties', () => {
  type BufferOp =
    | { op: 'push'; bytes: Uint8Array }
    | { op: 'consume'; length: number }
    | { op: 'read'; offset: number }
    | { op: 'clear' };

  // length/offset are constrained to integers: the model deliberately does not
  // specify NaN/Infinity/float behavior — production callers pass integers only.
  const opArb: fc.Arbitrary<BufferOp> = fc.oneof(
    {
      arbitrary: fc.record({
        op: fc.constant('push' as const),
        bytes: fc.uint8Array({ maxLength: 12 }),
      }),
      weight: 4,
    },
    {
      arbitrary: fc.record({
        op: fc.constant('consume' as const),
        length: fc.integer({ min: -2, max: 64 }),
      }),
      weight: 4,
    },
    {
      arbitrary: fc.record({
        op: fc.constant('read' as const),
        offset: fc.integer({ min: -2, max: 64 }),
      }),
      weight: 2,
    },
    { arbitrary: fc.record({ op: fc.constant('clear' as const) }), weight: 1 },
  );

  const readBE = (bytes: Uint8Array, offset: number): number =>
    new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);

  // minLength 80 keeps the compactChunks threshold (headIndex >= 32) reachable
  // for generated sequences; the deterministic case below pins it by construction.
  it('P8: conforms to a flat-buffer + cursor reference model', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 80, maxLength: 200 }), (ops) => {
        const buffer = new FrontendMessageBuffer();
        let model = new Uint8Array(0);
        let cursor = 0;
        for (const op of ops) {
          if (op.op === 'push') {
            buffer.push(op.bytes);
            const next = new Uint8Array(model.length + op.bytes.length);
            next.set(model, 0);
            next.set(op.bytes, model.length);
            model = next;
          } else if (op.op === 'consume') {
            if (op.length >= 0 && op.length <= model.length - cursor) {
              // Snapshot at call time: the fast path returns a live view into
              // the pushed chunk, the slow path a fresh copy — compare copies.
              const consumed = Uint8Array.from(buffer.consume(op.length));
              expect(consumed).toEqual(model.slice(cursor, cursor + op.length));
              cursor += op.length;
            } else {
              expect(() => buffer.consume(op.length)).toThrow(/Cannot consume/);
            }
          } else if (op.op === 'read') {
            const value = buffer.readUInt32BE(op.offset);
            if (op.offset >= 0 && cursor + op.offset + 4 <= model.length) {
              expect(value).toBe(readBE(model, cursor + op.offset));
            } else {
              expect(value).toBeUndefined();
            }
          } else {
            buffer.clear();
            model = new Uint8Array(0);
            cursor = 0;
          }
          expect(buffer.length).toBe(model.length - cursor);
        }
      }),
    );
  });

  it('drains past the 32-chunk compaction threshold with a tail remaining, then to empty', () => {
    const buffer = new FrontendMessageBuffer();
    const chunks = Array.from({ length: 70 }, (_, i) => Uint8Array.of(i, i + 1));
    const flat = new Uint8Array(140);
    for (const [i, chunk] of chunks.entries()) {
      flat.set(chunk, i * 2);
    }
    for (const chunk of chunks) {
      buffer.push(chunk);
    }
    expect(buffer.length).toBe(140);

    // 36 single-chunk consumes cross headIndex 35, where headIndex >= 32 &&
    // headIndex * 2 >= chunks.length first holds — the slice-compaction branch.
    for (let i = 0; i < 36; i++) {
      expect(Uint8Array.from(buffer.consume(2))).toEqual(flat.slice(i * 2, i * 2 + 2));
    }
    expect(buffer.length).toBe(68);
    expect(buffer.readUInt32BE(0)).toBe(readBE(flat, 72));

    // A full drain hits the headIndex === chunks.length reset branch.
    expect(Uint8Array.from(buffer.consume(68))).toEqual(flat.slice(72));
    expect(buffer.length).toBe(0);

    buffer.push(Uint8Array.of(9, 8, 7));
    expect(Uint8Array.from(buffer.consume(3))).toEqual(Uint8Array.of(9, 8, 7));
  });
});
