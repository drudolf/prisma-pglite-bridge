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

  it('coalesces contiguous in-chunk messages into one zero-copy slice', () => {
    const combined = collect([DATA, encodeMessage(0x43, new Uint8Array([0xaa]))]);
    const outputs: Uint8Array[] = [];
    const framer = new BackendMessageFramer({
      onChunk: (chunk) => outputs.push(chunk),
    });

    framer.write(combined);
    framer.flush();

    expect(collect(outputs)).toEqual(combined);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.buffer).toBe(combined.buffer);
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

  it('can reset between flushPipeline-style boundaries without leaking partial state', () => {
    const { framer, outputs, statuses } = makeHarness(true);
    framer.write(RFQ_IDLE.subarray(0, 3));
    framer.reset();
    framer.write(DATA);
    framer.write(RFQ_FAILED);
    framer.flush();
    expect(statuses).toEqual([0x45]);
    expect(collect(outputs)).toEqual(collect([DATA, RFQ_FAILED]));
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

  it('passes through a RowDescription without catalog char rewrites as a zero-copy slice', () => {
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
    expect(outputs[0]?.buffer).toBe(frame.buffer);
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
    expect(outputs[0]?.buffer).toBe(combined.buffer);
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

  it('reset clears a partially buffered RowDescription', () => {
    const frame = encodeRowDescription([{ name: 'contype', tableOID: 2606, oid: 18, size: 1 }]);
    const { framer, outputs } = makeHarness();
    framer.write(frame.subarray(0, 8)); // start buffering
    framer.reset();
    // After reset, a fresh complete frame must still be rewritten via the fast path.
    framer.write(frame);
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
});
