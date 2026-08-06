import { describe, expect, it } from 'vitest';

import { FrontendMessageBuffer } from './frontend-buffer.ts';

describe('FrontendMessageBuffer', () => {
  const int32 = (value: number): Uint8Array => {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value);
    return buf;
  };

  const frontendMessage = (type: number, payload: Uint8Array): Uint8Array => {
    const result = new Uint8Array(1 + 4 + payload.length);
    result[0] = type;
    result.set(int32(4 + payload.length), 1);
    result.set(payload, 5);
    return result;
  };

  it('reads startup lengths across split chunks', () => {
    const buffer = new FrontendMessageBuffer();
    const startup = new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00]);
    buffer.push(startup.subarray(0, 2));
    expect(buffer.readUInt32BE(0)).toBeUndefined();
    buffer.push(startup.subarray(2));
    expect(buffer.readUInt32BE(0)).toBe(8);
    expect(buffer.consume(8)).toEqual(startup);
    expect(buffer.length).toBe(0);
  });

  it('reads regular message lengths across split type and header bytes', () => {
    const buffer = new FrontendMessageBuffer();
    const message = frontendMessage(
      0x51,
      new Uint8Array([0x73, 0x65, 0x6c, 0x65, 0x63, 0x74, 0x00]),
    );
    buffer.push(message.subarray(0, 1));
    expect(buffer.readUInt32BE(1)).toBeUndefined();
    buffer.push(message.subarray(1, 4));
    expect(buffer.readUInt32BE(1)).toBeUndefined();
    buffer.push(message.subarray(4));
    expect(buffer.readUInt32BE(1)).toBe(11);
    expect(buffer.consume(message.length)).toEqual(message);
  });

  it('returns a zero-copy view when a full message is already in one chunk', () => {
    const buffer = new FrontendMessageBuffer();
    const message = frontendMessage(0x53, new Uint8Array(0));
    buffer.push(message);
    const consumed = buffer.consume(message.length);
    expect(consumed).toEqual(message);
    expect(consumed.buffer).toBe(message.buffer);
    expect(buffer.length).toBe(0);
  });

  it('allocates once when a message spans chunks', () => {
    const buffer = new FrontendMessageBuffer();
    const message = frontendMessage(0x50, new Uint8Array([0x61, 0x00, 0x62, 0x00, 0x00]));
    buffer.push(message.subarray(0, 3));
    buffer.push(message.subarray(3));
    const consumed = buffer.consume(message.length);
    expect(consumed).toEqual(message);
    expect(consumed.buffer).not.toBe(message.buffer);
    expect(buffer.length).toBe(0);
  });

  it('returns a zero-copy view when consuming only part of a larger head chunk', () => {
    const buffer = new FrontendMessageBuffer();
    const first = frontendMessage(0x53, new Uint8Array(0));
    const second = frontendMessage(0x58, new Uint8Array(0));
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first, 0);
    combined.set(second, first.length);
    buffer.push(combined);
    const consumed = buffer.consume(first.length);
    expect(consumed).toEqual(first);
    expect(consumed.buffer).toBe(combined.buffer);
    expect(buffer.consume(second.length)).toEqual(second);
  });

  it('can consume one framed message and leave the next queued', () => {
    const buffer = new FrontendMessageBuffer();
    const first = frontendMessage(0x53, new Uint8Array(0));
    const second = frontendMessage(0x58, new Uint8Array(0));
    buffer.push(first);
    buffer.push(second);
    expect(buffer.consume(first.length)).toEqual(first);
    expect(buffer.readUInt32BE(1)).toBe(4);
    expect(buffer.consume(second.length)).toEqual(second);
  });

  it('leaves the tail of a chunk queued when consume ends mid-chunk', () => {
    const buffer = new FrontendMessageBuffer();
    const first = frontendMessage(0x53, new Uint8Array(0));
    const second = frontendMessage(0x58, new Uint8Array(0));
    buffer.push(first.subarray(0, 3));
    const tail = new Uint8Array(first.length - 3 + second.length);
    tail.set(first.subarray(3), 0);
    tail.set(second, first.length - 3);
    buffer.push(tail);
    expect(buffer.consume(first.length)).toEqual(first);
    expect(buffer.length).toBe(second.length);
    expect(buffer.consume(second.length)).toEqual(second);
  });

  it('continues reading correctly after many head-advancing consumes', () => {
    const buffer = new FrontendMessageBuffer();
    const messages = Array.from({ length: 40 }, (_, i) =>
      frontendMessage(0x51, new Uint8Array([i])),
    );

    for (const message of messages) {
      buffer.push(message);
    }

    for (const message of messages.slice(0, -1)) {
      expect(buffer.consume(message.length)).toEqual(message);
    }

    const last = messages.at(-1);
    expect(last).toBeDefined();
    expect(buffer.readUInt32BE(1)).toBe(last ? last.length - 1 : undefined);
    expect(buffer.consume(last?.length ?? 0)).toEqual(last);
    expect(buffer.length).toBe(0);
  });

  it('throws when consuming more bytes than are buffered', () => {
    const buffer = new FrontendMessageBuffer();
    expect(() => buffer.consume(1)).toThrow(/Cannot consume 1 bytes from 0-byte buffer/);
    buffer.push(new Uint8Array([0x01, 0x02]));
    expect(() => buffer.consume(3)).toThrow(/Cannot consume 3 bytes from 2-byte buffer/);
    expect(() => buffer.consume(-1)).toThrow(/Cannot consume -1 bytes/);
  });

  it('ignores empty pushes and supports consume(0)', () => {
    const buffer = new FrontendMessageBuffer();
    buffer.push(new Uint8Array(0));
    expect(buffer.length).toBe(0);
    expect(buffer.consume(0)).toEqual(new Uint8Array(0));
    buffer.push(new Uint8Array([0x41]));
    expect(buffer.consume(0)).toEqual(new Uint8Array(0));
    expect(buffer.length).toBe(1);
  });

  describe('mutation-hardening: survivor kills', () => {
    it('ignores an empty push so the following full message still consumes as a zero-copy view', () => {
      const buffer = new FrontendMessageBuffer();
      const message = frontendMessage(0x53, new Uint8Array(0));
      buffer.push(new Uint8Array(0));
      buffer.push(message);
      const consumed = buffer.consume(message.length);
      expect(consumed).toEqual(message);
      expect(consumed.buffer).toBe(message.buffer);
      expect(buffer.length).toBe(0);
    });

    it('advances the head after an exact drain so a later message consumes as a zero-copy view', () => {
      const buffer = new FrontendMessageBuffer();
      const first = frontendMessage(0x53, new Uint8Array(0));
      buffer.push(first);
      // Two fast-path consumes drain the head chunk exactly: the first ends mid-chunk,
      // the second lands on head.length and must advance headIndex + compact.
      expect(buffer.consume(1)).toEqual(first.subarray(0, 1));
      expect(buffer.consume(first.length - 1)).toEqual(first.subarray(1));
      expect(buffer.length).toBe(0);
      const next = frontendMessage(0x58, new Uint8Array(0));
      buffer.push(next);
      const consumed = buffer.consume(next.length);
      expect(consumed).toEqual(next);
      expect(consumed.buffer).toBe(next.buffer);
    });
  });
});
