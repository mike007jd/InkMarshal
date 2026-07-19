import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('backup settings surface', () => {
  it('saves pending editor state before export and restores only through verification', () => {
    const source = readFileSync(join(process.cwd(), 'components', 'BackupSettings.tsx'), 'utf8');
    expect(source).toContain('await requestManuscriptFlush()');
    expect(source).toContain("fetch(`/api/novels/${novelId}/backup`");
    expect(source).toContain("fetch('/api/novels')");
    expect(source).toContain('await verifyBackupPackage(backupBytes)');
    expect(source).toContain('buildLibraryBackupPackage(items)');
    expect(source).toContain("`InkMarshal-library-${date}.zip`");
    expect(source).toContain("readLocalFile(['inkmarshal'])");
    expect(source).toContain("fetch('/api/backups/restore'");
    expect(source).toContain('router.push(`/novel/${restored.novelId}?view=read-edit`)');
  });
});
