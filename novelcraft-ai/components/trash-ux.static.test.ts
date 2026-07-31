import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Trash UX', () => {
  it('moves ordinary removals directly to Trash and offers Undo', () => {
    const shell = source('components/DesktopShellLayout.tsx');
    expect(shell).not.toContain('DeleteNovelDialog');
    expect(shell).toContain('handleMoveToTrash(novel)');
    expect(shell).toContain('action: {');
    expect(shell).toContain('label: t.trashUndoAction');
    expect(shell).toContain("fetch(`/api/trash/${novel.id}/restore`, { method: 'POST' })");
  });

  it('invalidates library membership through one restore fan-out, without callback plumbing', () => {
    const storage = source('lib/use-storage.ts');
    const shell = source('components/DesktopShellLayout.tsx');
    const trash = source('components/TrashPanel.tsx');

    expect(storage).toContain("export const NOVEL_LIST_INVALIDATED_EVENT = 'inkmarshal:novel-list-invalidated'");
    expect(storage).toContain('export function notifyNovelListInvalidated()');
    expect(storage).toContain('window.addEventListener(NOVEL_LIST_INVALIDATED_EVENT, onListInvalidated)');
    expect(shell).toContain('notifyNovelListInvalidated()');
    expect(shell).toContain('onClick: () => { void restoreFromTrash(novel); }');
    expect(shell).not.toContain('onLibraryChange');
    expect(trash).toContain('notifyNovelListInvalidated()');
    expect(trash).not.toContain('onLibraryChange');
  });

  it('uses one confirmation for irreversible permanent deletion without title typing', () => {
    const trash = source('components/TrashPanel.tsx');
    expect(trash).toContain("fetch('/api/trash'");
    expect(trash).toContain("method: 'DELETE'");
    expect(trash).not.toContain('typed.trim()');
    expect(trash).not.toContain('trashDeleteTypeTitle');
    expect(trash).toContain("key={deleteTarget?.id ?? 'closed'}");
    expect(trash).toContain('trashDeleteConfirmDescription');
    expect(trash).toContain('disabled={busy}');
  });

  it('keeps local-library clearing available from Settings, not only error recovery', () => {
    const settings = source('components/SettingsPanel.tsx');
    const recovery = source('components/LocalLibraryRecovery.tsx');
    expect(settings).toContain('<LocalLibraryRecovery placement="settings" />');
    expect(settings).toContain('t.localDataSettingsTitle');
    expect(recovery).toContain("placement === 'settings'");
    expect(recovery).toContain('t.resetLocalLibrarySettingsAction');
    expect(recovery).toContain("? '/api/local-library/clear'");
    expect(recovery).toContain('t.clearLocalLibraryDescription');
  });

  it('restores sheet focus to a stable return target instead of a removed menu portal', () => {
    const trash = source('components/TrashPanel.tsx');
    const shell = source('components/DesktopShellLayout.tsx');
    expect(trash).toContain('returnFocusRef');
    expect(trash).toContain('fallbackFocusRef');
    expect(trash).toContain('onCloseAutoFocus={event => {');
    expect(trash).toContain('event.preventDefault()');
    expect(trash).toContain('focusTarget.focus({ preventScroll: true })');
    expect(shell).toContain('ref={moreToolsTriggerRef}');
    expect(shell).toContain('returnFocusRef={moreToolsTriggerRef}');
    expect(shell).toContain('fallbackFocusRef={mobileNavOpenButtonRef}');
    expect(shell).toContain('if (showSettings || showTrash) return;');
  });

  it('shows an inline Retry instead of misreporting a failed Trash load as empty', () => {
    const trash = source('components/TrashPanel.tsx');
    expect(trash).toContain('const [loadError, setLoadError] = useState(false)');
    expect(trash).toContain('const [retryToken, setRetryToken] = useState(0)');
    expect(trash).toContain('loadError ? (');
    expect(trash).toContain('setRetryToken(value => value + 1)');
  });
});
