import { LOCAL_USER_ID } from '@/lib/local-user';
import { detectChapters } from '@/lib/import/detect-chapters';
import {
  MAX_IMPORT_BASENAME_CHARS,
  MAX_IMPORT_CHAPTERS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_PARAGRAPHS,
  MAX_IMPORT_RECONSTRUCTED_BYTES,
  MAX_IMPORT_TITLE_CHARS,
  IMPORT_SESSION_TTL_MS,
} from '@/lib/import/limits';
import { parseDocx } from '@/lib/import/parse-docx';
import { parseText, sourceFromFilename } from '@/lib/import/parse-text';
import { buildPreviewChapters, segmentFromCandidate } from '@/lib/import/preview';
import {
  desktopSessionBinding,
  readStagedMeta,
  writeImportSession,
  type ImportSessionRecord,
} from '@/lib/import/session-store';
import type { ImportPreviewChapter, ImportSource } from '@/lib/import/types';

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

export interface OpenImportSessionInput {
  token: string;
  /** Client-reported basename; must match staged metadata. */
  basename: string;
}

export interface OpenImportSessionResult {
  sessionToken: string;
  source: ImportSource;
  filename: string;
  suggestedTitle: string;
  chapters: ImportPreviewChapter[];
}

/**
 * Parse a Rust-staged manuscript into a bound Node session. Full prose stays
 * under the app-owned session directory; only bounded previews are returned.
 */
export async function openImportSession(
  input: OpenImportSessionInput,
): Promise<OpenImportSessionResult> {
  const basename = (input.basename ?? '').trim();
  if (!basename || basename.length > MAX_IMPORT_BASENAME_CHARS) {
    throw new Error('Import filename is invalid.');
  }
  if (basename.includes('/') || basename.includes('\\') || CONTROL_CHAR_RE.test(basename)) {
    throw new Error('Import filename is invalid.');
  }

  const { meta, bytes } = readStagedMeta(input.token);
  if (meta.basename !== basename) {
    throw new Error('Import session basename does not match the staged file.');
  }
  if (bytes.length > MAX_IMPORT_FILE_BYTES) {
    throw new Error('The selected file is too large to import (max 25 MB).');
  }

  const source = sourceFromFilename(basename);
  const doc =
    source === 'docx'
      ? await parseDocx(bytes, basename)
      : parseText(bytes.toString('utf-8'), basename, source === 'md' ? 'md' : 'txt');

  const candidates = detectChapters(doc);
  if (candidates.length === 0 || candidates.every(c => c.content.trim() === '')) {
    throw new Error('No readable text was found in the file.');
  }
  if (candidates.length > MAX_IMPORT_CHAPTERS) {
    throw new Error('Too many chapters to import.');
  }

  const segments = candidates.map(segmentFromCandidate);
  if (segments.some(segment =>
    segment.title.length > MAX_IMPORT_TITLE_CHARS
    || CONTROL_CHAR_RE.test(segment.title)
    || (
      segment.volumeTitle !== null
      && (
        segment.volumeTitle.length > MAX_IMPORT_TITLE_CHARS
        || CONTROL_CHAR_RE.test(segment.volumeTitle)
      )
    )
  )) {
    throw new Error('The manuscript contains an invalid or overlong chapter title.');
  }
  const paragraphCount = segments.reduce((sum, segment) => sum + segment.paragraphs.length, 0);
  if (paragraphCount > MAX_IMPORT_PARAGRAPHS) {
    throw new Error('The manuscript has too many paragraphs to preview safely.');
  }
  const reconstructedBytes = segments.reduce(
    (sum, segment) =>
      sum
      + Buffer.byteLength(segment.title, 'utf8')
      + segment.paragraphs.reduce(
        (paragraphSum, paragraph) =>
          paragraphSum + Buffer.byteLength(paragraph, 'utf8'),
        0,
      ),
    0,
  );
  if (reconstructedBytes > MAX_IMPORT_RECONSTRUCTED_BYTES) {
    throw new Error('The parsed manuscript is too large to import safely.');
  }
  const now = Date.now();
  const suggestedTitle =
    basename.replace(/\.[^./\\]+$/, '').trim() || 'Imported manuscript';

  const record: ImportSessionRecord = {
    version: 1,
    token: input.token.trim(),
    ownerUserId: LOCAL_USER_ID,
    desktopSessionBinding: desktopSessionBinding(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + IMPORT_SESSION_TTL_MS).toISOString(),
    source,
    basename,
    filename: basename,
    suggestedTitle,
    segments,
  };
  writeImportSession(record);

  return {
    sessionToken: record.token,
    source,
    filename: basename,
    suggestedTitle,
    chapters: buildPreviewChapters(segments),
  };
}
