import type {Metadata} from 'next';
import { Inter, Noto_Serif_SC, Caveat } from 'next/font/google';
import { LanguageProvider } from '@/components/LanguageProvider';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ManuscriptStyleApplier } from '@/components/ManuscriptStyleApplier';
import { ToastProvider } from '@/components/Toast';
import { GlobalSearchProvider } from '@/components/search/GlobalSearchProvider';
import { getDefaultTranslations } from '@/lib/i18n/server';
import {
  localeInitScriptContent,
  manuscriptInitScriptContent,
  themeInitScriptContent,
} from '@/lib/browser-init-scripts';
import './globals.css';

const themeInitScript = {
  __html: themeInitScriptContent,
};

const localeInitScript = {
  __html: localeInitScriptContent,
};

const manuscriptInitScript = {
  __html: manuscriptInitScriptContent,
};

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const notoSerifSC = Noto_Serif_SC({
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  variable: '--font-serif',
});

const caveat = Caveat({
  subsets: ['latin'],
  variable: '--font-hand',
});

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDefaultTranslations();
  return {
    title: t.seoSiteTitle,
    description: t.seoSiteDescription,
  };
}

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${inter.variable} ${notoSerifSC.variable} ${caveat.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={themeInitScript} />
        <script dangerouslySetInnerHTML={localeInitScript} />
        <script dangerouslySetInnerHTML={manuscriptInitScript} />
      </head>
      <body className="font-sans antialiased book-texture-parchment text-book-ink-primary" suppressHydrationWarning>
        <ThemeProvider>
          <LanguageProvider>
            <ManuscriptStyleApplier />
            <ToastProvider>
              <GlobalSearchProvider>
                <ErrorBoundary>
                  {children}
                </ErrorBoundary>
              </GlobalSearchProvider>
            </ToastProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
