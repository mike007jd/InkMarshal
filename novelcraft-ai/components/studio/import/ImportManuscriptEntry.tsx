'use client';

// ImportManuscriptEntry (W2-1) — fully self-contained mount point for the
// manuscript-import flow. Drop `<ImportManuscriptEntry />` anywhere in the
// desktop studio (e.g. the desktop-studio header next to "New novel", or a
// novel's "…" menu) and it owns its own button + wizard + novel-list fetch.
//
// SELF-CONTAINED so the studio shell stays untouched beyond the single mount
// line — it pulls its own novel list (for the merge target picker) via the same
// `useNovels` hook the shell uses, and routes to the imported novel on success.
//
// `variant` lets the host match the surrounding button emphasis; geometry is
// owned here so a host cannot fork the button shape contract.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { useNovels } from '@/lib/use-storage';
import { isTauriRuntime } from '@/lib/desktop-runtime';
import { ImportWizard } from '@/components/studio/import/ImportWizard';
import { importCopy } from '@/components/studio/import/import-copy';

interface ImportManuscriptEntryProps {
  /** Pre-select a merge target when launched from a specific novel's menu. */
  targetNovelId?: string;
  /** Button emphasis override; geometry remains canonical. */
  variant?: React.ComponentProps<typeof Button>['variant'];
  /** Render only the icon (for compact menu placements). */
  iconOnly?: boolean;
  /** Called after a successful import (host may refresh its own list). */
  onImported?: (novelId: string) => void;
}

export function ImportManuscriptEntry({
  targetNovelId,
  variant = 'outline',
  iconOnly,
  onImported,
}: ImportManuscriptEntryProps) {
  const { locale } = useLanguage();
  const router = useRouter();
  const { novels, refresh } = useNovels();
  const [open, setOpen] = useState(false);
  const copy = importCopy(locale);

  // Manuscript import reads local files through the native dialog — desktop
  // only. Render nothing on the web build so the entry never dead-ends.
  if (!isTauriRuntime()) return null;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        onClick={() => setOpen(true)}
        className="h-auto px-4 py-2"
        title={copy.entryLabel}
      >
        <FileUp className="h-4 w-4" />
        {!iconOnly && copy.entryLabel}
      </Button>
      <ImportWizard
        open={open}
        onClose={() => setOpen(false)}
        novels={novels.map(n => ({ id: n.id, title: n.title }))}
        initialTargetNovelId={targetNovelId}
        onImported={(novelId) => {
          void refresh();
          onImported?.(novelId);
          router.push(`/novel/${novelId}?view=read-edit`);
        }}
      />
    </>
  );
}
