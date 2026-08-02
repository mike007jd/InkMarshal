'use client';

import { useState } from 'react';
import { Archive, ArchiveRestore, Download } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { requestManuscriptFlush } from '@/lib/desktop-shell-bus';
import { isTauriRuntime, readLocalFile } from '@/lib/desktop-runtime';
import { parseDownloadFilename, saveBlob } from '@/lib/download';

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function pickBackupBytes(): Promise<Uint8Array | null> {
  if (isTauriRuntime()) {
    const picked = await readLocalFile(['inkmarshal']);
    return picked ? decodeBase64(picked.contentsBase64) : null;
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.inkmarshal';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      void file.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), () => resolve(null));
    };
    input.click();
  });
}

export function BackupSettings({ novelId }: { novelId: string | null }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<'backup' | 'backup-all' | 'restore' | null>(null);
  const [libraryProgress, setLibraryProgress] = useState<{ completed: number; total: number } | null>(null);

  const createBackup = async () => {
    if (!novelId || busy) return;
    setBusy('backup');
    try {
      const saveOutcome = await requestManuscriptFlush();
      if (!saveOutcome.ok) throw new Error(t.editorSaveError);
      const response = await fetch(`/api/novels/${novelId}/backup`, { method: 'POST' });
      if (!response.ok) throw new Error(t.backupCreateFailed);
      const filename = parseDownloadFilename(
        response.headers.get('Content-Disposition'),
        'InkMarshal-backup.inkmarshal',
      );
      const saved = await saveBlob(await response.blob(), filename);
      if (saved === null) return;
      toast(t.backupCreateSuccess, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : t.backupCreateFailed, 'error');
    } finally {
      setBusy(null);
    }
  };

  const createLibraryBackup = async () => {
    if (busy) return;
    setBusy('backup-all');
    setLibraryProgress(null);
    try {
      if (novelId) {
        const saveOutcome = await requestManuscriptFlush();
        if (!saveOutcome.ok) throw new Error(t.editorSaveError);
      }
      const response = await fetch('/api/backups/library', { method: 'POST' });
      if (response.status === 204) {
        toast(t.backupAllEmpty, 'info');
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { code?: string } | null;
        throw new Error(
          body?.code === 'backup_verification_failed'
            ? t.backupAllVerificationFailed
            : t.backupAllCreateFailed,
        );
      }
      const count = Number(response.headers.get('X-InkMarshal-Novel-Count'));
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error(t.backupAllCreateFailed);
      setLibraryProgress({ completed: count, total: count });
      const filename = parseDownloadFilename(
        response.headers.get('Content-Disposition'),
        `InkMarshal-library-${new Date().toISOString().slice(0, 10)}.zip`,
      );
      const saved = await saveBlob(
        await response.blob(),
        filename,
      );
      if (saved === null) return;
      toast(t.backupAllCreateSuccess.replace('{count}', String(count)), 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : t.backupAllCreateFailed, 'error');
    } finally {
      setBusy(null);
      setLibraryProgress(null);
    }
  };

  const restoreBackup = async () => {
    if (busy) return;
    setBusy('restore');
    try {
      const bytes = await pickBackupBytes();
      if (!bytes) return;
      const response = await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.inkmarshal.backup+zip' },
        body: bytes.slice().buffer,
      });
      if (!response.ok) throw new Error(t.backupRestoreInvalid);
      const restored = await response.json() as {
        novelId: string;
        title: string;
        counts: { chapters: number };
        warnings?: string[];
      };
      toast(
        t.backupRestoreSuccess
          .replace('{title}', restored.title)
          .replace('{chapters}', String(restored.counts.chapters)),
        restored.warnings?.length ? 'info' : 'success',
      );
      router.push(`/novel/${restored.novelId}?view=read-edit`);
    } catch {
      toast(t.backupRestoreInvalid, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3 border-t border-book-border pt-5">
      <div>
        <h3 className="text-sm font-semibold text-book-ink-secondary">
          {t.backupSettingsTitle}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-book-ink-secondary">
          {t.backupSettingsDescription}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!novelId || busy !== null} onClick={() => void createBackup()}>
          {busy === 'backup' ? <Spinner /> : <Download className="size-4" />}
          {novelId ? t.backupCreateAction : t.backupOpenBookFirst}
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void createLibraryBackup()}>
          {busy === 'backup-all' ? <Spinner /> : <Archive className="size-4" />}
          {busy === 'backup-all' && libraryProgress
            ? t.backupAllProgress
                .replace('{completed}', String(libraryProgress.completed))
                .replace('{total}', String(libraryProgress.total))
            : t.backupAllCreateAction}
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void restoreBackup()}>
          {busy === 'restore' ? <Spinner /> : <ArchiveRestore className="size-4" />}
          {t.backupRestoreAction}
        </Button>
      </div>
    </section>
  );
}
