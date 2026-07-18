'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useLanguage();

  useEffect(() => {
    console.error('App route error:', error);
  }, [error]);

  return (
    <main className="flex h-screen w-full items-center justify-center bg-book-bg-primary p-8">
      <section className="max-w-md space-y-4 text-center" role="alert">
        <AlertTriangle className="mx-auto h-10 w-10 text-book-warning" aria-hidden />
        <h1 className="font-serif text-xl font-semibold text-book-ink-primary">
          {t.appErrorTitle}
        </h1>
        <p className="text-sm leading-relaxed text-book-ink-muted">
          {t.appErrorDescription}
        </p>
        {process.env.NODE_ENV !== 'production' && error.message ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-book-bg-secondary p-3 text-left text-xs text-book-ink-muted">
            {error.message}
          </pre>
        ) : null}
        <div className="flex items-center justify-center gap-2">
          <Button type="button" variant="ink" onClick={reset}>
            {t.appErrorTryAgain}
          </Button>
          <Button type="button" variant="ghost" onClick={() => window.location.reload()}>
            {t.appErrorReload}
          </Button>
        </div>
      </section>
    </main>
  );
}
