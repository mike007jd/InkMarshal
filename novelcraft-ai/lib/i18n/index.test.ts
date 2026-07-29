import { describe, expect, it } from 'vitest';

import { joinLocalizedDisplayList } from '@/lib/i18n';

describe('joinLocalizedDisplayList', () => {
  it('uses locale-appropriate punctuation for compact visible lists', () => {
    const items = ['起草', '改写', '规划'];

    expect(joinLocalizedDisplayList(items, 'en')).toBe('起草, 改写, 规划');
    expect(joinLocalizedDisplayList(items, 'zh-CN')).toBe('起草、改写、规划');
    expect(joinLocalizedDisplayList(items, 'zh-TW')).toBe('起草、改写、规划');
  });
});
