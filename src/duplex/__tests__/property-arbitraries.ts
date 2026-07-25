import fc from 'fast-check';

import {
  COPY_IN_RESPONSE,
  ERROR_RESPONSE,
  MAX_MESSAGE_LENGTH,
  PG_FIRST_USER_OID,
  PG_TYPE_OID_CHAR,
  PG_TYPE_OID_TEXT,
  READY_FOR_QUERY,
  RFQ_STATUS_FAILED,
  RFQ_STATUS_IDLE,
  RFQ_STATUS_IN_TRANSACTION,
  ROW_DESCRIPTION,
} from '../constants.ts';
import { rewriteRowDescriptionInPlace, rowDescriptionNeedsRewrite } from '../row-description.ts';

type FrameKind =
  | 'generic'
  | 'rfq'
  | 'hostileZ'
  | 'error'
  | 'copyIn'
  | 'rowDescription'
  | 'hostileRowDescription';

type RowDescFieldInfo = {
  /** Absolute offset of the field's dataTypeOID within the frame. */
  oidOffset: number;
  /** Absolute offset of the field's dataTypeSize within the frame. */
  sizeOffset: number;
  /** Whether the production rewrite is expected to widen this field. */
  qualifies: boolean;
};

export type GeneratedFrame = {
  kind: FrameKind;
  bytes: Uint8Array;
  fields?: RowDescFieldInfo[];
};

export type GeneratedStream = {
  frames: GeneratedFrame[];
  bytes: Uint8Array;
};

export type FramerOptionsTriple = {
  suppressIntermediateReadyForQuery: boolean;
  rewriteSystemCatalogCharOids: boolean;
  dropFirstCopyInResponse: boolean;
};

export type CallbackEvent = { type: 'E' } | { type: 'Z'; status: number };

export type OracleExpectation = {
  output: Uint8Array;
  trace: CallbackEvent[];
};

export type CorruptStream = {
  prefixFrames: GeneratedFrame[];
  bytes: Uint8Array;
  /** Byte position just past the corrupt frame's 5-byte type+length header. */
  corruptHeaderEnd: number;
  segmentLengths: number[];
};

export const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/** Each chunk is a fresh copy owning its memory, so P3 can garble it freely. */
export const toChunks = (bytes: Uint8Array, partition: readonly number[]): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const length of partition) {
    chunks.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return chunks;
};

const encodeFrame = (type: number, payload: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, 4 + payload.length);
  bytes.set(payload, 5);
  return bytes;
};

type RowDescFieldSpec = {
  name: Uint8Array;
  tableOid: number;
  attnum: number;
  typeOid: number;
  size: number;
  typmod: number;
  format: number;
};

const buildRowDescription = (
  specs: readonly RowDescFieldSpec[],
  declaredFieldCount: number = specs.length,
): { bytes: Uint8Array; fields: RowDescFieldInfo[] } => {
  const payloadLength = 2 + specs.reduce((sum, spec) => sum + spec.name.length + 1 + 18, 0);
  const buf = Buffer.alloc(5 + payloadLength);
  buf[0] = ROW_DESCRIPTION;
  buf.writeUInt32BE(4 + payloadLength, 1);
  buf.writeUInt16BE(declaredFieldCount, 5);
  const fields: RowDescFieldInfo[] = [];
  let p = 7;
  for (const spec of specs) {
    buf.set(spec.name, p);
    p += spec.name.length;
    buf[p] = 0;
    p += 1;
    buf.writeUInt32BE(spec.tableOid, p);
    p += 4;
    buf.writeInt16BE(spec.attnum, p);
    p += 2;
    const oidOffset = p;
    buf.writeUInt32BE(spec.typeOid, p);
    p += 4;
    const sizeOffset = p;
    buf.writeInt16BE(spec.size, p);
    p += 2;
    buf.writeInt32BE(spec.typmod, p);
    p += 4;
    buf.writeInt16BE(spec.format, p);
    p += 2;
    fields.push({
      oidOffset,
      sizeOffset,
      qualifies:
        spec.typeOid === PG_TYPE_OID_CHAR &&
        spec.tableOid !== 0 &&
        spec.tableOid < PG_FIRST_USER_OID,
    });
  }
  return { bytes: new Uint8Array(buf), fields };
};

// Realistic backend type bytes, excluding Z/T/G/E which are generated deliberately.
const GENERIC_TYPES = [
  0x31, 0x32, 0x33, 0x41, 0x43, 0x44, 0x48, 0x49, 0x4b, 0x4e, 0x53, 0x56, 0x63, 0x64, 0x6e, 0x74,
];

const INT4_OID = 23;

