import { describe, expect, it } from 'vitest';

import {
  exportAttachmentHeaders,
  exportFilenameBase,
  exportFilenameForHeader,
  sanitizeFilenameSegment,
} from '@/lib/exporters/filename';

describe('export filename normalization', () => {
  it('removes path/header-control characters and falls back when empty', () => {
    expect(exportFilenameBase('../Bad\\Name\r\n')).toBe('Bad Name');
    expect(exportFilenameBase('////')).toBe('novel');
  });

  it('removes dot-only path segments from reusable filename segments', () => {
    expect(sanitizeFilenameSegment('.././Bad\\Name')).toBe('Bad Name');
    expect(sanitizeFilenameSegment('..', 'fallback')).toBe('fallback');
  });

  it('keeps readable CJK titles while bounding base length', () => {
    expect(exportFilenameBase('星河  纪事')).toBe('星河 纪事');
    expect(exportFilenameBase('A'.repeat(200))).toHaveLength(120);
  });

  it('emits a CRLF-free attachment header with encoded UTF-8 filename', () => {
    const header = exportFilenameForHeader('星河\r\n投稿包.zip');

    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header).toContain('attachment; filename=');
    expect(header).toContain('filename="download.zip"');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain('%E6%98%9F%E6%B2%B3');
  });

  it('sanitizes path and quote characters before writing the attachment header', () => {
    const header = exportFilenameForHeader('../Bad\\Name";x\u007F.txt');

    expect(header).not.toContain('/');
    expect(header).not.toContain('\\');
    expect(header).not.toContain('Name";');
    expect(header).not.toContain(';x');
    expect(header).toContain('Bad%20Name%20%3Bx%20.txt');
  });

  it('marks exported manuscript attachments as private non-cacheable downloads', () => {
    const headers = new Headers(exportAttachmentHeaders('星河.txt', 'text/plain; charset=utf-8'));

    expect(headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(headers.get('pragma')).toBe('no-cache');
    expect(headers.get('expires')).toBe('0');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('content-disposition')).toContain('attachment; filename=');
  });
});
