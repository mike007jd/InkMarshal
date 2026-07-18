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
});
