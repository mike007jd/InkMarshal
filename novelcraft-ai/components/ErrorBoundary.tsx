'use client';

import React, { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

type Lang = 'zh-CN' | 'zh-TW' | 'en';

/**
 * Resolves the active language for the boundary's own labels. The render path
 * runs OUTSIDE the React tree (we cannot call hooks), so we read the same
 * sources the LanguageProvider writes:
 *   1. cookie `locale` (server + client wrote it via LanguageProvider)
 *   2. localStorage `inkmarshal_settings.locale` (deeplinks, legacy)
 *   3. navigator.language
 * Anything else falls back to English.
 */
function getLanguage(): Lang {
  try {
    if (typeof document !== 'undefined') {
      const m = document.cookie.match(/(?:^|; )locale=([^;]*)/);
      if (m) {
        const v = decodeURIComponent(m[1]);
        if (v === 'zh-TW' || v === 'zh-Hant' || v === 'zh-HK') return 'zh-TW';
        if (v === 'zh-CN' || v === 'zh-Hans' || v === 'zh') return 'zh-CN';
        if (v === 'en') return 'en';
      }
    }
  } catch {}
  try {
    const raw = localStorage.getItem('inkmarshal_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { locale?: string };
      const v = parsed?.locale;
      if (v === 'zh-TW') return 'zh-TW';
      if (v === 'zh-CN' || v === 'zh') return 'zh-CN';
      if (v === 'en') return 'en';
    }
  } catch {}
  try {
    if (typeof navigator !== 'undefined') {
      const lang = navigator.language;
      if (lang === 'zh-TW' || lang === 'zh-HK' || lang.startsWith('zh-Hant')) return 'zh-TW';
      if (lang.startsWith('zh')) return 'zh-CN';
    }
  } catch {}
  return 'en';
}

const errorTexts: Record<Lang, { title: string; desc: string; tryAgain: string; reload: string }> = {
  'zh-CN': { title: '出了点问题', desc: '发生了意外错误。', tryAgain: '重试', reload: '重新加载' },
  'zh-TW': { title: '出了一點問題', desc: '發生了意外錯誤。', tryAgain: '重試', reload: '重新載入' },
  'en': { title: 'Something went wrong', desc: 'An unexpected error occurred.', tryAgain: 'Try again', reload: 'Reload Page' },
};

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const t = errorTexts[getLanguage()];

      return (
        <div className="flex h-screen w-full items-center justify-center bg-book-bg-primary p-8">
          <div className="max-w-md text-center space-y-4">
            <AlertTriangle className="mx-auto h-10 w-10 text-book-warning" aria-hidden />
            <h2 className="text-xl font-serif font-semibold text-book-ink-primary">
              {t.title}
            </h2>
            <p className="text-sm text-book-ink-muted leading-relaxed">
              {t.desc}
            </p>
            {process.env.NODE_ENV !== 'production' && this.state.error?.message ? (
              <pre className="text-xs text-left text-book-ink-muted bg-book-bg-secondary rounded-md p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                {this.state.error.message}
              </pre>
            ) : null}
            <div className="flex items-center justify-center gap-2">
              {/* Try resetting the boundary first so unsaved in-memory editor
                  state survives a transient render error; full reload is the
                  fallback. */}
              <Button
                variant="ink"
                onClick={() => this.setState({ hasError: false, error: null })}
                className="h-auto px-5 py-2.5 text-sm font-medium transition-colors"
              >
                {t.tryAgain}
              </Button>
              <Button
                variant="ghost"
                onClick={() => window.location.reload()}
                className="h-auto border border-book-border px-5 py-2.5 text-sm font-medium text-book-ink-secondary transition-colors"
              >
                {t.reload}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
