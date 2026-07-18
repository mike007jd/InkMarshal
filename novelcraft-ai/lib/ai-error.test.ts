import { describe, expect, it } from 'vitest';

import { en } from '@/lib/i18n/en';
import { zhCN } from '@/lib/i18n/zh-CN';
import { zhTW } from '@/lib/i18n/zh-TW';
import {
  AIUsageError,
  classifyAIError,
  localizedAIErrorMessage,
  parseAIErrorMessage,
  serializeAIError,
} from '@/lib/ai-error';

describe('AI error taxonomy', () => {
  it.each([
    [{ statusCode: 401, message: 'invalid_api_key' }, 'invalid_credentials', 'aiErrorInvalidCredentials'],
    [{ status: 429, responseBody: '{"error":"rate_limit_exceeded"}' }, 'quota_or_balance', 'aiErrorQuotaOrBalance'],
    [{ message: 'fetch failed', cause: { code: 'ENETUNREACH' } }, 'network', 'aiErrorNetwork'],
    [{ message: 'Local engine missing: llama-server not found' }, 'local_engine', 'aiErrorLocalEngine'],
    [new Error('unrecognized provider failure'), 'unknown', 'aiErrorUnknown'],
  ] as const)('classifies %o as %s with %s', (error, category, i18nKey) => {
    expect(classifyAIError(error)).toMatchObject({ category, i18nKey });
  });

  it('prefers local engine recovery for a refused loopback connection', () => {
    expect(classifyAIError({
      message: 'fetch failed http://127.0.0.1:11434/v1',
      cause: { code: 'ECONNREFUSED' },
    }).category).toBe('local_engine');
  });

  it('preserves an explicit AIUsageError category and status', () => {
    expect(classifyAIError(new AIUsageError('missing key', 400, 'invalid_credentials'))).toMatchObject({
      category: 'invalid_credentials',
      i18nKey: 'aiErrorInvalidCredentials',
      status: 400,
    });
  });

  it('round-trips a structured stream error without raw provider text', () => {
    const serialized = serializeAIError({ statusCode: 401, message: 'secret provider detail' });
    expect(serialized).not.toContain('secret provider detail');
    expect(parseAIErrorMessage(serialized)).toMatchObject({
      category: 'invalid_credentials',
      i18nKey: 'aiErrorInvalidCredentials',
      status: 401,
    });
  });

  it('maps the same structured error to complete three-language guidance', () => {
    const payload = classifyAIError({ status: 429 });
    expect(localizedAIErrorMessage(payload, en)).toBe(en.aiErrorQuotaOrBalance);
    expect(localizedAIErrorMessage(payload, zhCN)).toBe(zhCN.aiErrorQuotaOrBalance);
    expect(localizedAIErrorMessage(payload, zhTW)).toBe(zhTW.aiErrorQuotaOrBalance);
    expect(new Set([
      localizedAIErrorMessage(payload, en),
      localizedAIErrorMessage(payload, zhCN),
      localizedAIErrorMessage(payload, zhTW),
    ])).toHaveLength(3);
  });
});
