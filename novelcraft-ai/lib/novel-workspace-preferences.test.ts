import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  raw: null as string | null,
  hydrationListeners: new Set<() => void>(),
}));
const runtime = vi.hoisted(() => ({ tauri: false }));

vi.mock('@/lib/app-settings-client', () => ({
  getStoredSetting: () => settings.raw,
  setStoredSetting: (_key: string, value: string) => {
    settings.raw = value;
  },
  onAppSettingsHydrated: (listener: () => void) => {
    settings.hydrationListeners.add(listener);
    return () => settings.hydrationListeners.delete(listener);
  },
}));
vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => runtime.tauri,
}));

import {
  parseNovelWorkspaceViews,
  readRememberedNovelWorkspaceView,
  rememberNovelWorkspaceView,
  rememberNovelWorkspaceViewAfterHydration,
  subscribeNovelWorkspaceViews,
} from '@/lib/novel-workspace-preferences';

describe('novel workspace preferences', () => {
  beforeEach(() => {
    settings.raw = null;
    settings.hydrationListeners.clear();
    runtime.tauri = false;
  });

  it('normalizes durable values and rejects corrupt entries', () => {
    expect(parseNovelWorkspaceViews(JSON.stringify({
      n1: 'story-deck',
      n2: 'manuscript',
      n3: 'unknown',
      n4: 7,
    }))).toEqual({ n1: 'story-deck' });
    expect(parseNovelWorkspaceViews('{bad json')).toEqual({});
    expect(parseNovelWorkspaceViews(null)).toEqual({});
  });

  it('stores independent canonical modes for each novel', () => {
    rememberNovelWorkspaceView('n1', 'story-deck');
    rememberNovelWorkspaceView('n2', 'read-edit');

    expect(readRememberedNovelWorkspaceView('n1')).toBe('story-deck');
    expect(readRememberedNovelWorkspaceView('n2')).toBe('read-edit');
    expect(readRememberedNovelWorkspaceView('missing')).toBeNull();
  });

  it('notifies subscribers for local writes and SQLite hydration', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNovelWorkspaceViews(listener);

    rememberNovelWorkspaceView('n1', 'agent');
    for (const hydrated of settings.hydrationListeners) hydrated();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    rememberNovelWorkspaceView('n1', 'read-edit');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('defers initial desktop route state until SQLite hydration', () => {
    runtime.tauri = true;
    const unsubscribe = rememberNovelWorkspaceViewAfterHydration('n1', 'read-edit');
    expect(settings.raw).toBeNull();

    for (const hydrated of settings.hydrationListeners) hydrated();
    expect(readRememberedNovelWorkspaceView('n1')).toBe('read-edit');
    unsubscribe();
  });
});
