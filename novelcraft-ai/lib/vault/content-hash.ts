// TS-side SHA-256 that matches the Rust impl byte-for-byte. Computed before
// the writer round-trip so the index `content_hash` is available without an
// extra IPC call. Production targets all have SubtleCrypto; tests run on
// Node 19+ where `crypto.subtle` is always present.

const HEX_CHARS = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX_CHARS[b >> 4] + HEX_CHARS[b & 0x0f];
  }
  return out;
}

export async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(buf));
}
