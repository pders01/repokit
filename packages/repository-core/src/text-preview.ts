/** Decode a text preview without turning a cut UTF-8 suffix into a binary file. */
export function decodeTextPreview(bytes: Uint8Array, truncated: boolean): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    // Streaming decode keeps an incomplete final code point buffered. There is
    // deliberately no flush for a truncated preview; malformed interior bytes
    // and incomplete sequences in a complete file still fail closed.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
  } catch {
    return undefined;
  }
}
