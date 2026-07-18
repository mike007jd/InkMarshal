import { NextResponse } from 'next/server';

import { buildBackupPackage } from '@/lib/backup/build-package';
import { extractBackupBundle } from '@/lib/backup/extract';
import { exportAttachmentHeaders, exportFilenameBase } from '@/lib/exporters/filename';
import { requireNovelOwner } from '@/lib/local-auth';

export const runtime = 'nodejs';

const MAX_BACKUP_BYTES = 128 * 1024 * 1024;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const bundle = await extractBackupBundle(id);
  const { bytes } = await buildBackupPackage(bundle);
  if (bytes.byteLength > MAX_BACKUP_BYTES) {
    return NextResponse.json({ error: 'Backup exceeds the 128 MiB desktop restore limit.' }, { status: 413 });
  }

  return new Response(bytes.slice().buffer, {
    headers: exportAttachmentHeaders(
      `${exportFilenameBase(ownerCheck.novel.title)}.inkmarshal`,
      'application/vnd.inkmarshal.backup+zip',
    ),
  });
}
