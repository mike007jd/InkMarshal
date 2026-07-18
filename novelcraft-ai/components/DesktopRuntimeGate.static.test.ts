import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('desktop runtime gate', () => {
  it('does not mount desktop workspace chrome until the Tauri runtime is present', () => {
    const gate = source('components/DesktopRuntimeGate.tsx');
    const desktopLayout = source('app/desktop-studio/layout.tsx');
    const novelLayout = source('app/novel/[id]/layout.tsx');

    expect(gate).toContain("type DesktopRuntimeState = 'checking' | 'desktop' | 'web'");
    expect(gate).toContain("return isTauriRuntime() ? 'desktop' : 'web'");
    expect(gate).toContain('useSyncExternalStore(subscribeRuntimeStore, getClientRuntime, getServerRuntime)');
    expect(gate).toContain("if (runtime === 'desktop') return <>{children}</>;");
    expect(gate).toContain('href="/download"');
    expect(desktopLayout).toContain('<DesktopRuntimeGate>');
    expect(desktopLayout).toContain('<DesktopShell>{children}</DesktopShell>');
    expect(novelLayout).toContain('<DesktopRuntimeGate>');
    expect(novelLayout).toContain('<DesktopShell>{children}</DesktopShell>');
  });
});