const genericFrameArb: fc.Arbitrary<GeneratedFrame> = fc
  .record({ type: fc.constantFrom(...GENERIC_TYPES), payload: fc.uint8Array({ maxLength: 64 }) })
  .map(
    ({ type, payload }): GeneratedFrame => ({ kind: 'generic', bytes: encodeFrame(type, payload) }),
  );

const rfqFrameArb: fc.Arbitrary<GeneratedFrame> = fc
  .constantFrom(RFQ_STATUS_IDLE, RFQ_STATUS_IN_TRANSACTION, RFQ_STATUS_FAILED)
  .map(
    (status): GeneratedFrame => ({
      kind: 'rfq',
      bytes: encodeFrame(READY_FOR_QUERY, Uint8Array.of(status)),
    }),
  );

// Z frames with length !== 5 must be treated as generic frames, never as RFQ.
const hostileZFrameArb: fc.Arbitrary<GeneratedFrame> = fc
  .oneof(fc.constant(new Uint8Array(0)), fc.uint8Array({ minLength: 2, maxLength: 16 }))
  .map(
    (payload): GeneratedFrame => ({
      kind: 'hostileZ',
      bytes: encodeFrame(READY_FOR_QUERY, payload),
    }),
  );

const errorFrameArb: fc.Arbitrary<GeneratedFrame> = fc
  .uint8Array({ maxLength: 32 })
  .map(
    (payload): GeneratedFrame => ({ kind: 'error', bytes: encodeFrame(ERROR_RESPONSE, payload) }),
  );

const copyInFrameArb: fc.Arbitrary<GeneratedFrame> = fc.uint8Array({ maxLength: 16 }).map(
  (payload): GeneratedFrame => ({
    kind: 'copyIn',
    bytes: encodeFrame(COPY_IN_RESPONSE, payload),
  }),
);

const fieldSpecArb: fc.Arbitrary<RowDescFieldSpec> = fc.record({
  name: fc.uint8Array({ min: 1, maxLength: 8 }),
  tableOid: fc.oneof(
    fc.constant(0),
    fc.integer({ min: 1, max: PG_FIRST_USER_OID - 1 }),
    fc.integer({ min: PG_FIRST_USER_OID, max: 0xffffffff }),
  ),
  typeOid: fc.oneof(
    fc.constant(PG_TYPE_OID_CHAR),
    fc.constant(PG_TYPE_OID_TEXT),
    fc.constant(INT4_OID),
    fc.integer({ min: 0, max: 0xffffffff }),
  ),
  attnum: fc.integer({ min: -0x8000, max: 0x7fff }),
  size: fc.integer({ min: -0x8000, max: 0x7fff }),
  typmod: fc.integer({ min: -0x80000000, max: 0x7fffffff }),
  format: fc.integer({ min: -0x8000, max: 0x7fff }),
});

const qualifyingFieldSpecArb: fc.Arbitrary<RowDescFieldSpec> = fc.record({
  name: fc.uint8Array({ min: 1, maxLength: 8 }),
  tableOid: fc.integer({ min: 1, max: PG_FIRST_USER_OID - 1 }),
  typeOid: fc.constant(PG_TYPE_OID_CHAR),
  attnum: fc.integer({ min: -0x8000, max: 0x7fff }),
  size: fc.integer({ min: -0x8000, max: 0x7fff }),
  typmod: fc.integer({ min: -0x80000000, max: 0x7fffffff }),
  format: fc.integer({ min: -0x8000, max: 0x7fff }),
});

const validRowDescriptionArb: fc.Arbitrary<GeneratedFrame> = fc
  .array(fieldSpecArb, { maxLength: 4 })
  .map((specs): GeneratedFrame => ({ kind: 'rowDescription', ...buildRowDescription(specs) }));

const rewriteNeededRowDescriptionArb: fc.Arbitrary<GeneratedFrame> = fc
  .record({
    others: fc.array(fieldSpecArb, { maxLength: 3 }),
    qualifying: qualifyingFieldSpecArb,
    position: fc.nat({ max: 3 }),
  })
  .map(({ others, qualifying, position }): GeneratedFrame => {
    const specs = [...others];
    specs.splice(Math.min(position, others.length), 0, qualifying);
    return { kind: 'rowDescription', ...buildRowDescription(specs) };
  });

