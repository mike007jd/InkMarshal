import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-string contract guards. ManuscriptEditingView's AI-assist logic was
// split into hooks (Phase 4.1); these assertions follow the code into its hook
// homes so the abort + stream-scope invariants can't silently regress.
const readHook = (name: string) => readFileSync(join(process.cwd(), 'hooks', name), 'utf8');

describe('Manuscript AI edit scope guards', () => {
  it('aborts and scope-checks continue/rewrite responses before showing diff changes', () => {
    const source = readHook('useManuscriptGeneration.ts');

    expect(source).toContain('const singleTextAbortRef = useRef<AbortController | null>(null);');
    expect(source).toContain('signal?: AbortSignal');
    expect(source).toContain("fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })");
    expect(source).toContain('singleTextAbortRef.current?.abort();');
    expect(source).toContain("if (error instanceof DOMException && error.name === 'AbortError') return;");

    const scopeGuardCount = source.match(/if \(!isCurrentEditingScope\(requestScope\)\) return;/g)?.length ?? 0;
    expect(scopeGuardCount).toBeGreaterThanOrEqual(4);
  });

  it('scope-checks full edit-chat stream events before mutating diff or chat state', () => {
    const source = readHook('useAIEditChat.ts');
    const handleSendStart = source.indexOf('const handleSend = useCallback(async (instruction: string) => {');
    const handleStopStart = source.indexOf('const handleStopEdit = useCallback', handleSendStart);
    const handleSendSource = source.slice(handleSendStart, handleStopStart);

    expect(handleSendSource).toContain('const requestScope = {');
    expect(handleSendSource).toContain('chapterId: chapter.id,');
    expect(handleSendSource).toContain('if (!isCurrentEditingScope(requestScope)) return;');
    expect(handleSendSource).toContain('if (isCurrentEditingScope(requestScope)) setChanges([...changesRef.current]);');
    expect(handleSendSource).toContain('if (editAbortRef.current === abort) editAbortRef.current = null;');
    expect(handleSendSource).toContain('if (isCurrentEditingScope(requestScope)) {');
  });

  it('forwards the selected style id through freeform edit-chat headers', () => {
    const source = readHook('useAIEditChat.ts');
    const handleSendStart = source.indexOf('const handleSend = useCallback(async (instruction: string) => {');
    const handleStopStart = source.indexOf('const handleStopEdit = useCallback', handleSendStart);
    const handleSendSource = source.slice(handleSendStart, handleStopStart);

    expect(handleSendSource).toContain("'polish',\n          { creativity, styleId: styleId ?? undefined },\n          { signal: abort.signal },");
    expect(handleSendSource).toContain('[chapter, storageReady, creativity, styleId, novelId');
  });
});
