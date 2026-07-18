import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('author and developer surface split', () => {
  it('hides prompt workflows and raw vault paths until developer tools are enabled', () => {
    const shell = source('components/DesktopShellLayout.tsx');
    const settings = source('components/SettingsPanel.tsx');
    const workflows = source('components/workflows/WorkflowStudioSurface.tsx');

    expect(shell).toContain("const [developerTools, setDeveloperTools]");
    expect(shell).toContain('{developerTools && (');
    expect(settings).toContain('hasNovelContext && settings.developerTools');
    expect(settings).toContain('activeNovelId && settings.developerTools');
    expect(workflows).toContain('if (!developerToolsEnabled) {');
    expect(workflows).toContain('{t.developerToolsWorkflowDescription}');
  });
});
