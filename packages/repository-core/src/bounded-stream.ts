export interface BoundedStreamResult {
  bytes: Uint8Array;
  truncated: boolean;
}

/** Drain Node or Web streams, retaining at most the requested number of bytes. */
export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  maximumBytes?: number,
): Promise<BoundedStreamResult> {
  if (maximumBytes !== undefined && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)) {
    throw new RangeError("Invalid stream byte limit");
  }
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const available = maximumBytes === undefined ? chunk.byteLength : Math.max(0, maximumBytes - retainedBytes);
    if (available > 0) {
      // Copy rather than retaining a small view of an arbitrarily large chunk.
      const retained = new Uint8Array(chunk.subarray(0, available));
      chunks.push(retained);
      retainedBytes += retained.byteLength;
    }
    if (chunk.byteLength > available) truncated = true;
  }
  const bytes = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}