const truncatedSuffixRowDescriptionArb: fc.Arbitrary<GeneratedFrame> = fc
  .record({
    name: fc.uint8Array({ min: 1, maxLength: 8 }),
    // Fewer than the 18 fixed bytes a field needs after its name.
    suffix: fc.uint8Array({ maxLength: 17 }),
  })
  .map(({ name, suffix }): GeneratedFrame => {
    const payload = new Uint8Array(2 + name.length + 1 + suffix.length);
    new DataView(payload.buffer).setUint16(0, 1);
    payload.set(name, 2);
    payload.set(suffix, 3 + name.length);
    return {
      kind: 'hostileRowDescription',
      bytes: encodeFrame(ROW_DESCRIPTION, payload),
      fields: [],
    };
  });

const missingNulRowDescriptionArb: fc.Arbitrary<GeneratedFrame> = fc
  .record({
    fieldCount: fc.integer({ min: 1, max: 3 }),
    // NUL-free: the first field's name never terminates.
    junk: fc.uint8Array({ min: 1, maxLength: 24 }),
  })
  .map(({ fieldCount, junk }): GeneratedFrame => {
    const payload = new Uint8Array(2 + junk.length);
    new DataView(payload.buffer).setUint16(0, fieldCount);
    payload.set(junk, 2);
    return {
      kind: 'hostileRowDescription',
      bytes: encodeFrame(ROW_DESCRIPTION, payload),
      fields: [],
    };
  });

const inflatedCountRowDescriptionArb: fc.Arbitrary<GeneratedFrame> = fc
  .record({
    specs: fc.array(fieldSpecArb, { maxLength: 3 }),
    extra: fc.integer({ min: 1, max: 0xffff }),
  })
  .map(({ specs, extra }): GeneratedFrame => {
    const declared = Math.min(0xffff, specs.length + extra);
    return { kind: 'hostileRowDescription', ...buildRowDescription(specs, declared) };
  });

export const rowDescriptionCaseArb: fc.Arbitrary<GeneratedFrame> = fc.oneof(
  { arbitrary: validRowDescriptionArb, weight: 3 },
  { arbitrary: rewriteNeededRowDescriptionArb, weight: 2 },
  { arbitrary: truncatedSuffixRowDescriptionArb, weight: 1 },
  { arbitrary: missingNulRowDescriptionArb, weight: 1 },
  { arbitrary: inflatedCountRowDescriptionArb, weight: 2 },
);

const frameArb: fc.Arbitrary<GeneratedFrame> = fc.oneof(
  { arbitrary: genericFrameArb, weight: 4 },
  { arbitrary: rfqFrameArb, weight: 3 },
  { arbitrary: hostileZFrameArb, weight: 1 },
  { arbitrary: errorFrameArb, weight: 2 },
  { arbitrary: copyInFrameArb, weight: 2 },
  { arbitrary: rowDescriptionCaseArb, weight: 3 },
);

const toStream = (frames: GeneratedFrame[]): GeneratedStream => ({
  frames,
  bytes: concatBytes(frames.map((frame) => frame.bytes)),
});

const randomStreamArb = fc.array(frameArb, { maxLength: 12 });

// Weighted arm forcing the RFQ x rewrite-needed T x CopyIn interaction corners
// to co-occur within the run budget, order shuffled by generation.
const biasedStreamArb = fc
  .tuple(
    rfqFrameArb,
    rewriteNeededRowDescriptionArb,
    copyInFrameArb,
    fc.array(frameArb, { maxLength: 9 }),
  )
  .chain(([rfq, rowDescription, copyIn, extras]) => {
    const all = [rfq, rowDescription, copyIn, ...extras];
    return fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length });
  });

export const streamArb: fc.Arbitrary<GeneratedStream> = fc
  .oneof({ arbitrary: randomStreamArb, weight: 3 }, { arbitrary: biasedStreamArb, weight: 2 })
  .map(toStream);

export const optionsArb: fc.Arbitrary<FramerOptionsTriple> = fc.record({
  suppressIntermediateReadyForQuery: fc.boolean(),
  rewriteSystemCatalogCharOids: fc.boolean(),
  dropFirstCopyInResponse: fc.boolean(),
});

const fromCuts = (total: number, cuts: readonly number[]): number[] => {
  const sorted = [...cuts].sort((a, b) => a - b);
  const lengths: number[] = [];
  let previous = 0;
  for (const cut of sorted) {
    lengths.push(cut - previous);
    previous = cut;
  }
  lengths.push(total - previous);
  return lengths;
};

const insertZeroChunks = (
  partition: readonly number[],
  rawPositions: readonly number[],
): number[] => {
  const result = [...partition];
  for (const raw of rawPositions) {
    result.splice(raw % (result.length + 1), 0, 0);
  }
  return result;
};

/**
 * Partition of a byte stream into chunk lengths (zero-length chunks allowed).
 * `segmentLengths` are the stream's frame (or segment) byte lengths, so the
 * degenerate arms can aim cuts at headers and frame boundaries deliberately.
 */
