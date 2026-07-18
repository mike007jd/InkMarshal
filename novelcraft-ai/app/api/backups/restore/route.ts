import { NextResponse } from 'next/server';

import { restoreBundleAsCopy } from '@/lib/backup/restore';
import { verifyBackupPackage } from '@/lib/backup/verify';
import { requireLocalUser } from '@/lib/local-auth';

export const runtime = 'nodejs';

const MAX_BACKUP_BYTES = 128 * 1024 * 1024;

export async function POST(request: Request) {
  await requireLocalUser();
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BACKUP_BYTES) {
    return NextResponse.json({ error: 'backup_too_large' }, { status: 413 });
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) {
    return NextResponse.json({ error: 'backup_empty' }, { status: 400 });
  }
  if (buffer.byteLength > MAX_BACKUP_BYTES) {
    return NextResponse.json({ error: 'backup_too_large' }, { status: 413 });
  }

  const report = await verifyBackupPackage(new Uint8Array(buffer));
  if (!report.ok || !report.bundle) {
    return NextResponse.json({
      error: 'backup_invalid',
      issues: report.errors.map(issue => ({ code: issue.code, detail: issue.detail, ref: issue.ref })),
    }, { status: 422 });
  }

  const restored = await restoreBundleAsCopy(report.bundle);
  return NextResponse.json({
    ...restored,
    verified: true,
    manifest: {
      formatVersion: report.manifest?.formatVersion ?? null,
      exportedAt: report.manifest?.exportedAt ?? null,
    },
  });
}
