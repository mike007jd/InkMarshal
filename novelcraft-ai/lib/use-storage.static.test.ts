import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('useNovel active-scope guards', () => {
  it('guards refresh and update results against stale novel ids', () => {
    const storage = source('lib/use-storage.ts');

    expect(storage).toContain('const activeNovelIdRef = useRef(novelId)');
    expect(storage).toContain('const refreshSeqRef = useRef(0)');
    expect(storage).toContain('const updateSeqByNovelRef = useRef(new Map<string, number>())');
    expect(storage).toContain('activeNovelIdRef.current === requestNovelId');
    expect(storage).toContain('refreshSeqRef.current === seq');
    expect(storage).toContain('isLatestForNovel()');
  });

  it('fans out successful novel updates to same-document list subscribers', () => {
    const storage = source('lib/use-storage.ts');

    expect(storage).toContain("export const NOVEL_UPDATED_EVENT = 'inkmarshal:novel-updated'");
    expect(storage).toContain("export const NOVEL_LIST_INVALIDATED_EVENT = 'inkmarshal:novel-list-invalidated'");
    expect(storage).toContain('notifyNovelUpdated(updated)');
    expect(storage).toContain('applyNovelUpdatedToList');
    expect(storage).toContain('window.addEventListener(NOVEL_UPDATED_EVENT, onNovelUpdated)');
    expect(storage).toContain('const refreshSeqRef = useRef(0)');
    expect(storage).toContain('const pendingUpdatesRef = useRef(');
    expect(storage).toContain('refreshSeqRef.current !== seq');
    expect(storage).toContain('pendingUpdatesRef.current.set(novel.id');
    expect(storage).toContain('right.updatedAt - left.updatedAt');
  });

  it('keeps project loading failures distinct from a genuinely empty desk', () => {
    const storage = source('lib/use-storage.ts');
    const shell = source('components/DesktopShellLayout.tsx');
    const studio = source('components/DesktopStudioShell.tsx');
    const recovery = source('components/LocalLibraryRecovery.tsx');
    const resetRoute = source('app/api/local-library/reset/route.ts');

    expect(storage).toContain('const [error, setError] = useState<Error | null>(null)');
    expect(storage).toContain('const [databaseIssue, setDatabaseIssue] = useState<LocalDatabaseIssueCode | null>(null)');
    expect(storage).toContain('return { novels, loading, error, databaseIssue, refresh, create, remove }');
    expect(storage).toContain('return { novel, loading, error, databaseIssue, refresh, update }');
    expect(shell).toContain('!novelsLoading && databaseIssueCopy && novels.length === 0');
    expect(shell).toContain('!novelsLoading && !databaseIssueCopy && novelsError && novels.length === 0');
    expect(shell).toContain('!novelsLoading && !databaseIssueCopy && !novelsError && novels.length === 0');
    expect(studio).toContain('localDatabaseIssueCopy');
    expect(studio).toContain('result.databaseIssue');
    expect(studio).toContain('setCreateIssue(result.databaseIssue)');
    expect(studio).toContain('const handleRetry = async () =>');
    expect(studio).toContain('setCreateIssue(null)');
    expect(studio).toContain('disabled={Boolean(activeIssue)}');
    expect(shell).toContain('{t.toastRetry}');
    expect(studio).toContain('<LocalLibraryRecovery');
    expect(recovery).toContain("? '/api/local-library/clear'");
    expect(recovery).toContain(": '/api/local-library/reset'");
    expect(source('components/NovelWorkspace.tsx')).toContain('<LocalLibraryRecovery />');
    expect(recovery).toContain('<Dialog');
    expect(recovery).toContain('t.resetLocalLibraryConfirm');
    expect(resetRoute).toContain('await requireLocalUser()');
    expect(resetRoute).toContain('resetLocalLibrary()');
    expect(shell).not.toContain('{databaseIssueCopy.body}');
    expect(shell).not.toContain('useEffect(() => {\n    refresh();\n  }, [refresh]);');
    expect(studio).not.toContain('useEffect(() => {\n    refresh();\n  }, [refresh]);');
  });

  it('prevents duplicate title saves from Enter plus blur', () => {
    const workspace = source('components/NovelWorkspace.tsx');

    expect(workspace).toContain('const titleSavingRef = useRef(false)');
    expect(workspace).toContain('if (titleSavingRef.current) return');
    expect(workspace).toContain('titleSavingRef.current = true');
  });
});