export const partitionArb = (segmentLengths: readonly number[]): fc.Arbitrary<number[]> => {
  const total = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return fc.constant([]);
  const starts: number[] = [];
  let acc = 0;
  for (const length of segmentLengths) {
    starts.push(acc);
    acc += length;
  }
  const headerCut = fc
    .record({
      segment: fc.nat({ max: segmentLengths.length - 1 }),
      offset: fc.integer({ min: 1, max: 4 }),
    })
    .map(({ segment, offset }) => {
      const segmentLength = segmentLengths[segment] ?? 1;
      return fromCuts(total, [(starts[segment] ?? 0) + Math.min(offset, segmentLength - 1)]);
    });
  const boundaryCut = fc
    .nat({ max: segmentLengths.length })
    .map((index) => fromCuts(total, [starts[index] ?? total]));
  const randomCuts = fc
    .array(fc.integer({ min: 0, max: total }), { maxLength: 8 })
    .map((cuts) => fromCuts(total, cuts));
  const base = fc.oneof(
    { arbitrary: fc.constant([total]), weight: 1 },
    { arbitrary: fc.constant(Array.from({ length: total }, () => 1)), weight: 1 },
    { arbitrary: headerCut, weight: 2 },
    { arbitrary: boundaryCut, weight: 2 },
    { arbitrary: randomCuts, weight: 4 },
  );
  return fc
    .tuple(base, fc.array(fc.nat({ max: 64 }), { maxLength: 2 }))
    .map(([partition, zeroPositions]) => insertZeroChunks(partition, zeroPositions));
};

// P6 only: a corrupt embedded header cannot be represented as a semantic frame
// list, so this generator works at the byte level.
export const corruptStreamArb: fc.Arbitrary<CorruptStream> = fc
  .record({
    prefix: fc.array(frameArb, { maxLength: 4 }),
    corruptType: fc.integer({ min: 0, max: 255 }),
    corruptLength: fc.oneof(
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: MAX_MESSAGE_LENGTH + 1, max: 0xffffffff }),
    ),
    tail: fc.uint8Array({ maxLength: 8 }),
  })
  .map(({ prefix, corruptType, corruptLength, tail }): CorruptStream => {
    const header = new Uint8Array(5);
    header[0] = corruptType;
    new DataView(header.buffer).setUint32(1, corruptLength);
    const prefixBytes = concatBytes(prefix.map((frame) => frame.bytes));
    return {
      prefixFrames: prefix,
      bytes: concatBytes([prefixBytes, header, tail]),
      corruptHeaderEnd: prefixBytes.length + 5,
      segmentLengths: [...prefix.map((frame) => frame.bytes.length), 5 + tail.length],
    };
  });

/**
 * Semantic reference oracle. Operates on complete frames only — split behavior
 * is entirely P1's responsibility. Reuses the production RowDescription
 * predicate/rewriter deliberately: P7 pins their semantics independently.
 */
export const referenceOracle = (
  frames: readonly GeneratedFrame[],
  options: FramerOptionsTriple,
): OracleExpectation => {
  const emitted: Uint8Array[] = [];
  const trace: CallbackEvent[] = [];
  let dropArmed = options.dropFirstCopyInResponse;
  let heldRfq: Uint8Array | undefined;
  for (const frame of frames) {
    if (frame.kind === 'error') {
      trace.push({ type: 'E' });
    }
    if (frame.kind === 'rfq') {
      trace.push({ type: 'Z', status: frame.bytes[5] ?? 0 });
      if (options.suppressIntermediateReadyForQuery) {
        heldRfq = frame.bytes;
        continue;
      }
      emitted.push(frame.bytes);
      continue;
    }
    // Any complete non-RFQ frame — including a dropped CopyInResponse — drops a held RFQ.
    heldRfq = undefined;
    if (frame.kind === 'copyIn' && dropArmed) {
      dropArmed = false;
      continue;
    }
    if (
      (frame.kind === 'rowDescription' || frame.kind === 'hostileRowDescription') &&
      options.rewriteSystemCatalogCharOids &&
      rowDescriptionNeedsRewrite(frame.bytes)
    ) {
      const copy = Buffer.from(frame.bytes);
      rewriteRowDescriptionInPlace(copy);
      emitted.push(copy);
      continue;
    }
    emitted.push(frame.bytes);
  }
  if (heldRfq !== undefined) {
    // A trailing held RFQ surfaces at flush() time, at the end of the output.
    emitted.push(heldRfq);
  }
  return { output: concatBytes(emitted), trace };
};
