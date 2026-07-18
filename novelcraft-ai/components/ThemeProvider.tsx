'use client';
import { createContext, useContext, useState, useEffect } from 'react';
import { getSettings, saveSettings } from '@/lib/settings';
import { onAppSettingsHydrated } from '@/lib/app-settings-client';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'system',
  resolved: 'light',
  setTheme: () => {},
});

function readTheme(): Theme {
  return getSettings().theme;
}

function writeTheme(theme: Theme) {
  saveSettings({ theme });
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return getSystemTheme();
  return theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() =>
    typeof window === 'undefined' ? 'system' : readTheme()
  );
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    typeof window === 'undefined' ? 'light' : resolveTheme(readTheme())
  );

  // Desktop boot hydration swaps the settings cache from the (possibly empty,
  // port-changed) localStorage mirror to the SQLite-authoritative value. Re-read
  // the theme once it lands so a runtime-port change can't strand the user on
  // the default theme. No-op off-desktop (fires immediately, value unchanged).
  useEffect(() => onAppSettingsHydrated(() => setThemeState(readTheme())), []);

  // Apply dark class and listen for system theme changes
  useEffect(() => {
    const root = document.documentElement;
    const computed = resolveTheme(theme);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolved(computed);

    if (computed === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => {
        const next = e.matches ? 'dark' : 'light';
        setResolved(next);
        if (next === 'dark') {
          root.classList.add('dark');
        } else {
          root.classList.remove('dark');
        }
      };
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    writeTheme(t);
  };

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
