'use client';

import { useEffect } from 'react';

import { useLanguage } from '@/components/LanguageProvider';
import { applySettingsToDocument, getSettings } from '@/lib/settings';

const SETTINGS_KEY = 'inkmarshal_settings';

/**
 * Applies the manuscript-prose CSS variables (font size, line height,
 * paragraph indent + spacing) to `<html>` whenever the locale or persisted
 * settings change. Pairs with the inline blocking script in `app/layout.tsx`
 * that sets initial values before first paint — this component handles the
 * reactive path (settings panel saves, locale swap) without a reload.
 *
 * Returns null; mounts as a transparent helper.
 */
export function ManuscriptStyleApplier() {
  const { locale } = useLanguage();

  // Apply on mount + whenever locale changes.
  useEffect(() => {
    applySettingsToDocument(getSettings(), locale);
  }, [locale]);

  // Apply whenever settings change in another tab / component.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === SETTINGS_KEY) {
        applySettingsToDocument(getSettings(), locale);
      }
    };
    const localHandler = () => {
      applySettingsToDocument(getSettings(), locale);
    };
    window.addEventListener('storage', handler);
    window.addEventListener('inkmarshal:settings-changed', localHandler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener('inkmarshal:settings-changed', localHandler);
    };
  }, [locale]);

  return null;
}
