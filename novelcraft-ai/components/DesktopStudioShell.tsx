'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lightbulb, PenLine } from 'lucide-react';

import { ImportManuscriptEntry } from '@/components/studio/import/ImportManuscriptEntry';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { useNovels } from '@/lib/use-storage';

export default function DesktopStudioShell() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const router = useRouter();
  const { create } = useNovels();
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  const handleCreateNovel = async (mode: 'idea' | 'blank') => {
    if (creating) return;
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const novel = await create(mode === 'blank'
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
      if (!novel?.id) {
        toast(t.errorCreateNovel, 'error');
        return;
      }
      router.push(mode === 'blank'
        ? `/novel/${novel.id}?view=read-edit&chapter=1&edit=1`
        : `/novel/${novel.id}?view=agent`);
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
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button
              type="button"
              variant="book"
              size="md"
              disabled={creating}
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
              disabled={creating}
              onClick={() => void handleCreateNovel('blank')}
              className="h-auto px-5 py-2.5"
            >
              <PenLine className="h-4 w-4" />
              {t.blankManuscript}
            </Button>
            <ImportManuscriptEntry
              variant="outline"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
