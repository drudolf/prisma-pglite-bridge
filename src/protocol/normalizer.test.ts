import { describe, expect, it } from 'vitest';
import {
  createProtocolNormalizer,
  getMessageType,
  shouldHaveReadyForQuery,
  stripTrailingReadyForQuery,
} from './normalizer.ts';

// ReadyForQuery message: Z + length(5) + status(I=idle)
const READY_FOR_QUERY = new Uint8Array([0x5a, 0x00, 0x00, 0x00, 0x05, 0x49]);

// ErrorResponse for "table does not exist" (simplified)
const ERROR_RESPONSE = new Uint8Array([
  0x45,
  0x00,
  0x00,
  0x00,
  0x0a, // E + length 10
  0x53,
  0x45,
  0x52,
  0x52,
  0x4f,
  0x52, // SERROR (simplified)
]);

const concat = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
};

describe('getMessageType', () => {
  it('returns null for empty buffer', () => {
    expect(getMessageType(new Uint8Array([]))).toBeNull();
  });

  it('returns null for startup message (first byte 0x00)', () => {
    expect(getMessageType(new Uint8Array([0x00, 0x00, 0x00, 0x08]))).toBeNull();
  });

  it('returns the type byte for regular messages', () => {
    expect(getMessageType(new Uint8Array([0x50]))).toBe(0x50); // Parse
    expect(getMessageType(new Uint8Array([0x51]))).toBe(0x51); // SimpleQuery
    expect(getMessageType(new Uint8Array([0x53]))).toBe(0x53); // Sync
  });
});

describe('shouldHaveReadyForQuery', () => {
  it('returns false for all Extended Query messages', () => {
    const extendedTypes = [0x50, 0x42, 0x44, 0x45, 0x43, 0x48]; // P B D E C H
    for (const t of extendedTypes) {
      expect(shouldHaveReadyForQuery(t)).toBe(false);
    }
  });

  it('returns true for Sync and SimpleQuery', () => {
    expect(shouldHaveReadyForQuery(0x53)).toBe(true); // Sync
    expect(shouldHaveReadyForQuery(0x51)).toBe(true); // SimpleQuery
  });

  it('returns true for unknown message types', () => {
    expect(shouldHaveReadyForQuery(0xff)).toBe(true);
    expect(shouldHaveReadyForQuery(0x01)).toBe(true);
  });
});

describe('stripTrailingReadyForQuery', () => {
  it('returns unchanged for buffer < 6 bytes', () => {
    const short = new Uint8Array([0x01, 0x02, 0x03]);
    expect(stripTrailingReadyForQuery(short)).toEqual(short);
  });

  it('strips trailing ReadyForQuery', () => {
    const data = new Uint8Array([0xaa, 0xbb]);
    const withRFQ = concat(data, READY_FOR_QUERY);
    expect(stripTrailingReadyForQuery(withRFQ)).toEqual(data);
  });

  it('returns unchanged when last 6 bytes are not ReadyForQuery', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    expect(stripTrailingReadyForQuery(data)).toEqual(data);
  });

  it('preserves data before the trailing ReadyForQuery', () => {
    const payload = new Uint8Array([0x31, 0x00, 0x00, 0x00, 0x04]); // ParseComplete
    const withRFQ = concat(payload, READY_FOR_QUERY);
    const result = stripTrailingReadyForQuery(withRFQ);
    expect(result).toEqual(payload);
  });

  it('strips exactly one ReadyForQuery from the end', () => {
    const doubled = concat(READY_FOR_QUERY, READY_FOR_QUERY);
    const result = stripTrailingReadyForQuery(doubled);
    expect(result).toEqual(READY_FOR_QUERY);
  });
});

describe('createProtocolNormalizer', () => {
  const normalize = createProtocolNormalizer();

  const startupMessage = new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x08, // length = 8
    0x00,
    0x03,
    0x00,
    0x00, // protocol version 3.0
  ]);

  const syncMessage = new Uint8Array([0x53, 0x00, 0x00, 0x00, 0x04]);

  const simpleQuery = new Uint8Array([
    0x51,
    0x00,
    0x00,
    0x00,
    0x0d, // Q + length 13
    0x53,
    0x45,
    0x4c,
    0x45,
    0x43,
    0x54,
    0x20,
    0x31,
    0x00, // SELECT 1\0
  ]);

  const parseMessage = new Uint8Array([0x50, 0x00, 0x00, 0x00, 0x04]);
  const bindMessage = new Uint8Array([0x42, 0x00, 0x00, 0x00, 0x04]);
  const executeMessage = new Uint8Array([0x45, 0x00, 0x00, 0x00, 0x04]);

  const responseWithRFQ = concat(ERROR_RESPONSE, READY_FOR_QUERY);

  it('passes through response for startup messages', () => {
    expect(normalize(startupMessage, responseWithRFQ)).toEqual(responseWithRFQ);
  });

  it('passes through response for Sync messages', () => {
    expect(normalize(syncMessage, responseWithRFQ)).toEqual(responseWithRFQ);
  });

  it('passes through response for SimpleQuery messages', () => {
    expect(normalize(simpleQuery, responseWithRFQ)).toEqual(responseWithRFQ);
  });

  it('strips ReadyForQuery from Parse response', () => {
    expect(normalize(parseMessage, responseWithRFQ)).toEqual(ERROR_RESPONSE);
  });

  it('strips ReadyForQuery from Bind response', () => {
    expect(normalize(bindMessage, responseWithRFQ)).toEqual(ERROR_RESPONSE);
  });

  it('strips ReadyForQuery from Execute response', () => {
    expect(normalize(executeMessage, responseWithRFQ)).toEqual(ERROR_RESPONSE);
  });

  it('handles ErrorResponse + ReadyForQuery (the Prisma bug scenario)', () => {
    const result = normalize(parseMessage, responseWithRFQ);
    expect(result).toEqual(ERROR_RESPONSE);
    expect(result[result.length - 6]).not.toBe(0x5a);
  });
});
