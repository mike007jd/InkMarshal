import { describe, expect, it } from 'vitest';

import { parseDownloadFilename, sanitizeDownloadFilename } from '@/lib/download';

describe('download filename parsing', () => {
  it('sanitizes fallback filenames before assigning them to browser downloads', () => {
    expect(parseDownloadFilename(null, '../Bad\\Name\r\n.txt')).toBe('Bad Name .txt');
  });

  it('decodes RFC 5987 names while stripping path and control characters', () => {
    const header = "attachment; filename*=UTF-8''%E6%98%9F%E6%B2%B3%2F..%0D%0A.zip";

    expect(parseDownloadFilename(header, 'fallback.zip')).toBe('星河 .zip');
  });

  it('falls back when encoded content disposition is malformed', () => {
    expect(parseDownloadFilename("attachment; filename*=UTF-8''%E0%A4%A", 'ok.zip')).toBe(
      'ok.zip',
    );
  });

  it('bounds oversized filenames and preserves readable normal names', () => {
    const name = `${'A'.repeat(220)}.txt`;

    expect(sanitizeDownloadFilename(name)).toHaveLength(180);
    expect(sanitizeDownloadFilename('星河 纪事.txt')).toBe('星河 纪事.txt');
  });
});
