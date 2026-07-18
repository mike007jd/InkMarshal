import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('desktop shell and provider mutation concurrency guards', () => {
  it('keeps desktop body locking and global shortcuts inside the desktop shell', () => {
    const rootLayout = source('app/layout.tsx');
    const shell = source('components/DesktopShellLayout.tsx');
    const hotkeys = source('hooks/useGlobalHotkeys.ts');

    expect(rootLayout).not.toContain('h-screen overflow-hidden flex');
    expect(shell).toContain('useGlobalHotkeys(handleMenuAction, { enabled: isTauriRuntime() })');
    expect(shell).toContain('className="flex h-screen min-h-0 w-full overflow-hidden"');
    expect(hotkeys).toContain('interface UseGlobalHotkeysOptions');
    expect(hotkeys).toContain('enabled,');
  });

  it('guards create and delete actions before React busy state can commit', () => {
    const shell = source('components/DesktopShellLayout.tsx');
    const studio = source('components/DesktopStudioShell.tsx');
    const deleteDialog = source('components/DeleteNovelDialog.tsx');

    expect(shell).toContain('const deletingNovelIdsRef = useRef<Set<string>>(new Set())');
    expect(shell).toContain('deletingNovelIdsRef.current.add(id)');
    expect(studio).toContain('const creatingRef = useRef(false)');
    expect(studio).toContain('if (creatingRef.current) return');
    expect(deleteDialog).toContain('const confirmingRef = useRef(false)');
    expect(deleteDialog).toContain('if (confirmingRef.current) return');
  });

  it('guards provider save and remove actions synchronously', () => {
    const provider = source('components/ProviderConnectionsPanel.tsx');

    expect(provider).toContain('const savingRef = useRef(false)');
    expect(provider).toContain('if (savingRef.current) return');
    expect(provider).toContain('savingRef.current = true');
    expect(provider).toContain('const removingRef = useRef(false)');
    expect(provider).toContain('if (!removeTarget || removingRef.current) return');
    expect(provider).toContain('removingRef.current = true');
  });

  it('treats keychain read failures as unavailable, not missing', () => {
    const provider = source('components/ProviderConnectionsPanel.tsx');

    expect(provider).toContain("type KeyPresenceState = 'present' | 'missing' | 'unavailable'");
    expect(provider).toContain("return [conn.id, 'unavailable'] as const");
    expect(provider).toContain('let keyReadUnavailable = false');
    expect(provider).toContain('keyReadUnavailable = Boolean(conn.secretRef)');
    expect(provider).toContain('setFormError(keyReadUnavailable ? t.modelManagerKeyReadFailed : null)');
    expect(provider).not.toContain('setFormError(hadKey ? t.modelManagerKeyReadFailed : null)');
    expect(provider).toContain('setTestResult({ ok: false, message: t.modelManagerKeyReadFailed })');
    expect(provider).not.toContain('getConnectionSecret(draft.id).catch(() => null)');
  });

  it('aborts and scope-checks active-novel bundle exports', () => {
    const workspace = source('components/NovelWorkspace.tsx');

    expect(workspace).toContain('const activeNovelIdRef = useRef(novelId)');
    expect(workspace).toContain('const bundleAbortRef = useRef<AbortController | null>(null)');
    expect(workspace).toContain('bundleAbortRef.current?.abort();');
    expect(workspace).toContain('const requestNovelId = novelId');
    expect(workspace).toContain('signal: controller.signal');
    expect(workspace).toContain('if (activeNovelIdRef.current !== requestNovelId) return;');
    expect(workspace).toContain('if (controller.signal.aborted || activeNovelIdRef.current !== requestNovelId) return;');
  });

  it('keeps fallback runtime selection UI-only until a model is available', () => {
    const capability = source('components/CapabilityBindingPanel.tsx');

    expect(capability).toContain('const [pendingFallbackConnection, setPendingFallbackConnection]');
    expect(capability).toContain('const fallbackModelId = fModels.map(m => m.trim()).find(Boolean);');
    expect(capability).toContain('setPendingFallbackConnection(prev => ({ ...prev, [role]: v }));');
    expect(capability).toContain('selectedFallbackConnectionId !== NONE');
    expect(capability).not.toContain("fallback: { connectionId: v, modelId: fModels[0] ?? '' }");
  });
});
