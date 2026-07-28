'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ListChecks } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { ManuscriptShell } from '@/components/ManuscriptShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { UnificationPanel } from '@/components/UnificationPanel';
import { useCapabilityBinding } from '@/components/WritingModelStatusBar';
import type { UnificationReport } from '@/lib/db-types';
import { resolveManuscriptShellMode } from '@/lib/manuscript-mode';
import { STAGES_THAT_CAN_START_WRITING, isInStages } from '@/lib/novel-stages';
import type { ManuscriptSession } from '@/lib/use-manuscript-session';

export function ManuscriptWorkspacePane({
  novelId,
  manuscript,
  showUnification,
  onJumpToOutline,
  requestedChapter,
  startInEditing,
  requestedOffset,
}: {
  novelId: string;
  manuscript: ManuscriptSession;
  showUnification: boolean;
  onJumpToOutline: () => void;
  requestedChapter?: number | null;
  startInEditing?: boolean;
  requestedOffset?: number | null;
}) {
  const { t } = useLanguage();
  const [retryingLoad, setRetryingLoad] = useState(false);
  const planningBinding = useCapabilityBinding('outline');
  const draftingBinding = useCapabilityBinding('chapter');
  const {
    novel,
    chapters,
    isLoading,
    isStreaming,
    didRequestAutostart,
    liveChapter,
    resumePromptVisible,
    resumeCountdown,
    batchDone,
    fetchChapters,
    fetchNovel,
    startWriting,
    pauseWriting,
    cancelResume,
    dismissBatchDone,
  } = manuscript;

  if (isLoading && !novel) {
    return (
      <div className="flex flex-1 items-center justify-center font-serif text-xl text-book-ink-secondary">
        {t.loading || 'Loading'}
      </div>
    );
  }
  if (!novel) {
    const retryLoad = async () => {
      if (retryingLoad) return;
      setRetryingLoad(true);
      try {
        await Promise.allSettled([fetchNovel(), fetchChapters()]);
      } finally {
        setRetryingLoad(false);
      }
    };
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="font-serif text-base text-book-ink-secondary">
          {t.errorLoadManuscript}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={retryingLoad}
          onClick={() => void retryLoad()}
        >
          {retryingLoad ? (t.loading || 'Loading') : t.toastRetry}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-book-bg-secondary">
      <ManuscriptToolbar
        onJumpToOutline={onJumpToOutline}
        showUnification={showUnification}
        novelId={novelId}
        report={novel.unificationReport ?? null}
        onApplied={fetchChapters}
        onComplete={fetchNovel}
      />

      {batchDone && (
        <ManuscriptNoticeRow
          title={t.writingBatchDone.replace('{chapter}', String(batchDone.completedChapter))}
          subtext={t.writingBatchRemaining.replace('{remaining}', String(batchDone.remaining))}
          secondaryLabel={t.writingEditBlueprint}
          onSecondary={() => {
            dismissBatchDone();
            onJumpToOutline();
          }}
          primaryLabel={t.writingNextChapter}
          onPrimary={() => {
            dismissBatchDone();
            void startWriting({ chapters: 1 });
          }}
        />
      )}

      {resumePromptVisible && !batchDone && (
        <ManuscriptNoticeRow
          title={t.resumeWritingTitle}
          subtext={resumeCountdown !== null
            ? t.resumeWritingDesc.replace('{seconds}', String(resumeCountdown))
            : t.resumeWritingPause}
          secondaryLabel={t.resumeWritingCancel}
          onSecondary={cancelResume}
          primaryLabel={resumeCountdown !== null ? t.resumeWritingNow : t.writingNextChapter}
          onPrimary={() => {
            cancelResume();
            void startWriting({ chapters: 1 });
          }}
        />
      )}

      <ManuscriptShell
        key={novelId}
        novelId={novelId}
        title={novel.title || t.untitledNovel}
        genre={novel.genre}
        storySummary={novel.storySummary}
        characterSummary={novel.characterSummary}
        arcSummary={novel.arcSummary}
        progress={novel.progress}
        mode={resolveManuscriptShellMode({
          didRequestAutostart,
          isStreaming,
          liveChapter,
          batchDone,
          resumePromptVisible,
        })}
        chapters={chapters}
        liveChapter={liveChapter}
        onChaptersChange={fetchChapters}
        initialCreativity={novel.settings?.creativity ?? null}
        requestedChapter={requestedChapter}
        startInEditing={startInEditing}
        requestedOffset={requestedOffset}
        canContinueWriting={
          novel.progress < 100
          && isInStages(novel.stage, STAGES_THAT_CAN_START_WRITING)
        }
        writingRunState={{
          ...manuscript.writingRunState,
          modelLabel: (() => {
            const resolved = manuscript.writingRunState.phase === 'preparing'
              || manuscript.writingRunState.phase === 'planning'
              ? planningBinding.resolved
              : draftingBinding.resolved;
            return resolved.binding && resolved.conn
              ? `${resolved.conn.label} · ${resolved.binding.modelId}`
              : t.writingPreviewModelPending;
          })(),
        }}
        writingRunControls={{
          onPause: isStreaming ? pauseWriting : undefined,
          onResume: !batchDone && !resumePromptVisible
            ? () => { void startWriting({ chapters: 1 }); }
            : undefined,
          onRetry: () => { void startWriting({ chapters: 1 }); },
        }}
      />
    </div>
  );
}

