import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ConversationThread Stop retry contract', () => {
  it('persists the stable Stop marker for conversation streams', () => {
    const source = readFileSync(
      join(process.cwd(), 'components/conversations/ConversationThread.tsx'),
      'utf8',
    );

    expect(source).toContain('stoppedPersistenceLabel');
    expect(source).toContain('stoppedLabel: stoppedPersistenceLabel(locale)');
    expect(source).toContain('composerSendDisabled={recovering}');
  });
});
