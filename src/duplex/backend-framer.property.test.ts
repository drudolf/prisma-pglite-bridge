import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type CallbackEvent,
  concatBytes,
  corruptStreamArb,
  type FramerOptionsTriple,
  optionsArb,
  partitionArb,
  referenceOracle,
  rowDescriptionCaseArb,
  streamArb,
  toChunks,
} from './__tests__/property-arbitraries.ts';
import { BackendMessageFramer } from './backend-framer.ts';
import { PG_TYPE_OID_TEXT } from './constants.ts';
import { rewriteRowDescriptionInPlace, rowDescriptionNeedsRewrite } from './row-description.ts';

describe('BackendMessageFramer properties', () => {
  const makeHarness = (options: FramerOptionsTriple) => {
    const outputs: Uint8Array[] = [];
    const trace: CallbackEvent[] = [];
    const framer = new BackendMessageFramer({
      suppressIntermediateReadyForQuery: options.suppressIntermediateReadyForQuery,
      rewriteSystemCatalogCharOids: options.rewriteSystemCatalogCharOids,
      // Collected by reference and compared only at the end: if the framer
      // recycled an emitted buffer, the stale bytes would fail the comparison.
      onChunk: (chunk) => outputs.push(chunk),
      onErrorResponse: () => trace.push({ type: 'E' }),
      onReadyForQuery: (status) => trace.push({ type: 'Z', status }),
    });
    framer.reset(options.suppressIntermediateReadyForQuery, options.dropFirstCopyInResponse);
    return { framer, outputs, trace };
  };

  const collect = (outputs: readonly Uint8Array[]): Uint8Array => concatBytes(outputs);

  const partitionedStreamArb = streamArb.chain((stream) =>
    fc.record({
      stream: fc.constant(stream),
      options: optionsArb,
      partition: partitionArb(stream.frames.map((frame) => frame.bytes.length)),
    }),
  );

  it('P1: any partition of a stream yields the same bytes and callback trace as a single-chunk feed', () => {
    fc.assert(
      fc.property(partitionedStreamArb, ({ stream, options, partition }) => {
        const whole = makeHarness(options);
        whole.framer.write(stream.bytes);
        whole.framer.flush();

        const split = makeHarness(options);
        for (const chunk of toChunks(stream.bytes, partition)) {
          split.framer.write(chunk);
        }
        split.framer.flush();

        expect(collect(split.outputs)).toEqual(collect(whole.outputs));
        expect(split.trace).toEqual(whole.trace);
      }),
      { numRuns: 500 },
    );
  });

  it('P2: a single-chunk feed plus flush matches the reference oracle output and trace', () => {
    fc.assert(
      fc.property(streamArb, optionsArb, (stream, options) => {
        const harness = makeHarness(options);
        harness.framer.write(stream.bytes);
        harness.framer.flush();

        const expected = referenceOracle(stream.frames, options);
        expect(collect(harness.outputs)).toEqual(expected.output);
        expect(harness.trace).toEqual(expected.trace);
      }),
      { numRuns: 500 },
    );
  });

  it('P3: collected output survives garbling of every input chunk after the feed', () => {
    fc.assert(
      fc.property(partitionedStreamArb, ({ stream, options, partition }) => {
        const harness = makeHarness(options);
        const chunks = toChunks(stream.bytes, partition);
        for (const chunk of chunks) {
          harness.framer.write(chunk);
        }
        harness.framer.flush();
        // Input-side scope only: output-buffer reuse is already covered by
        // P1/P2, which hold emitted references and compare bytes at the end.
        for (const chunk of chunks) {
          chunk.fill(0xaa);
        }
        expect(collect(harness.outputs)).toEqual(referenceOracle(stream.frames, options).output);
      }),
    );
  });

  const truncationArb = fc
    .tuple(
      streamArb.filter((stream) => stream.frames.length > 0),
      optionsArb,
      fc.boolean(),
      fc.nat(),
      fc.nat(),
    )
    .chain(([stream, options, insideFrame, frameSeed, offsetSeed]) => {
      const frameLengths = stream.frames.map((frame) => frame.bytes.length);
      const starts: number[] = [];
      let acc = 0;
      for (const length of frameLengths) {
        starts.push(acc);
        acc += length;
      }
      let completeFrames: number;
      let cut: number;
      if (insideFrame) {
        completeFrames = frameSeed % stream.frames.length;
        const frameLength = frameLengths[completeFrames] ?? 5;
        cut = (starts[completeFrames] ?? 0) + 1 + (offsetSeed % (frameLength - 1));
      } else {
        completeFrames = frameSeed % (stream.frames.length + 1);
        cut =
          completeFrames === stream.frames.length
            ? stream.bytes.length
            : (starts[completeFrames] ?? 0);
      }
      const segments = frameLengths.slice(0, completeFrames);
      const partialBytes = cut - (starts[completeFrames] ?? stream.bytes.length);
      if (partialBytes > 0) {
        segments.push(partialBytes);
      }
      return fc.record({
        stream: fc.constant(stream),
        options: fc.constant(options),
        insideFrame: fc.constant(insideFrame),
        completeFrames: fc.constant(completeFrames),
        cut: fc.constant(cut),
        partition: partitionArb(segments),
      });
    });

  it('P4: flush throws on a mid-frame truncation and completes cleanly on a frame boundary', () => {
    fc.assert(
      fc.property(
        truncationArb,
        ({ stream, options, insideFrame, completeFrames, cut, partition }) => {
          const harness = makeHarness(options);
          for (const chunk of toChunks(stream.bytes.slice(0, cut), partition)) {
            harness.framer.write(chunk);
          }
          if (insideFrame) {
            expect(() => harness.framer.flush()).toThrow(/Incomplete backend message/);
            return;
          }
          harness.framer.flush();
          const expected = referenceOracle(stream.frames.slice(0, completeFrames), options);
          expect(collect(harness.outputs)).toEqual(expected.output);
        },
      ),
    );
  });

  const resetScenarioArb = fc
    .tuple(
      streamArb,
      fc.nat(),
      optionsArb,
      streamArb,
      fc.record({ suppress: fc.boolean(), drop: fc.boolean() }),
    )
    .chain(([streamA, cutSeed, optionsA, streamB, optionsB]) =>
      fc.record({
        streamA: fc.constant(streamA),
        prefixLength: fc.constant(
          streamA.bytes.length === 0 ? 0 : cutSeed % (streamA.bytes.length + 1),
        ),
        optionsA: fc.constant(optionsA),
        streamB: fc.constant(streamB),
        optionsB: fc.constant(optionsB),
        partitionB: partitionArb(streamB.frames.map((frame) => frame.bytes.length)),
      }),
    );

  it('P5: reset() after an arbitrary (possibly mid-frame) prefix behaves like a fresh framer', () => {
    fc.assert(
      fc.property(
        resetScenarioArb,
        ({ streamA, prefixLength, optionsA, streamB, optionsB, partitionB }) => {
          const reused = makeHarness(optionsA);
          reused.framer.write(streamA.bytes.slice(0, prefixLength));
          reused.outputs.splice(0);
          reused.trace.splice(0);
          reused.framer.reset(optionsB.suppress, optionsB.drop);
          for (const chunk of toChunks(streamB.bytes, partitionB)) {
            reused.framer.write(chunk);
          }
          reused.framer.flush();

          // rewriteSystemCatalogCharOids is constructor-fixed; reset() cannot
          // change it, so the fresh baseline inherits optionsA's value.
          const fresh = makeHarness({
            suppressIntermediateReadyForQuery: optionsB.suppress,
            rewriteSystemCatalogCharOids: optionsA.rewriteSystemCatalogCharOids,
            dropFirstCopyInResponse: optionsB.drop,
          });
          for (const chunk of toChunks(streamB.bytes, partitionB)) {
            fresh.framer.write(chunk);
          }
          fresh.framer.flush();

          expect(collect(reused.outputs)).toEqual(collect(fresh.outputs));
          expect(reused.trace).toEqual(fresh.trace);
        },
      ),
    );
  });

  const corruptScenarioArb = fc
    .tuple(
      corruptStreamArb,
      optionsArb,
      streamArb,
      fc.record({ suppress: fc.boolean(), drop: fc.boolean() }),
    )
    .chain(([corrupt, options, recoveryStream, recoveryOptions]) =>
      fc.record({
        corrupt: fc.constant(corrupt),
        options: fc.constant(options),
        recoveryStream: fc.constant(recoveryStream),
        recoveryOptions: fc.constant(recoveryOptions),
        partition: partitionArb(corrupt.segmentLengths),
      }),
    );

  it('P6: a corrupt length header throws when it completes, keeps trace/output prefixes, and reset() recovers', () => {
    fc.assert(
      fc.property(
        corruptScenarioArb,
        ({ corrupt, options, recoveryStream, recoveryOptions, partition }) => {
          const harness = makeHarness(options);
          let threw = false;
          let start = 0;
          for (const chunk of toChunks(corrupt.bytes, partition)) {
            const end = start + chunk.length;
            if (start < corrupt.corruptHeaderEnd && corrupt.corruptHeaderEnd <= end) {
              // The write carrying the last corrupt-header byte throws on both
              // paths: fast when all 5 header bytes share a chunk, slow otherwise.
              expect(() => harness.framer.write(chunk)).toThrow(
                /Malformed backend message length|exceeds sanity cap/,
              );
              threw = true;
              break;
            }
            harness.framer.write(chunk);
            start = end;
          }
          expect(threw).toBe(true);

          const validPrefix = referenceOracle(corrupt.prefixFrames, options);
          expect(harness.trace).toEqual(validPrefix.trace.slice(0, harness.trace.length));
          const emitted = collect(harness.outputs);
          // Lazy passthrough flushing: possibly a shorter prefix than the bytes consumed.
          expect(emitted).toEqual(validPrefix.output.slice(0, emitted.length));

          harness.outputs.splice(0);
          harness.trace.splice(0);
          harness.framer.reset(recoveryOptions.suppress, recoveryOptions.drop);
          harness.framer.write(recoveryStream.bytes);
          harness.framer.flush();

          const fresh = makeHarness({
            suppressIntermediateReadyForQuery: recoveryOptions.suppress,
            rewriteSystemCatalogCharOids: options.rewriteSystemCatalogCharOids,
            dropFirstCopyInResponse: recoveryOptions.drop,
          });
          fresh.framer.write(recoveryStream.bytes);
          fresh.framer.flush();

          expect(collect(harness.outputs)).toEqual(collect(fresh.outputs));
          expect(harness.trace).toEqual(fresh.trace);
        },
      ),
    );
  });

  it('P7: rowDescriptionNeedsRewrite is true iff the rewrite mutates, per the generator field model', () => {
    fc.assert(
      fc.property(rowDescriptionCaseArb, (frame) => {
        const original = Buffer.from(frame.bytes);
        const rewritten = Buffer.from(frame.bytes);
        rewriteRowDescriptionInPlace(rewritten);

        const mutated = !rewritten.equals(original);
        expect(rowDescriptionNeedsRewrite(frame.bytes)).toBe(mutated);
        expect(rewritten.length).toBe(original.length);

        // Expected bytes come from the generator's offset bookkeeping, not the
        // production walk — a shared systematic walk bug cannot self-certify.
        const expected = Buffer.from(frame.bytes);
        for (const field of frame.fields ?? []) {
          if (field.qualifies) {
            expected.writeUInt32BE(PG_TYPE_OID_TEXT, field.oidOffset);
            expected.writeInt16BE(-1, field.sizeOffset);
          }
        }
        expect(rewritten).toEqual(expected);

        const twice = Buffer.from(rewritten);
        rewriteRowDescriptionInPlace(twice);
        expect(twice).toEqual(rewritten);
      }),
    );
  });
});
