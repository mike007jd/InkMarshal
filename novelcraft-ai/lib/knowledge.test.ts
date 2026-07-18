import { describe, expect, it } from 'vitest';

import { buildKnowledgeEntrySummary } from '@/lib/knowledge';

describe('knowledge summaries', () => {
  it('builds a default character summary for AI context injection', () => {
    const summary = buildKnowledgeEntrySummary('character', {
      role: 'protagonist',
      description: '退休刑警，沉默寡言但观察力极强',
      motivation: '找出十年前案件的真相',
      arc: '从逃避过去到主动面对责任',
    });

    expect(summary).toContain('退休刑警');
    expect(summary).toContain('找出十年前案件的真相');
  });
});
