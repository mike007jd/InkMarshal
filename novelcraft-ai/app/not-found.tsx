'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpen, Home } from 'lucide-react';
import { InkMarshalLogo } from '@/components/Icons';
import { useLanguage } from '@/components/LanguageProvider';
import { isTauriRuntime } from '@/lib/desktop-runtime';
import { FOCUS_RING } from '@/lib/utils';

export default function NotFound() {
  const { t } = useLanguage();
  // SSR defaults to "/"; after hydration the desktop runtime swaps to
  // /desktop-studio so a 404 inside Tauri never dead-ends outside the Studio.
  const [homeHref, setHomeHref] = useState('/');
  useEffect(() => {
    // Tauri runtime is only detectable client-side; reconcile after mount to
    // keep SSR/hydration matching the web "/" default.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isTauriRuntime()) setHomeHref('/desktop-studio');
  }, []);

  return (
    <div className="relative flex-1 flex items-center justify-center min-h-screen book-texture-parchment overflow-auto">
      {/* Decorative background quill marks */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 border border-book-gold/5 rounded-full" />
        <div className="absolute bottom-1/4 right-1/4 w-48 h-48 border border-book-gold/5 rounded-full" />
      </div>

      <div className="relative text-center px-6 max-w-lg">
        {/* Logo */}
        <Link href={homeHref} className={`inline-block mb-8 ${FOCUS_RING}`}>
          <InkMarshalLogo className="h-12 w-12 text-book-gold opacity-70" />
        </Link>

        {/* 404 number */}
        <div className="font-serif text-[8rem] leading-none font-bold text-book-gold/15 select-none">
          404
        </div>

        {/* Title */}
        <h1 className="mt-[-1rem] font-serif text-2xl md:text-3xl text-book-ink-primary">
          {t.notFoundTitle}
        </h1>

        {/* Hint */}
        <p className="mt-3 text-sm text-book-ink-muted">
          {t.notFoundHint}
        </p>

        {/* Quote */}
        <p className="mt-6 font-serif italic text-sm text-book-ink-secondary border-l-2 border-book-gold/30 pl-4 text-left">
          {t.notFoundQuote}
        </p>

        {/* Decorative divider */}
        <div className="mt-8 flex items-center gap-3">
          <div className="flex-1 h-px bg-book-border" />
          <BookOpen className="w-4 h-4 text-book-gold" />
          <div className="flex-1 h-px bg-book-border" />
        </div>

        {/* Action buttons */}
        <div className="mt-8 flex items-center justify-center">
          <Link
            href={homeHref}
            className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-book-gold text-book-on-gold text-sm font-medium hover:bg-book-gold-dark transition-colors ${FOCUS_RING}`}
          >
            <Home className="w-4 h-4" />
            {t.notFoundBackHome}
          </Link>
        </div>
      </div>
    </div>
  );
}
