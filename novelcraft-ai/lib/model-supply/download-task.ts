function encodeDownloadTaskComponent(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (const byte of bytes) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x5f ||
      byte === 0x2e ||
      byte === 0x7e;
    out += unreserved
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function ggufDownloadTaskId(repoId: string, filename: string): string {
  const encodedRepo = encodeDownloadTaskComponent(repoId);
  const encodedFilename = encodeDownloadTaskComponent(filename);
  return `hf:gguf:v2:${encodedRepo}/${encodedFilename}`;
}

export function snapshotDownloadTaskId(repoId: string): string {
  return repoId;
}
