export const BUZZ_RELEASE_MAX_CONTENT_BYTES = 32_000;

/** Full selected output. Tags include the frozen signer delegation, if any.
 * No normalization, Markdown rewrite or URL substitution is permitted. */
export interface BuzzReleasePayload {
  agentPubkey: string;
  content: string;
  tags: readonly (readonly string[])[];
}

/** Portable UTF-8 length framing: for each string write its decimal byte length,
 * a colon, then its bytes. Fields are domain, kind, signer, content, tag count,
 * followed by each tag's field count and its fields in order. Counts are decimal.
 * This hashes the selected output; it is neither an approval nor a relay receipt.
 */
export function encodeBuzzReleasePayload(payload: BuzzReleasePayload): Uint8Array {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const invalid = (): never => { throw new Error('Invalid selected Buzz output'); };
  if (!payload || !/^[0-9a-f]{64}$/u.test(payload.agentPubkey)
    || typeof payload.content !== 'string' || decoder.decode(encoder.encode(payload.content)) !== payload.content
    || !payload.content.trim() || encoder.encode(payload.content).byteLength > BUZZ_RELEASE_MAX_CONTENT_BYTES
    || !Array.isArray(payload.tags) || payload.tags.length < 2 || payload.tags.length > 8) invalid();
  const frames: Uint8Array[] = [];
  const frame = (value: string): void => {
    if (typeof value !== 'string' || decoder.decode(encoder.encode(value)) !== value) invalid();
    const bytes = encoder.encode(value);
    frames.push(encoder.encode(`${bytes.byteLength}:`), bytes);
  };
  frame('axis.buzz.selected-output.v1');
  frame('9');
  frame(payload.agentPubkey);
  frame(payload.content);
  frame(String(payload.tags.length));
  for (const tag of payload.tags) {
    if (!Array.isArray(tag) || tag.length < 1 || tag.length > 4) invalid();
    frame(String(tag.length));
    for (const field of tag) {
      if (typeof field !== 'string' || encoder.encode(field).byteLength > 4096) invalid();
      frame(field);
    }
  }
  const output = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
  let offset = 0;
  for (const frame of frames) { output.set(frame, offset); offset += frame.byteLength; }
  return output;
}
