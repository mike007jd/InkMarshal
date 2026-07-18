import { NextResponse } from 'next/server';
import { getChapters } from '@/lib/db';
import { requireNovelOwner } from '@/lib/local-auth';
import { exportAttachmentHeaders, exportFilenameBase } from '@/lib/exporters/filename';

// Aligned with src-tauri/src/lib.rs `MAX_EXPORT_FILE_BYTES` (256 MiB). The
// Rust save_export_file command rejects anything larger, so producing it on
// the Node side first would just waste the cycles + memory to assemble a
// bundle the next hop will refuse. Reject up front with a friendly message.
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { novel } = ownerCheck;

  // Read-only: a consistent `getChapters` snapshot is enough, so don't take the
  // writing lock (which would 409 the bundle during a background write/unify).
  const chapters = await getChapters(id);

  // Stable `code`s let the client render a localized toast; `error` stays as an
  // English fallback for any non-UI consumer.
  if (chapters.length === 0) {
    return NextResponse.json(
      { code: 'NO_CHAPTERS', error: 'At least one chapter is required to build an export ZIP' },
      { status: 400 },
    );
  }

  let bundle: Uint8Array;
  try {
    const { buildSubmissionBundle } = await import('@/lib/exporters/bundle');
    bundle = await buildSubmissionBundle({ novel, chapters });
  } catch (err) {
    if (err instanceof Error && err.name === 'CJKNotSupportedError') {
      return NextResponse.json({ code: 'CJK_NOT_SUPPORTED', error: err.message }, { status: 400 });
    }
    return NextResponse.json({ code: 'BUNDLE_FAILED', error: 'Bundle export failed' }, { status: 500 });
  }

  if (bundle.byteLength > MAX_BUNDLE_BYTES) {
    const sizeMiB = Number((bundle.byteLength / (1024 * 1024)).toFixed(1));
    const maxMiB = MAX_BUNDLE_BYTES / (1024 * 1024);
    return NextResponse.json(
      {
        code: 'BUNDLE_TOO_LARGE',
        sizeMiB,
        maxMiB,
        error: `Export ZIP is too large (${sizeMiB} MiB; max ${maxMiB} MiB). Split the manuscript or trim attachments before exporting.`,
      },
      { status: 413 },
    );
  }

  const body = new Uint8Array(bundle).buffer;
  return new Response(body, {
    headers: exportAttachmentHeaders(
      `${exportFilenameBase(novel.title)}-export.zip`,
      'application/zip',
    ),
  });
}