function ManuscriptNoticeRow({
  title,
  subtext,
  secondaryLabel,
  onSecondary,
  primaryLabel,
  onPrimary,
}: {
  title: string;
  subtext: string;
  secondaryLabel: string;
  onSecondary: () => void;
  primaryLabel: string;
  onPrimary: () => void;
}) {
  return (
    <div className="mx-4 my-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-book-border bg-book-bg-card/80 px-4 py-1.5 shadow-sm backdrop-blur md:mx-6">
      <div className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
        <span className="shrink-0 font-medium text-book-ink-primary">{title}</span>
        <span className="truncate text-xs text-book-ink-secondary">{subtext}</span>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="unstyled"
          size="unstyled"
          onClick={onSecondary}
          className="border border-book-border bg-book-bg-secondary px-3 py-1 text-xs font-medium text-book-ink-secondary transition-feedback hover:bg-book-bg-card"
        >
          {secondaryLabel}
        </Button>
        <Button
          variant="accent"
          type="button"
          onClick={onPrimary}
          className="h-auto px-3 py-1 text-xs font-semibold"
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}

function ManuscriptToolbar({
  onJumpToOutline,
  showUnification,
  novelId,
  report,
  onApplied,
  onComplete,
}: {
  onJumpToOutline: () => void;
  showUnification: boolean;
  novelId: string;
  report: UnificationReport | null;
  onApplied?: () => void;
  onComplete?: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const pendingCount = useMemo(
    () => (report?.edits ?? []).filter(edit => !edit.applied && !edit.skipped).length,
    [report],
  );

  if (!showUnification) return null;

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 pb-1 md:px-6">
        <Button
          ref={pillRef}
          type="button"
          variant="unstyled"
          size="unstyled"
          onClick={() => setOpen(current => !current)}
          aria-expanded={open}
          aria-controls={panelId}
          className="inline-flex items-center gap-1.5 border border-book-border bg-book-bg-card/70 px-3.5 py-1.5 text-sm font-medium text-book-ink-secondary shadow-sm backdrop-blur transition-feedback hover:bg-book-bg-card"
        >
          <ListChecks className="h-4 w-4 shrink-0 text-book-gold" aria-hidden="true" />
          <span>{t.unificationTitle}</span>
          {pendingCount > 0 ? (
            <Badge variant="writing">
              {t.unificationPendingCount.replace('{count}', String(pendingCount))}
            </Badge>
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-book-success" aria-hidden="true" />
          )}
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-book-ink-muted transition-toggle ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen} modal={false}>
        <SheetContent
          id={panelId}
          aria-describedby={undefined}
          side="right"
          showOverlay={false}
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
          onInteractOutside={event => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            pillRef.current?.focus();
          }}
        >
          <SheetHeader className="shrink-0 border-b border-book-border">
            <SheetTitle className="flex items-center gap-1.5 font-serif text-base text-book-ink-primary">
              <ListChecks className="h-4 w-4 shrink-0 text-book-gold" aria-hidden="true" />
              <span>{t.unificationTitle}</span>
              {pendingCount > 0 && (
                <Badge variant="writing">
                  {t.unificationPendingCount.replace('{count}', String(pendingCount))}
                </Badge>
              )}
            </SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <UnificationPanel
              novelId={novelId}
              initialReport={report}
              onApplied={onApplied}
              onComplete={onComplete}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
