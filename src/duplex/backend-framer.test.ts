import { describe, expect, it } from 'vitest';

import { BackendMessageFramer } from './backend-framer.ts';

describe('BackendMessageFramer', () => {
  const encodeMessage = (type: number, payload: Uint8Array): Uint8Array => {
    const result = new Uint8Array(1 + 4 + payload.length);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    result[0] = type;
    view.setUint32(1, 4 + payload.length);
    result.set(payload, 5);
    return result;
  };

  const splitEvery = (input: Uint8Array, size: number): Uint8Array[] => {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < input.length; offset += size) {
      chunks.push(input.subarray(offset, offset + size));
    }
    return chunks;
  };

  const collect = (chunks: Uint8Array[]): Uint8Array => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  };

  const makeHarness = (suppressIntermediateReadyForQuery = false) => {
    const outputs: Uint8Array[] = [];
    const statuses: number[] = [];
    let errorCount = 0;
    const framer = new BackendMessageFramer({
      suppressIntermediateReadyForQuery,
      onChunk: (chunk) => outputs.push(chunk.slice()),
      onErrorResponse: () => {
        errorCount++;
      },
      onReadyForQuery: (status) => {
        statuses.push(status);
      },
    });

    return {
      framer,
      outputs,
      statuses,
      get errorCount() {
        return errorCount;
      },
    };
  };

  const RFQ_IDLE = encodeMessage(0x5a, new Uint8Array([0x49]));
  const RFQ_FAILED = encodeMessage(0x5a, new Uint8Array([0x45]));
  const DATA = encodeMessage(0x44, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
  const ERROR = encodeMessage(0x45, new Uint8Array([0x53, 0x62, 0x6f, 0x6f, 0x6d, 0x00]));

  it('ignores zero-length chunks', () => {
    const { framer, outputs, statuses, errorCount } = makeHarness();
    framer.write(new Uint8Array(0));
    framer.flush();
    expect(outputs).toHaveLength(0);
    expect(statuses).toEqual([]);
    expect(errorCount).toBe(0);
  });

  it('handles a type byte alone, then length and payload', () => {
    const { framer, outputs } = makeHarness();
    framer.write(DATA.subarray(0, 1));
    expect(outputs).toHaveLength(0);
    framer.write(DATA.subarray(1));
    framer.flush();
    expect(collect(outputs)).toEqual(DATA);
  });

  it('handles a split in the middle of the length prefix', () => {
    const { framer, outputs } = makeHarness();
    framer.write(DATA.subarray(0, 3));
    expect(outputs).toHaveLength(0);
    framer.write(DATA.subarray(3));
    framer.flush();
    expect(collect(outputs)).toEqual(DATA);
  });

  it('emits header-only chunks without buffering the payload', () => {
    const payload = new Uint8Array([0xaa]);
    const message = encodeMessage(0x43, payload);
    const { framer, outputs } = makeHarness();
    framer.write(message.subarray(0, 5));
    expect(outputs.map((chunk) => chunk.length)).toEqual([5]);
    framer.write(message.subarray(5));
    framer.flush();
    expect(collect(outputs)).toEqual(message);
  });

  it('tracks ReadyForQuery only after the full frame arrives', () => {
    const { framer, outputs, statuses } = makeHarness();
    framer.write(RFQ_IDLE.subarray(0, 3));
    expect(outputs).toHaveLength(0);
    expect(statuses).toEqual([]);
    framer.write(RFQ_IDLE.subarray(3));
    framer.flush();
    expect(statuses).toEqual([0x49]);
    expect(collect(outputs)).toEqual(RFQ_IDLE);
  });

  it('drops intermediate RFQs and keeps the final one when suppression is enabled', () => {
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(RFQ_IDLE.subarray(0, 3));
    framer.write(RFQ_IDLE.subarray(3));
    framer.write(DATA);
    framer.write(RFQ_FAILED);
    framer.flush();
    expect(statuses).toEqual([0x49, 0x45]);
    expect(collect(outputs)).toEqual(collect([DATA, RFQ_FAILED]));
  });

  it('handles multiple back-to-back RFQs when the last one is split', () => {
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(RFQ_IDLE);
    framer.write(RFQ_FAILED.subarray(0, 3));
    framer.write(RFQ_FAILED.subarray(3));
    framer.flush();
    expect(statuses).toEqual([0x49, 0x45]);
    expect(collect(outputs)).toEqual(RFQ_FAILED);
  });

  it('emits a final RFQ when it is the last bytes in the stream', () => {
    const { framer, outputs } = makeHarness(true);
    framer.write(DATA);
    framer.write(RFQ_IDLE);
    framer.flush();
    expect(collect(outputs)).toEqual(collect([DATA, RFQ_IDLE]));
  });

  it('detects ErrorResponse at header decode time before forwarding payload bytes', () => {
    const events: string[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => events.push(`chunk:${chunk.length}`),
      onErrorResponse: () => {
        events.push('error');
      },
    });

    framer.write(ERROR.subarray(0, 1));
    framer.write(ERROR.subarray(1, 5));
    framer.write(ERROR.subarray(5));
    framer.flush();

    expect(events[0]).toBe('error');
    expect(events.slice(1)).toEqual(['chunk:5', `chunk:${ERROR.length - 5}`]);
  });

  it('forwards large payloads in streaming chunks instead of one large allocation', () => {
    const payload = new Uint8Array(64 * 1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i % 251;
    }
    const largeMessage = encodeMessage(0x44, payload);
    const chunks = splitEvery(largeMessage, 4 * 1024);
    const { framer, outputs } = makeHarness();

    for (const chunk of chunks) {
      framer.write(chunk);
    }
    framer.flush();

    expect(collect(outputs)).toEqual(largeMessage);
    expect(Math.max(...outputs.map((chunk) => chunk.length))).toBeLessThanOrEqual(4 * 1024);
    expect(outputs.length).toBeGreaterThan(4);
  });

  it('coalesces contiguous in-chunk messages into one copied slice', () => {
    const combined = collect([DATA, encodeMessage(0x43, new Uint8Array([0xaa]))]);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(combined);
    framer.flush();

    expect(collect(outputs)).toEqual(combined);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.buffer).not.toBe(combined.buffer);
  });

  it('emitted output survives producer reuse of the source buffer', () => {
    // The corruption scenario the mandatory copy prevents: a producer that
    // hands a chunk owning its full backing store, then overwrites that
    // memory after write() returns (PGlite reuses its flush buffer this way).
    const source = new Uint8Array(DATA.length);
    source.set(DATA);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(source);
    framer.flush();
    source.fill(0xff);

    expect(collect(outputs)).toEqual(DATA);
  });

  it('copies whole-message slices when the chunk is a view into a larger buffer', () => {
    const padded = new Uint8Array(DATA.length + 4);
    padded.set(DATA, 2);
    const viewChunk = padded.subarray(2, 2 + DATA.length);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(viewChunk);
    framer.flush();

    expect(collect(outputs)).toEqual(DATA);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.buffer).not.toBe(padded.buffer);
  });

  it('does not treat a non-RFQ 0x5a frame as ReadyForQuery in the fast path', () => {
    const malformedZ = encodeMessage(0x5a, new Uint8Array([0x49, 0xaa]));
    const { framer, outputs, statuses } = makeHarness();

    framer.write(malformedZ);
    framer.flush();

    expect(statuses).toEqual([]);
    expect(collect(outputs)).toEqual(malformedZ);
  });

  it('does not treat a non-RFQ 0x5a frame as ReadyForQuery in the slow path', () => {
    // Split so the countdown passes through payloadBytesRemaining === 1 at a
    // chunk boundary — deriving RFQ-ness from the countdown (instead of the
    // header-decode latch) reclassified the frame mid-payload here.
    const malformedZ = encodeMessage(0x5a, new Uint8Array([0x49, 0xaa]));
    const { framer, outputs, statuses } = makeHarness();

    framer.write(malformedZ.subarray(0, 6));
    framer.write(malformedZ.subarray(6));
    framer.flush();

    expect(statuses).toEqual([]);
    expect(collect(outputs)).toEqual(malformedZ);
  });

  it('does not leak stale held-RFQ state into a split non-RFQ 0x5a frame after a real RFQ', () => {
    const malformedZ = encodeMessage(0x5a, new Uint8Array([0x49, 0xaa]));
    const { framer, outputs, statuses } = makeHarness(true);

    framer.write(RFQ_IDLE);
    framer.write(malformedZ.subarray(0, 6));
    framer.write(malformedZ.subarray(6));
    framer.flush();

    expect(statuses).toEqual([0x49]);
    expect(collect(outputs)).toEqual(malformedZ);
  });

  it('copies when the chunk is backed by a SharedArrayBuffer', () => {
    const shared = new SharedArrayBuffer(DATA.length);
    const sharedChunk = new Uint8Array(shared);
    sharedChunk.set(DATA);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(sharedChunk);
    framer.flush();

    expect(collect(outputs)).toEqual(DATA);
    for (const chunk of outputs) {
      expect(chunk.buffer).not.toBe(shared);
      expect(chunk.buffer instanceof SharedArrayBuffer).toBe(false);
    }
  });

  it('throws on a backend message with a length header < 4', () => {
    const { framer } = makeHarness();
    const malformed = new Uint8Array([0x44, 0x00, 0x00, 0x00, 0x03]);
    expect(() => framer.write(malformed)).toThrow(/Malformed backend message length: 3/);
  });

  it('throws when the backend message length header exceeds the 1 GiB sanity cap', () => {
    const { framer } = makeHarness();
    const tooLarge = new Uint8Array([0x44, 0x7f, 0xff, 0xff, 0xff]);
    expect(() => framer.write(tooLarge)).toThrow(/exceeds sanity cap/);
  });

  it('throws on a malformed length header assembled via the slow path', () => {
    const { framer } = makeHarness();
    framer.write(new Uint8Array([0x44]));
    expect(() => framer.write(new Uint8Array([0x00, 0x00, 0x00, 0x03]))).toThrow(
      /Malformed backend message length: 3/,
    );
  });

  it('throws on an oversized length header assembled via the slow path', () => {
    const { framer } = makeHarness();
    framer.write(new Uint8Array([0x44]));
    expect(() => framer.write(new Uint8Array([0x7f, 0xff, 0xff, 0xff]))).toThrow(
      /exceeds sanity cap/,
    );
  });

  it('finishes a zero-payload message whose header arrives split across chunks', () => {
    const { framer, outputs } = makeHarness();
    // CopyDone ('c') has length == 4 (header only, no payload).
    framer.write(new Uint8Array([0x63]));
    framer.write(new Uint8Array([0x00, 0x00, 0x00, 0x04]));
    framer.flush();
    expect(collect(outputs)).toEqual(new Uint8Array([0x63, 0x00, 0x00, 0x00, 0x04]));
  });

  it('drops a held final RFQ when flush is asked to discard it', () => {
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(DATA);
    framer.write(RFQ_IDLE);
    expect(outputs.some((chunk) => chunk.length === RFQ_IDLE.length)).toBe(false);
    framer.flush({ dropHeldReadyForQuery: true });
    expect(statuses).toEqual([0x49]);
    expect(collect(outputs)).toEqual(DATA);
  });

  describe('end-of-stream framing', () => {
    const completeThenTail = collect([DATA, ERROR, DATA.subarray(0, 6)]);
    it.each([
      ...[1, 2, 3, 4].map((received) => ({
        name: `${received} byte(s) of a frame prefix`,
        input: DATA.subarray(0, received),
        expected: 'at least 5',
        received,
        emitted: new Uint8Array(0),
      })),
      {
        name: 'a partial payload',
        input: DATA.subarray(0, 7),
        expected: DATA.length,
        received: 7,
        emitted: DATA.subarray(0, 7),
      },
      {
        name: 'multiple complete frames followed by a truncated tail',
        input: completeThenTail,
        expected: DATA.length,
        received: 6,
        emitted: completeThenTail,
      },
    ])('rejects $name at EOF', ({ input, expected, received, emitted }) => {
      const { framer, outputs } = makeHarness();
      framer.write(input);

      expect(() => framer.flush()).toThrow(
        new RegExp(
          `Incomplete backend message.*expected ${expected} bytes.*received ${received}`,
          'i',
        ),
      );
      expect(collect(outputs)).toEqual(emitted);
    });

    it('accepts exact complete frames across arbitrary chunk sizes', () => {
      const stream = collect([DATA, RFQ_IDLE, ERROR]);

      for (let chunkSize = 1; chunkSize <= stream.length; chunkSize++) {
        const { framer, outputs } = makeHarness();
        for (const chunk of splitEvery(stream, chunkSize)) {
          framer.write(chunk);
        }

        expect(() => framer.flush()).not.toThrow();
        expect(collect(outputs)).toEqual(stream);
      }
    });

    it('does not let flush-boundary RFQ dropping mask a truncated ReadyForQuery', () => {
      const receivedBytes = RFQ_IDLE.length - 1;
      const { framer, outputs, statuses } = makeHarness(true);
      framer.write(RFQ_IDLE.subarray(0, receivedBytes));

      expect(() => framer.flush({ dropHeldReadyForQuery: true })).toThrow(
        new RegExp(
          `Incomplete backend message.*expected ${RFQ_IDLE.length} bytes.*received ${receivedBytes}`,
          'i',
        ),
      );
      expect(outputs).toHaveLength(0);
      expect(statuses).toEqual([]);
    });
  });

  // RowDescription rewrite — widens "char" (oid 18) → text (oid 25). Required so the
  // official @prisma/adapter-pg can decode pg_catalog system columns (e.g.
  // pg_constraint.contype) during introspection / db push.
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

  it('rewrites a single oid-18 column to oid 25 with size -1', () => {
    const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
    const { framer, outputs } = makeHarness();
    framer.write(frame);
    framer.flush();
    const emitted = collect(outputs);
    expect(emitted).toHaveLength(frame.length);
    const field = readField(emitted, 0);
    expect(field).toEqual({ name: 'contype', oid: 25, size: -1 });
  });

  it('rewrites only oid-18 fields and leaves others untouched', () => {
    const frame = encodeRowDescription([
      { name: 'id', oid: 23, size: 4 }, // int4 — keep
      { name: 'kind', tableOID: 1259, oid: 18, size: 1 }, // pg_class.relkind — rewrite
      { name: 'name', oid: 25, size: -1 }, // text — keep
      { name: 'flag', tableOID: 2606, oid: 18, size: 1 }, // pg_constraint.contype — rewrite
    ]);
    const { framer, outputs } = makeHarness();
    framer.write(frame);
    framer.flush();
    const emitted = collect(outputs);
    expect(readField(emitted, 0)).toEqual({ name: 'id', oid: 23, size: 4 });
    expect(readField(emitted, 1)).toEqual({ name: 'kind', oid: 25, size: -1 });
    expect(readField(emitted, 2)).toEqual({ name: 'name', oid: 25, size: -1 });
    expect(readField(emitted, 3)).toEqual({ name: 'flag', oid: 25, size: -1 });
  });

  it('passes through a RowDescription with zero fields', () => {
    const frame = encodeRowDescription([]);
    const { framer, outputs } = makeHarness();
    framer.write(frame);
    framer.flush();
    expect(collect(outputs)).toEqual(frame);
  });

  it('passes through a RowDescription without catalog char rewrites as a single copied slice', () => {
    const frame = encodeRowDescription([
      { name: 'id', tableOID: 16384, oid: 23, size: 4 },
      { name: 'name', tableOID: 16384, oid: 25, size: -1 },
    ]);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(frame);
    framer.flush();

    expect(collect(outputs)).toEqual(frame);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.buffer).not.toBe(frame.buffer);
  });

  it('coalesces a no-rewrite RowDescription with adjacent pass-through messages', () => {
    const frame = encodeRowDescription([{ name: 'id', tableOID: 16384, oid: 23, size: 4 }]);
    const combined = collect([DATA, frame, DATA]);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(combined);
    framer.flush();

    expect(collect(outputs)).toEqual(combined);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.buffer).not.toBe(combined.buffer);
  });

  it('preserves frame length when rewriting (no length header changes)', () => {
    const frame = encodeRowDescription([
      { name: 'a', tableOID: 2606, oid: 18, size: 1 },
      { name: 'longer_name', tableOID: 2606, oid: 18, size: 1 },
    ]);
    const originalLength = Buffer.from(frame).readUInt32BE(1);
    const { framer, outputs } = makeHarness();
    framer.write(frame);
    framer.flush();
    const emitted = collect(outputs);
    expect(emitted.length).toBe(frame.length);
    expect(Buffer.from(emitted).readUInt32BE(1)).toBe(originalLength);
  });

  it('rewrites a RowDescription that arrives mid-passthrough alongside other messages', () => {
    const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
    const combined = collect([DATA, frame, DATA]);
    const { framer, outputs } = makeHarness();
    framer.write(combined);
    framer.flush();
    const emitted = collect(outputs);
    expect(emitted.length).toBe(combined.length);
    // Locate the T frame inside emitted bytes by scanning for the type byte.
    const tStart = DATA.length;
    const rewrittenField = readField(emitted.subarray(tStart), 0);
    expect(rewrittenField).toEqual({ name: 'contype', oid: 25, size: -1 });
  });

  it('rewrites a RowDescription split across two chunks (slow path)', () => {
    const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
    // Split mid-payload so the slow path drives both header decode and payload accumulation.
    const splitAt = Math.floor(frame.length / 2);
    expect(splitAt).toBeGreaterThan(5); // ensure we split inside the payload
    const { framer, outputs } = makeHarness();
    framer.write(frame.subarray(0, splitAt));
    framer.write(frame.subarray(splitAt));
    framer.flush();
    const emitted = collect(outputs);
    expect(emitted.length).toBe(frame.length);
    expect(readField(emitted, 0)).toEqual({ name: 'contype', oid: 25, size: -1 });
  });

  it('rewrites a RowDescription delivered byte-by-byte', () => {
    const frame = encodeRowDescription([
      { name: 'k', tableOID: 2606, oid: 18, size: 1 },
      { name: 'v', oid: 25, size: -1 },
      { name: 'flag', tableOID: 2606, oid: 18, size: 1 },
    ]);
    const { framer, outputs } = makeHarness();
    for (let i = 0; i < frame.length; i++) {
      framer.write(frame.subarray(i, i + 1));
    }
    framer.flush();
    const emitted = collect(outputs);
    expect(emitted.length).toBe(frame.length);
    expect(readField(emitted, 0)).toEqual({ name: 'k', oid: 25, size: -1 });
    expect(readField(emitted, 1)).toEqual({ name: 'v', oid: 25, size: -1 });
    expect(readField(emitted, 2)).toEqual({ name: 'flag', oid: 25, size: -1 });
  });

  it('rewrites a RowDescription whose 5-byte header is split across chunks', () => {
    const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
    const { framer, outputs } = makeHarness();
    framer.write(frame.subarray(0, 3)); // type byte + 2 bytes of length header
    framer.write(frame.subarray(3));
    framer.flush();
    const emitted = collect(outputs);
    expect(emitted.length).toBe(frame.length);
    expect(readField(emitted, 0)).toEqual({ name: 'contype', oid: 25, size: -1 });
  });

  it('leaves an oid-18 field with tableOID 0 untouched (computed expression)', () => {
    const frame = encodeRowDescription([{ name: 'expr', tableOID: 0, oid: 18, size: 1 }]);
    const { framer, outputs } = makeHarness();
    framer.write(frame);
    framer.flush();
    const emitted = collect(outputs);
    expect(emitted.length).toBe(frame.length);
    expect(readField(emitted, 0)).toEqual({ name: 'expr', oid: 18, size: 1 });
  });

  it('leaves an oid-18 field from a user table untouched (tableOID >= 16384)', () => {
    const frame = encodeRowDescription([{ name: 'flag', tableOID: 16384, oid: 18, size: 1 }]);
    const { framer, outputs } = makeHarness();
    framer.write(frame);
    framer.flush();
    const emitted = collect(outputs);
    expect(emitted.length).toBe(frame.length);
    expect(readField(emitted, 0)).toEqual({ name: 'flag', oid: 18, size: 1 });
  });

  it('drops a held intermediate RFQ before emitting a rewritten RowDescription', () => {
    const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(RFQ_IDLE);
    framer.write(frame);
    framer.write(RFQ_FAILED);
    framer.flush();
    expect(statuses).toEqual([0x49, 0x45]);
    // Expect: rewritten T frame, then final RFQ_FAILED. The intermediate RFQ_IDLE is dropped.
    const emitted = collect(outputs);
    expect(emitted.length).toBe(frame.length + RFQ_FAILED.length);
    expect(readField(emitted, 0)).toEqual({ name: 'contype', oid: 25, size: -1 });
  });

  it('drops a held intermediate RFQ before emitting a chunked rewritten RowDescription', () => {
    const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
    const splitAt = Math.floor(frame.length / 2);
    expect(splitAt).toBeGreaterThan(5); // ensure the split lands inside the payload
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(RFQ_IDLE);
    framer.write(frame.subarray(0, splitAt));
    framer.write(frame.subarray(splitAt));
    framer.write(RFQ_FAILED);
    framer.flush();
    expect(statuses).toEqual([0x49, 0x45]);
    const emitted = collect(outputs);
    expect(emitted.length).toBe(frame.length + RFQ_FAILED.length);
    expect(readField(emitted, 0)).toEqual({ name: 'contype', oid: 25, size: -1 });
  });

  // Native clients (e.g. the Prisma CLI schema engine) need the real oid 18 —
  // the 18→25 widening exists only for @prisma/adapter-pg, so it must be
  // switchable off via `rewriteSystemCatalogCharOids` (default `true`).
  describe('rewriteSystemCatalogCharOids option', () => {
    const makeOptionHarness = (rewriteSystemCatalogCharOids: boolean) => {
      const outputs: Uint8Array[] = [];
      const framer = new BackendMessageFramer({
        rewriteSystemCatalogCharOids,
        onChunk: (chunk) => outputs.push(chunk.slice()),
      });
      return { framer, outputs };
    };

    it('emits a system-catalog char RowDescription byte-identical when disabled (fast path)', () => {
      const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
      const { framer, outputs } = makeOptionHarness(false);
      framer.write(frame);
      framer.flush();
      const emitted = collect(outputs);
      expect(emitted).toEqual(frame);
      expect(readField(emitted, 0)).toEqual({ name: 'contype', oid: 18, size: 1 });
    });

    it('emits a split system-catalog char RowDescription byte-identical when disabled (slow path)', () => {
      const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
      const splitAt = Math.floor(frame.length / 2);
      expect(splitAt).toBeGreaterThan(5); // ensure the split lands inside the payload
      const { framer, outputs } = makeOptionHarness(false);
      framer.write(frame.subarray(0, splitAt));
      framer.write(frame.subarray(splitAt));
      framer.flush();
      const emitted = collect(outputs);
      expect(emitted).toEqual(frame);
      expect(readField(emitted, 0)).toEqual({ name: 'contype', oid: 18, size: 1 });
    });

    it('still rewrites system-catalog char oids when the option is explicitly true', () => {
      const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
      const { framer, outputs } = makeOptionHarness(true);
      framer.write(frame);
      framer.flush();
      const emitted = collect(outputs);
      expect(emitted).toHaveLength(frame.length);
      expect(readField(emitted, 0)).toEqual({ name: 'contype', oid: 25, size: -1 });
    });
  });

  // reset() reuse contract — PGliteDuplex will hold ONE framer for its whole
  // lifetime and call reset(suppress) at the start of each protocol call
  // instead of constructing a fresh framer per call. reset() must clear all
  // per-stream state (framing progress, held RFQ, RowDescription accumulator)
  // and apply the suppression flag for the upcoming stream.
  describe('reset', () => {
    const writeSuppressedStream = (framer: BackendMessageFramer): void => {
      // Mirrors 'drops intermediate RFQs and keeps the final one when
      // suppression is enabled': split intermediate RFQ, data, final RFQ.
      framer.write(RFQ_IDLE.subarray(0, 3));
      framer.write(RFQ_IDLE.subarray(3));
      framer.write(DATA);
      framer.write(RFQ_FAILED);
      framer.flush();
    };

    // Carries an intermediate RFQ so the suppression flag applied by reset()
    // is observable in the collected bytes: suppression OFF must emit it,
    // suppression ON would drop it.
    const writeUnsuppressedStream = (framer: BackendMessageFramer): void => {
      framer.write(DATA);
      framer.write(RFQ_IDLE);
      framer.write(DATA);
      framer.write(RFQ_FAILED);
      framer.flush();
    };

    it('a framer reused across two streams matches fresh framers configured per stream', () => {
      const reused = makeHarness(true);
      writeSuppressedStream(reused.framer);
      const reusedFirst = collect(reused.outputs.splice(0));
      reused.framer.reset(false);
      writeUnsuppressedStream(reused.framer);
      const reusedSecond = collect(reused.outputs.splice(0));

      const freshSuppressed = makeHarness(true);
      writeSuppressedStream(freshSuppressed.framer);
      const freshUnsuppressed = makeHarness(false);
      writeUnsuppressedStream(freshUnsuppressed.framer);

      expect(reusedFirst).toEqual(collect(freshSuppressed.outputs));
      expect(reusedSecond).toEqual(collect(freshUnsuppressed.outputs));
    });

    it('discards mid-message framing state', () => {
      const { framer, outputs } = makeHarness();
      // Type byte + 2 length bytes: header incomplete, nothing emitted yet.
      framer.write(DATA.subarray(0, 3));
      framer.reset(false);
      framer.write(DATA);
      framer.flush();
      expect(collect(outputs)).toEqual(DATA);
    });

    it('recovers after write throws on a malformed length header', () => {
      const { framer, outputs } = makeHarness();
      // Slow path: the type byte is consumed before the malformed length
      // arrives, so the throw leaves the framer stuck mid-message.
      framer.write(new Uint8Array([0x44]));
      expect(() => framer.write(new Uint8Array([0x00, 0x00, 0x00, 0x03]))).toThrow(
        /Malformed backend message length: 3/,
      );
      framer.reset(false);
      framer.write(DATA);
      framer.flush();
      expect(collect(outputs)).toEqual(DATA);
    });

    it('drops a held suppressed RFQ from the previous stream', () => {
      const { framer, outputs } = makeHarness(true);
      framer.write(DATA);
      framer.write(RFQ_IDLE);
      // flush() intentionally NOT called: the final RFQ ('I') is still held.
      expect(collect(outputs.splice(0))).toEqual(DATA);

      framer.reset(true);
      framer.write(DATA);
      framer.write(RFQ_FAILED);
      // Suppression re-applied by reset(true): the new final RFQ is held too.
      expect(collect(outputs)).toEqual(DATA);
      framer.flush();

      const emitted = collect(outputs);
      // Only the second stream's RFQ appears — status 'E' (0x45), never the
      // held 'I' (0x49) from the first stream.
      expect(emitted).toEqual(collect([DATA, RFQ_FAILED]));
      expect(emitted[emitted.length - 1]).toBe(0x45);
    });

    it('restores every logical field to the fresh framer state', () => {
      // TS `private` fields are plain JS own properties at runtime, so a
      // structural comparison guards reset() against forgetting a field added
      // in the future. `headerScratch` and `heldRfq` are excluded BY KEY, not
      // by type: they are preallocated scratch buffers whose CONTENTS are not
      // logical state (every read is gated by headerBytesRead / rfqBytesRead).
      // Excluding by type (e.g. skipping every Uint8Array/Buffer) would
      // wrongly skip a stale `rowDescBuffer`, which MUST be reset to
      // undefined — this comparison has to catch it if it is not.
      const scratchBufferKeys = new Set(['headerScratch', 'heldRfq']);
      const logicalState = (framer: BackendMessageFramer): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(framer).filter(
            ([key, value]) => typeof value !== 'function' && !scratchBufferKeys.has(key),
          ),
        );

      const makeFramer = (): BackendMessageFramer =>
        new BackendMessageFramer({
          suppressIntermediateReadyForQuery: false,
          onChunk: () => {},
        });
      const fresh = makeFramer();
      const framer = makeFramer();

      // Partial RFQ: dirties messageType, headerBytesRead, and rfqBytesRead.
      framer.write(RFQ_IDLE.subarray(0, 3));
      framer.reset(false);
      expect(logicalState(framer)).toEqual(logicalState(fresh));

      // RFQ cut right after its header: completes header decode, dirtying
      // the rfqFrame latch with the status byte still pending.
      framer.write(RFQ_IDLE.subarray(0, 5));
      framer.reset(false);
      expect(logicalState(framer)).toEqual(logicalState(fresh));

      // RowDescription split mid-payload: dirties payloadBytesRemaining,
      // rowDescBuffer, and rowDescOffset.
      const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
      const splitAt = Math.floor(frame.length / 2);
      expect(splitAt).toBeGreaterThan(5); // split must land inside the payload
      framer.write(frame.subarray(0, splitAt));
      framer.reset(false);
      expect(logicalState(framer)).toEqual(logicalState(fresh));
    });
  });

  // Copy-in support: reset(_, true) arms a one-shot drop of the first
  // CopyInResponse — the duplex already sent the client a synthetic one
  // before capturing its data, so the backend's real 'G' would desync
  // pg's copy state machine.
  describe('dropFirstCopyInResponse', () => {
    const COPY_IN = 0x47;
    const copyInResponse = encodeMessage(COPY_IN, new Uint8Array([0, 0, 0])); // text, 0 cols
    const commandComplete = encodeMessage(0x43, new Uint8Array([0x43, 0]));

    it('drops exactly the first CopyInResponse on the fast path', () => {
      const { framer, outputs } = makeHarness();
      framer.reset(false, true);
      framer.write(collect([copyInResponse, commandComplete, RFQ_IDLE]));
      const emitted = collect(outputs);
      expect(emitted[0]).toBe(0x43); // CommandComplete first — the G is gone
      expect([...emitted].includes(COPY_IN)).toBe(false);
      expect(emitted.length).toBe(commandComplete.length + RFQ_IDLE.length);
    });

    it('drops a chunk-spanning CopyInResponse on the slow path', () => {
      const { framer, outputs } = makeHarness();
      framer.reset(false, true);
      // Byte-at-a-time forces type/header/payload through the state machine.
      for (const piece of splitEvery(copyInResponse, 1)) {
        framer.write(piece);
      }
      framer.write(collect([commandComplete, RFQ_IDLE]));
      const emitted = collect(outputs);
      expect(emitted[0]).toBe(0x43);
      expect(emitted.length).toBe(commandComplete.length + RFQ_IDLE.length);
    });

    it('drops a payload-free CopyInResponse frame on the slow path', () => {
      // Not a shape a real backend produces (G always carries format +
      // column count), but the state machine must finish the dropped
      // message even with zero payload bytes remaining.
      const { framer, outputs } = makeHarness();
      framer.reset(false, true);
      const bare = encodeMessage(COPY_IN, new Uint8Array(0));
      for (const piece of splitEvery(bare, 1)) {
        framer.write(piece);
      }
      framer.write(RFQ_IDLE.slice());
      expect(collect(outputs).length).toBe(RFQ_IDLE.length);
    });

    it('is one-shot: a second CopyInResponse in the same stream passes through', () => {
      const { framer, outputs } = makeHarness();
      framer.reset(false, true);
      framer.write(collect([copyInResponse, copyInResponse, RFQ_IDLE]));
      const emitted = collect(outputs);
      expect(emitted[0]).toBe(COPY_IN);
      expect(emitted.length).toBe(copyInResponse.length + RFQ_IDLE.length);
    });

    it('reset without the flag disarms a leftover drop', () => {
      const { framer, outputs } = makeHarness();
      framer.reset(false, true);
      framer.reset(false);
      framer.write(copyInResponse.slice());
      expect(collect(outputs).length).toBe(copyInResponse.length);
    });
  });

  describe('mutation-hardening: survivor kills', () => {
    it('emits a ReadyForQuery immediately when constructed with no suppression option (default false)', () => {
      // No suppressIntermediateReadyForQuery passed: the constructor default must
      // be false, so a complete RFQ is emitted on write() rather than held.
      const outputs: Uint8Array[] = [];
      const statuses: number[] = [];
      const framer = new BackendMessageFramer({
        onChunk: (chunk) => outputs.push(chunk.slice()),
        onReadyForQuery: (status) => statuses.push(status),
      });
      framer.write(RFQ_IDLE);
      // Assert BEFORE flush: suppression-on (mutant) would hold the RFQ here.
      expect(collect(outputs)).toEqual(RFQ_IDLE);
      expect(statuses).toEqual([0x49]);
      framer.flush();
      expect(collect(outputs)).toEqual(RFQ_IDLE);
    });

    it('coalesces a trailing zero-payload message into the same fast-path slice (available === 5 boundary)', () => {
      // DATA (9 bytes) then CopyDone (5 bytes, zero payload). At the CopyDone start
      // `available === 5` exactly: `available >= 5` keeps it on the fast path so both
      // messages coalesce into ONE passthrough slice. `available > 5` would divert
      // CopyDone to the slow path, flushing DATA alone then emitting a separate prefix.
      const copyDone = encodeMessage(0x63, new Uint8Array(0));
      const combined = collect([DATA, copyDone]);
      const outputs: Uint8Array[] = [];
      const framer = new BackendMessageFramer({
        onChunk: (chunk) => outputs.push(chunk),
      });
      framer.write(combined);
      framer.flush();
      expect(collect(outputs)).toEqual(combined);
      expect(outputs).toHaveLength(1);
    });

    it('reads every length-header byte in the fast path (b1 and b3 are load-bearing)', () => {
      // b1 (bits 24-31): length 0x01000000 = 16777216 is valid; zeroing b1 -> length 0
      // -> Malformed<4. Original defers to the slow path (no throw on this 5-byte write).
      const b1Header = new Uint8Array([0x44, 0x01, 0x00, 0x00, 0x00]);
      expect(() => makeHarness().framer.write(b1Header)).not.toThrow();
      // b3 (bits 8-15): length 0x00000100 = 256 is valid; zeroing b3 -> length 0 -> Malformed<4.
      const b3Header = new Uint8Array([0x44, 0x00, 0x00, 0x01, 0x00]);
      expect(() => makeHarness().framer.write(b3Header)).not.toThrow();
    });

    it('reads the b3 length byte when the header is assembled via the slow path', () => {
      // Type byte alone, then the 4 length bytes: forces slow-path header decode.
      // Length 0x00000100 = 256 is valid; zeroing b3 -> length 0 -> Malformed<4.
      const { framer } = makeHarness();
      framer.write(new Uint8Array([0x44]));
      expect(() => framer.write(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).not.toThrow();
    });

    it('accepts a message length of exactly the sanity cap on the fast path (boundary is >, not >=)', () => {
      // 0x40000000 === MAX_MESSAGE_LENGTH. `> MAX` accepts it (deferring to the slow
      // path); `>= MAX` would throw `exceeds sanity cap` on this 5-byte write.
      const atCap = new Uint8Array([0x44, 0x40, 0x00, 0x00, 0x00]);
      expect(() => makeHarness().framer.write(atCap)).not.toThrow();
    });

    it('accepts a message length of exactly the sanity cap when assembled via the slow path (boundary is >, not >=)', () => {
      // Split header so length 0x40000000 === MAX decodes on the slow path. `> MAX`
      // accepts it (waits for payload); `>= MAX` would throw `exceeds sanity cap`.
      const { framer } = makeHarness();
      framer.write(new Uint8Array([0x44]));
      expect(() => framer.write(new Uint8Array([0x40, 0x00, 0x00, 0x00]))).not.toThrow();
    });

    it('does not invoke callbacks that were not provided', () => {
      // onErrorResponse / onReadyForQuery are optional. With `?.` removed, the
      // corresponding frame calls `undefined()` and throws TypeError. Cover both
      // the fast path (whole frame in one chunk) and the slow path (split header).
      const makeBare = () => {
        const outputs: Uint8Array[] = [];
        return {
          outputs,
          framer: new BackendMessageFramer({ onChunk: (chunk) => outputs.push(chunk.slice()) }),
        };
      };
      // 74: ErrorResponse, fast path.
      expect(() => makeBare().framer.write(ERROR)).not.toThrow();
      // 180: ErrorResponse, slow path (type byte split from the length header).
      {
        const { framer } = makeBare();
        framer.write(ERROR.subarray(0, 1));
        expect(() => framer.write(ERROR.subarray(1, 5))).not.toThrow();
      }
      // 93: ReadyForQuery, fast path.
      expect(() => makeBare().framer.write(RFQ_IDLE)).not.toThrow();
      // 278: ReadyForQuery, slow path (finishReadyForQuery drives the callback).
      {
        const { framer } = makeBare();
        framer.write(RFQ_IDLE.subarray(0, 3));
        expect(() => framer.write(RFQ_IDLE.subarray(3))).not.toThrow();
      }
    });

    it('only rewrites frames whose type byte is RowDescription, not lookalike payloads', () => {
      // A DataRow-typed (0x44) frame carrying a payload that scans as a
      // rewrite-needing RowDescription (pg_catalog oid-18 field). The type gate must
      // keep it byte-identical; forcing the gate true would corrupt oid 18 -> 25.
      const rd = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
      const fake = rd.slice();
      fake[0] = 0x44; // relabel T -> D; payload unchanged
      const { framer, outputs } = makeHarness();
      framer.write(fake);
      framer.flush();
      expect(collect(outputs)).toEqual(fake);
      // The oid at the field slot is still 18 (offset: 7 + len('contype')+1 + 4 + 2 = 21).
      expect(Buffer.from(collect(outputs)).readUInt32BE(21)).toBe(18);
    });

    it('finalizes a zero-payload dropped CopyInResponse so the stream ends cleanly', () => {
      // Arm the drop, then feed a bare (zero-payload) CopyInResponse byte-by-byte so
      // the header completes on the slow path with payloadBytesRemaining === 0. The
      // drop branch must call finishMessage(); skipping it strands the framer
      // mid-message so flush() throws Incomplete instead of returning cleanly.
      const { framer, outputs } = makeHarness();
      framer.reset(false, true);
      const bareCopyIn = encodeMessage(0x47, new Uint8Array(0));
      for (const piece of splitEvery(bareCopyIn, 1)) {
        framer.write(piece);
      }
      expect(() => framer.flush()).not.toThrow();
      expect(outputs).toHaveLength(0);
    });

    it.each([
      { name: 'b1', header: [0x44, 0x01, 0x00, 0x00, 0x05], expected: 16777222 },
      { name: 'b2', header: [0x44, 0x00, 0x01, 0x00, 0x05], expected: 65542 },
      { name: 'b3', header: [0x44, 0x00, 0x00, 0x01, 0x05], expected: 262 },
    ])(
      'reports the true expected byte count from length $name in the incomplete-message error',
      ({ header, expected }) => {
        // Full 5-byte header (type + declared length), no payload: flush() recomputes
        // the total from headerScratch. Zeroing any length byte would shrink the
        // reported `expected` figure below its true value.
        const { framer } = makeHarness();
        framer.write(new Uint8Array(header));
        expect(() => framer.flush()).toThrow(new RegExp(`expected ${expected} bytes`));
      },
    );

    it('actually discards the held RFQ on flush({dropHeldReadyForQuery:true}) so a later flush cannot resurrect it', () => {
      // With suppression on, DATA + a held final RFQ. flush({drop}) must clear the
      // buffered RFQ (rfqBytesRead -> 0); if the drop is a no-op the RFQ stays
      // buffered and a subsequent plain flush() emits the stale RFQ.
      const { framer, outputs } = makeHarness(true);
      framer.write(DATA);
      framer.write(RFQ_IDLE);
      framer.flush({ dropHeldReadyForQuery: true });
      framer.flush();
      expect(collect(outputs)).toEqual(DATA);
    });
  });
});
