import { describe, expect, it } from 'vitest';
import { buildUserMessageContentWithAttachments } from '@/lib/chat-attachments.server';
import type { NovelChatUIMessage } from '@/lib/chat-ui-message';

function dataUrl(mediaType: string, text: string): string {
  return `data:${mediaType};base64,${Buffer.from(text, 'utf8').toString('base64')}`;
}

function messageWithParts(parts: NovelChatUIMessage['parts']): Pick<NovelChatUIMessage, 'parts'> {
  return { parts };
}

describe('buildUserMessageContentWithAttachments', () => {
  it('extracts text-like reference attachments into the model context', async () => {
    const result = await buildUserMessageContentWithAttachments(messageWithParts([
      { type: 'text', text: 'Use this note.', state: 'done' },
      {
        type: 'file',
        mediaType: 'text/markdown',
        filename: 'world.md',
        url: dataUrl('text/markdown', '# World\nThe moon is a prison.'),
      },
    ]));

    expect(result.errors).toEqual([]);
    expect(result.content).toContain('Use this note.');
    expect(result.content).toContain('<reference-attachment name="world.md">');
    expect(result.content).toContain('The moon is a prison.');
  });

  it('marks images as reference images without claiming vision analysis', async () => {
    const result = await buildUserMessageContentWithAttachments(messageWithParts([
      {
        type: 'file',
        mediaType: 'image/png',
        filename: 'mood.png',
        url: dataUrl('image/png', 'not-really-an-image'),
      },
    ]));

    expect(result.errors).toEqual([]);
    expect(result.content).toContain('Reference image attached: mood.png');
    expect(result.content).toContain('Vision analysis requires a multimodal model');
  });

  it('rejects unsupported attachment types clearly', async () => {
    const result = await buildUserMessageContentWithAttachments(messageWithParts([
      {
        type: 'file',
        mediaType: 'application/octet-stream',
        filename: 'archive.bin',
        url: dataUrl('application/octet-stream', 'binary'),
      },
    ]));

    expect(result.content).toBe('');
    expect(result.errors).toEqual([
      'archive.bin is not a supported reference attachment. Use image, TXT, Markdown, JSON, CSV, PDF, or DOCX files.',
    ]);
  });

  it('rejects malformed text attachment data without throwing', async () => {
    const result = await buildUserMessageContentWithAttachments(messageWithParts([
      {
        type: 'file',
        mediaType: 'text/plain',
        filename: 'bad.txt',
        url: 'data:text/plain,%E0%A4%A',
      },
    ]));

    expect(result.content).toBe('');
    expect(result.errors).toEqual(['bad.txt must be attached as file data, not an external link.']);
  });
});
