import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vitest artifact discovery guard', () => {
  it('never re-runs copied suites from packaged desktop output', () => {
    const config = readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf8');

    expect(config).toContain("'.next/**'");
    expect(config).toContain("'src-tauri/resources/**'");
    expect(config).toContain("'src-tauri/target/**'");
  });
});
