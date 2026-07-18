import 'server-only';

import type { FileUIPart } from 'ai';
import { getUIMessageText, type NovelChatUIMessage } from '@/lib/chat-ui-message';

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS = 24_000;

export interface ChatMessageContentResult {
  content: string;
  errors: string[];
}

export async function buildUserMessageContentWithAttachments(
  message: Pick<NovelChatUIMessage, 'parts'>,
): Promise<ChatMessageContentResult> {
  const text = getUIMessageText(message);
  const fileParts = message.parts.filter(isFileUIPart);
  const errors: string[] = [];
  const attachmentBlocks: string[] = [];

  for (const part of fileParts) {
    const converted = await filePartToContextBlock(part);
    if (converted.error) {
      errors.push(converted.error);
      continue;
    }
    if (converted.block) attachmentBlocks.push(converted.block);
  }

  return {
    content: [text, ...attachmentBlocks].filter(Boolean).join('\n\n').trim(),
    errors,
  };
}

function isFileUIPart(part: NovelChatUIMessage['parts'][number]): part is FileUIPart {
  return part.type === 'file' && typeof (part as FileUIPart).url === 'string';
}

async function filePartToContextBlock(part: FileUIPart): Promise<{ block?: string; error?: string }> {
  const filename = part.filename?.trim() || 'attached file';
  const mediaType = (part.mediaType || '').toLowerCase();
  const decoded = decodeDataUrl(part.url, mediaType);
  const byteLength = decoded?.bytes.byteLength ?? estimateDataUrlBytes(part.url);

  if (byteLength > MAX_ATTACHMENT_BYTES) {
    return { error: `${filename} is too large to attach. Keep each reference file under 8 MB.` };
  }

  if (mediaType.startsWith('image/')) {
    return {
      block: `[Reference image attached: ${filename} (${mediaType || 'image'}, ${formatBytes(byteLength)}). Vision analysis requires a multimodal model; if the current model is text-only, treat this as a reference image description request.]`,
    };
  }

  if (isPdf(mediaType, filename)) {
    return {
      block: `[Reference PDF attached: ${filename} (${formatBytes(byteLength)}). PDF text extraction is not available in this route yet, so ask the user for key excerpts if needed.]`,
    };
  }

  if (isDocx(mediaType, filename)) {
    if (!decoded) return { error: `${filename} must be attached as file data, not an external link.` };
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(decoded.bytes) });
    const text = trimAttachmentText(result.value);
    return text
      ? { block: attachmentTextBlock(filename, text) }
      : { error: `${filename} did not contain extractable text.` };
  }

  if (isTextLike(mediaType, filename)) {
    if (!decoded) return { error: `${filename} must be attached as file data, not an external link.` };
    const text = trimAttachmentText(new TextDecoder('utf-8', { fatal: false }).decode(decoded.bytes));
    return text
      ? { block: attachmentTextBlock(filename, text) }
      : { error: `${filename} did not contain readable text.` };
  }

  return {
    error: `${filename} is not a supported reference attachment. Use image, TXT, Markdown, JSON, CSV, PDF, or DOCX files.`,
  };
}

function decodeDataUrl(url: string, fallbackMediaType: string): { mediaType: string; bytes: Uint8Array } | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const raw = url.slice(comma + 1);
  const mediaType = meta.split(';')[0] || fallbackMediaType;
  const isBase64 = /(?:^|;)base64(?:;|$)/i.test(meta);
  try {
    if (isBase64) {
      return { mediaType, bytes: Buffer.from(raw, 'base64') };
    }
    return { mediaType, bytes: Buffer.from(decodeURIComponent(raw), 'utf8') };
  } catch {
    return null;
  }
}

function estimateDataUrlBytes(url: string): number {
  if (!url.startsWith('data:')) return 0;
  const comma = url.indexOf(',');
  if (comma < 0) return 0;
  const data = url.slice(comma + 1);
  return Math.floor(data.replace(/=+$/, '').length * 0.75);
}

function isTextLike(mediaType: string, filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    mediaType.startsWith('text/') ||
    [
      'application/json',
      'application/ld+json',
      'application/xml',
      'application/x-ndjson',
      'application/javascript',
      'application/typescript',
    ].includes(mediaType) ||
    /\.(txt|md|markdown|csv|json|jsonl|xml|html|htm|rtf)$/i.test(lower)
  );
}

function isDocx(mediaType: string, filename: string): boolean {
  return (
    mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/i.test(filename)
  );
}

function isPdf(mediaType: string, filename: string): boolean {
  return mediaType === 'application/pdf' || /\.pdf$/i.test(filename);
}

function attachmentTextBlock(filename: string, text: string): string {
  return `<reference-attachment name="${escapeAttribute(filename)}">\n${text}\n</reference-attachment>`;
}

function trimAttachmentText(value: string): string {
  const compact = value.replace(/\r\n?/g, '\n').trim();
  return compact.length > MAX_ATTACHMENT_TEXT_CHARS
    ? `${compact.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n[Attachment text truncated.]`
    : compact;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
