'use client';

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { useLanguage } from '@/components/LanguageProvider';

// Wave 3 commit 1: the manuscript route no longer hosts its own shell — the
// 4-tab IA inside /novel/[id] absorbs the manuscript view. This page is now
// a one-way redirect that preserves `?autostart=1` so the post-greenlight
// path keeps working. Anchor / chapter deep-link params (e.g. `?chapter=3`)
// also pass through.
export default function ManuscriptRedirectPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useLanguage();
  const novelId = params.id as string;

  useEffect(() => {
    const usp = new URLSearchParams();
    usp.set('view', 'manuscript');
    const autostart = searchParams?.get('autostart');
    if (autostart) usp.set('autostart', autostart);
    const chapter = searchParams?.get('chapter');
    if (chapter) usp.set('chapter', chapter);
    router.replace(`/novel/${novelId}?${usp.toString()}`);
  }, [novelId, router, searchParams]);

  return (
    <div className="flex flex-1 min-h-screen items-center justify-center book-texture-parchment font-serif text-xl text-book-ink-secondary">
      {t.loading || 'Loading'}
    </div>
  );
}
