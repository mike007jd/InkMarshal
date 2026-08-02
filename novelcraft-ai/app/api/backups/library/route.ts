import { NextResponse } from 'next/server';

import { buildBackupPackage } from '@/lib/backup/build-package';
import {
  buildLibraryBackupPackage,
  type LibraryBackupItem,
} from '@/lib/backup/build-library-package';
import { extractBackupBundle } from '@/lib/backup/extract';
import { verifyBackupPackage } from '@/lib/backup/verify';
import { getActiveNovels } from '@/lib/db';
import { exportAttachmentHeaders } from '@/lib/exporters/filename';
import { requireLocalUser } from '@/lib/local-auth';

export const runtime = 'nodejs';

export async function POST() {
  const { user } = await requireLocalUser();
  const novels = await getActiveNovels(user.id);
  if (novels.length === 0) return new Response(null, { status: 204 });

  const items: LibraryBackupItem[] = [];
  for (const novel of novels) {
    const bundle = await extractBackupBundle(novel.id);
    const built = await buildBackupPackage(bundle);
    const verification = await verifyBackupPackage(built.bytes);
    if (!verification.ok) {
      return NextResponse.json(
        { error: 'A novel backup failed server-side verification.', code: 'backup_verification_failed' },
        { status: 422 },
      );
    }
    items.push({ novel, backupBytes: built.bytes });
  }

  const date = new Date().toISOString().slice(0, 10);
  const library = buildLibraryBackupPackage(items);
  const headers = new Headers(exportAttachmentHeaders(
    `InkMarshal-library-${date}.zip`,
    'application/zip',
  ));
  headers.set('X-InkMarshal-Novel-Count', String(items.length));
  return new Response(library.bytes.slice().buffer, { headers });
}
