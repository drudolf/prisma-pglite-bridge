/**
 * Frontend chunk queue that frames messages without repeatedly compacting
 * the full buffered input.
 *
 * @internal — exported for testing only
 */
export class FrontendMessageBuffer {
  private chunks: Uint8Array[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private totalLength = 0;

  get length(): number {
    return this.totalLength;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  clear(): void {
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.totalLength = 0;
  }

  readUInt32BE(offset: number): number | undefined {
    if (offset < 0 || offset + 4 > this.totalLength) return undefined;

    const head = this.chunks[this.headIndex];
    /* c8 ignore next — head defined when totalLength > 0 */
    if (head !== undefined) {
      const start = this.headOffset + offset;
      if (start + 4 <= head.length) {
        /* c8 ignore start — bounds guaranteed by `start + 4 <= head.length` */
        const b1 = head[start] ?? 0;
        const b2 = head[start + 1] ?? 0;
        const b3 = head[start + 2] ?? 0;
        const b4 = head[start + 3] ?? 0;
        /* c8 ignore stop */
        return ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
      }
    }

    let remaining = this.headOffset + offset;
    const bytes = new Uint8Array(4);
    let writeOffset = 0;

    for (let i = this.headIndex; i < this.chunks.length && writeOffset < 4; i++) {
      const chunk = this.chunks[i];
      /* c8 ignore next — chunks between headIndex and end are always populated */
      if (chunk === undefined) return undefined;
      if (remaining >= chunk.length) {
        remaining -= chunk.length;
        continue;
      }

      const bytesToCopy = Math.min(4 - writeOffset, chunk.length - remaining);
      bytes.set(chunk.subarray(remaining, remaining + bytesToCopy), writeOffset);
      writeOffset += bytesToCopy;
      remaining = 0;
    }

    /* c8 ignore start — bytes is a fixed 4-byte Uint8Array */
    const b1 = bytes[0] ?? 0;
    const b2 = bytes[1] ?? 0;
    const b3 = bytes[2] ?? 0;
    const b4 = bytes[3] ?? 0;
    /* c8 ignore stop */
    return ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
  }

  consume(length: number): Uint8Array {
    if (length < 0 || length > this.totalLength) {
      throw new Error(`Cannot consume ${length} bytes from ${this.totalLength}-byte buffer`);
    }
    if (length === 0) return new Uint8Array(0);

    const head = this.chunks[this.headIndex];
    /* c8 ignore next — head defined when totalLength > 0 */
    if (head !== undefined) {
      const headRemaining = head.length - this.headOffset;
      if (headRemaining >= length) {
        const slice = head.subarray(this.headOffset, this.headOffset + length);
        this.headOffset += length;
        this.totalLength -= length;
        if (this.headOffset === head.length) {
          this.headIndex++;
          this.headOffset = 0;
          this.compactChunks();
        }
        return slice;
      }
    }

    const result = new Uint8Array(length);
    let writeOffset = 0;
    let remaining = length;

    while (remaining > 0) {
      const chunk = this.chunks[this.headIndex];
      /* c8 ignore next 3 — guarded by line-116 length check */
      if (chunk === undefined) {
        throw new Error('FrontendMessageBuffer underflow');
      }
      const available = chunk.length - this.headOffset;
      const bytesToCopy = Math.min(remaining, available);
      result.set(chunk.subarray(this.headOffset, this.headOffset + bytesToCopy), writeOffset);
      writeOffset += bytesToCopy;
      remaining -= bytesToCopy;
      this.headOffset += bytesToCopy;
      this.totalLength -= bytesToCopy;
      if (this.headOffset === chunk.length) {
        this.headIndex++;
        this.headOffset = 0;
        this.compactChunks();
      }
    }

    return result;
  }

  private compactChunks(): void {
    if (this.headIndex === this.chunks.length) {
      this.chunks = [];
      this.headIndex = 0;
      return;
    }

    if (this.headIndex >= 32 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}
