'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lightbulb, PenLine } from 'lucide-react';

import { ImportManuscriptEntry } from '@/components/studio/import/ImportManuscriptEntry';
import { LocalLibraryRecovery } from '@/components/LocalLibraryRecovery';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import {
  localDatabaseIssueCopy,
  useNovels,
  type LocalDatabaseIssueCode,
} from '@/lib/use-storage';

export default function DesktopStudioShell() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const router = useRouter();
  const { create, databaseIssue, refresh } = useNovels();
  const [creating, setCreating] = useState(false);
  const [createIssue, setCreateIssue] = useState<LocalDatabaseIssueCode | null>(null);
  const creatingRef = useRef(false);

  const activeIssue = createIssue ?? databaseIssue;
  const issueCopy = activeIssue ? localDatabaseIssueCopy(t, activeIssue) : null;

  const handleRetry = async () => {
    setCreateIssue(null);
    await refresh();
  };

  const handleCreateNovel = async (mode: 'idea' | 'blank') => {
    if (creating) return;
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const result = await create(mode === 'blank'
        ? {
            title: t.untitledNovel,
            genre: '',
            creationMode: 'blank',
            firstChapterTitle: t.manuscriptChapter.replace('{num}', '1'),
          }
        : {
            title: t.untitledNovel,
            genre: '',
            openingAssistantMessage: t.agentOpeningMessage,
          });
      if (!result.novel?.id) {
        // Typed local-database failures stay inline so repeated create clicks
        // do not accumulate identical generic toasts.
        if (result.databaseIssue) {
          setCreateIssue(result.databaseIssue);
          return;
        }
        toast(t.errorCreateNovel, 'error');
        return;
      }
      setCreateIssue(null);
      router.push(mode === 'blank'
        ? `/novel/${result.novel.id}?view=read-edit&chapter=1&edit=1`
        : `/novel/${result.novel.id}?view=agent`);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div className="book-texture-parchment flex h-full min-w-0 flex-1 flex-col overflow-hidden text-book-ink-primary">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-6 py-10 lg:px-12">
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
          <h1 className="font-serif text-2xl leading-tight text-book-ink-primary md:text-3xl">
            {t.agentNewChatTitle}
          </h1>
          {issueCopy && (
            <div
              role="alert"
              className="mt-6 w-full rounded-md border border-book-danger/40 bg-book-danger/5 px-4 py-3 text-left"
            >
              <p className="text-sm font-medium text-book-danger">{issueCopy.title}</p>
              <p className="mt-1 text-sm text-book-ink-secondary">{issueCopy.body}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRetry()}
                >
                  {t.toastRetry}
                </Button>
                <LocalLibraryRecovery />
              </div>
            </div>
          )}
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button
              type="button"
              variant="book"
              size="md"
              disabled={creating || Boolean(activeIssue)}
              onClick={() => void handleCreateNovel('idea')}
              className="h-auto px-5 py-2.5"
            >
              <Lightbulb className="h-4 w-4" />
              {t.startWithIdea}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="md"
              disabled={creating || Boolean(activeIssue)}
              onClick={() => void handleCreateNovel('blank')}
              className="h-auto px-5 py-2.5"
            >
              <PenLine className="h-4 w-4" />
              {t.blankManuscript}
            </Button>
            <ImportManuscriptEntry
              variant="outline"
              disabled={Boolean(activeIssue)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
