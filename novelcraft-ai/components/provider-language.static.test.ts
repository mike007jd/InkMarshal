import { describe, expect, it } from 'vitest';

import { en } from '@/lib/i18n/en';
import { zhCN } from '@/lib/i18n/zh-CN';
import { zhTW } from '@/lib/i18n/zh-TW';

describe('author-facing model connection language', () => {
  it.each([en, zhCN, zhTW])('does not present every online connection as a fallback', copy => {
    expect(copy.modelManagerProviderConnectionsDesc.toLowerCase()).not.toContain('fallback');
    expect(copy.modelManagerProviderConnectionsDesc).not.toMatch(/兜底|備援/);
    expect(copy.statusBarTagByok).toMatch(/Online AI|在线 AI|線上 AI/);
    expect(copy.capabilityFallback).toMatch(/Backup model|备用模型|備用模型/);
  });
});
