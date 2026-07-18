'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Download, MonitorDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { InkMarshalLogo } from '@/components/Icons';
import { useLanguage } from '@/components/LanguageProvider';
import { isTauriRuntime } from '@/lib/desktop-runtime';

type DesktopRuntimeState = 'checking' | 'desktop' | 'web';

interface DesktopRuntimeGateProps {
  children: React.ReactNode;
}

function subscribeRuntimeStore() {
  return () => {};
}

function getClientRuntime(): DesktopRuntimeState {
  return isTauriRuntime() ? 'desktop' : 'web';
}

function getServerRuntime(): DesktopRuntimeState {
  return 'checking';
}

export function DesktopRuntimeGate({ children }: DesktopRuntimeGateProps) {
  const { t } = useLanguage();
  const runtime = useSyncExternalStore(subscribeRuntimeStore, getClientRuntime, getServerRuntime);

  if (runtime === 'desktop') return <>{children}</>;

  const checking = runtime === 'checking';

  return (
    <main className="flex min-h-screen items-center justify-center bg-book-bg-primary px-6 py-12 text-book-ink-primary">
      <section className="w-full max-w-[520px] text-center">
        <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-md border border-book-border bg-book-bg-card text-book-gold shadow-sm">
          {checking ? (
            <InkMarshalLogo className="h-7 w-7" />
          ) : (
            <MonitorDown className="h-6 w-6" aria-hidden="true" />
          )}
        </div>
        <p className="mb-3 font-serif text-3xl font-semibold text-book-ink-primary">
          {checking ? t.desktopGateCheckingTitle : t.desktopGateTitle}
        </p>
        <p className="mx-auto max-w-[420px] text-sm leading-6 text-book-ink-secondary">
          {checking ? t.desktopGateCheckingDescription : t.desktopGateDescription}
        </p>
        {!checking && (
          <div className="mt-8 flex justify-center">
            <Button asChild variant="ink">
              <Link href="/download">
                <Download className="h-4 w-4" aria-hidden="true" />
                {t.desktopGateDownload}
              </Link>
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
