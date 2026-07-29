import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Trash UX', () => {
  it('uses a reversible lightweight confirmation for ordinary removal', () => {
    const dialog = source('components/DeleteNovelDialog.tsx');
    expect(dialog).toContain('moveToTrashTitle');
    expect(dialog).toContain('moveToTrashDescription');
    expect(dialog).not.toContain('deleteNovelTypeTitlePrompt');
  });

  it('requires the exact title only for irreversible permanent deletion', () => {
    const trash = source('components/TrashPanel.tsx');
    expect(trash).toContain("fetch('/api/trash'");
    expect(trash).toContain("method: 'DELETE'");
    expect(trash).toContain("typed.trim() === novel.title.trim()");
    expect(trash).toContain("key={deleteTarget?.id ?? 'closed'}");
    expect(trash).toContain('trashDeleteConfirmDescription');
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
});
