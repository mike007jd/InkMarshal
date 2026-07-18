import { describe, expect, it } from 'vitest';

import {
  PROVIDER_PRESETS,
  PROVIDER_PRESETS_LAST_VERIFIED_AT,
  getProviderDefaultModel,
  getRecommendedProviderModels,
  isProviderPresetStale,
  providerDisplayName,
  providerModelsNeedingRefresh,
} from './providers';
import { en } from '@/lib/i18n/en';
import { zhCN } from '@/lib/i18n/zh-CN';
import { zhTW } from '@/lib/i18n/zh-TW';

describe('PROVIDER_PRESETS freshness', () => {
  it('localizes every provider name without mixed-language catalog labels', () => {
    const names = Object.fromEntries(PROVIDER_PRESETS.map(preset => [preset.id, {
      en: providerDisplayName(preset, en),
      zhCN: providerDisplayName(preset, zhCN),
      zhTW: providerDisplayName(preset, zhTW),
    }]));

    expect(names.dashscope).toEqual({
      en: 'Alibaba Cloud Model Studio (Qwen)',
      zhCN: '阿里云百炼（通义千问）',
      zhTW: '阿里雲百鍊（通義千問）',
    });
    expect(names.volcengine).toEqual({
      en: 'Volcano Engine (Doubao)',
      zhCN: '火山引擎（豆包）',
      zhTW: '火山引擎（豆包）',
    });
    expect(PROVIDER_PRESETS.every(preset => preset.nameKey.startsWith('providerName'))).toBe(true);
  });

  it('requires source-backed freshness metadata for every provider and model', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(preset.sourceUrls.length).toBeGreaterThan(0);
      for (const url of preset.sourceUrls) expect(url).toMatch(/^https:\/\//);

      for (const model of preset.models) {
        const meta = preset.modelMetadata[model];
        expect(meta, `${preset.id}/${model}`).toBeDefined();
        expect(meta.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Date.parse(`${meta.lastVerifiedAt}T00:00:00.000Z`)).toBeLessThanOrEqual(
          Date.parse(`${preset.lastVerifiedAt}T00:00:00.000Z`),
        );
        expect(meta.sourceUrls.length).toBeGreaterThan(0);
      }
    }
  });

  it('does not default to compatibility, legacy, or deprecated provider models', () => {
    for (const preset of PROVIDER_PRESETS) {
      const defaultModel = getProviderDefaultModel(preset);
      if (!defaultModel) continue;
      expect(preset.modelMetadata[defaultModel]?.status).toBe('recommended');
    }
  });

  it('keeps at least one recommended model for every non-empty provider preset', () => {
    for (const preset of PROVIDER_PRESETS.filter(p => p.models.length > 0)) {
      expect(getRecommendedProviderModels(preset).length, preset.id).toBeGreaterThan(0);
    }
  });

  it('keeps known discontinued aliases out of active defaults', () => {
    const flattened = PROVIDER_PRESETS.flatMap(p =>
      p.models.map(model => ({ preset: p, model, meta: p.modelMetadata[model] })),
    );
    for (const item of flattened.filter(x => x.meta?.sunsetAt || x.meta?.status === 'legacy')) {
      expect(item.preset.defaultModel).not.toBe(item.model);
    }
  });

  it('keeps retired provider aliases out of active model lists', () => {
    const active = new Set(PROVIDER_PRESETS.flatMap(p => p.models));
    for (const retired of [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v3.2-exp',
      'kimi-for-coding',
      'kimi-k2.5',
      'moonshot-v1-128k',
      'step-3.5-flash',
      'step-2-16k',
      'step-1-200k',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'qwen3-max',
      'qwen3.5-plus',
      'qwen3.5-flash',
      'claude-sonnet-4-6',
      'anthropic/claude-sonnet-4.6',
      'claude-mythos-5',
      'claude-mythos-preview',
    ]) {
      expect(active.has(retired), retired).toBe(false);
    }
  });

  it('uses current DeepSeek API model ids instead of release artifact names', () => {
    const deepseek = PROVIDER_PRESETS.find(preset => preset.id === 'deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek!.models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(deepseek!.defaultModel).toBe('deepseek-v4-flash');
    expect(deepseek!.modelMetadata['deepseek-v4-flash']?.status).toBe('recommended');
    expect(JSON.stringify(deepseek)).not.toContain('deepseek-v3.2-exp');
    expect(JSON.stringify(deepseek)).not.toContain('DeepSeek-V3.2-Exp');
  });

  it('uses current DashScope API model ids from the official 2026-07-01 model list', () => {
    const dashscope = PROVIDER_PRESETS.find(preset => preset.id === 'dashscope');
    expect(dashscope).toBeDefined();
    expect(dashscope!.models).toEqual(['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash']);
    expect(dashscope!.defaultModel).toBe('qwen3.7-max');
    expect(dashscope!.modelMetadata['qwen3.7-max']?.status).toBe('recommended');
    expect(JSON.stringify(dashscope)).not.toContain('qwen3-max');
    expect(JSON.stringify(dashscope)).not.toContain('qwen3.5-plus');
    expect(JSON.stringify(dashscope)).not.toContain('qwen3.5-flash');
  });

  it('uses current Gemini API model ids from the official 2026-07-01 model list', () => {
    const gemini = PROVIDER_PRESETS.find(preset => preset.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini!.models).toEqual(['gemini-3.1-pro-preview', 'gemini-3.5-flash']);
    expect(gemini!.defaultModel).toBe('gemini-3.5-flash');
    expect(gemini!.modelMetadata['gemini-3.5-flash']?.status).toBe('recommended');
    expect(JSON.stringify(gemini)).not.toContain('gemini-3-pro-preview');
    expect(JSON.stringify(gemini)).not.toContain('gemini-3-flash-preview');
  });

  it('uses current Anthropic API model ids from the official 2026-07-01 model list', () => {
    const anthropic = PROVIDER_PRESETS.find(preset => preset.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.models).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect(anthropic!.defaultModel).toBe('claude-sonnet-5');
    expect(anthropic!.modelMetadata['claude-sonnet-5']?.status).toBe('recommended');
    expect(anthropic!.modelMetadata['claude-fable-5']?.status).toBe('current');
    expect(anthropic!.modelMetadata['claude-opus-4-8']?.contextLengthTokens).toBe(1_000_000);
    expect(anthropic!.modelMetadata['claude-haiku-4-5-20251001']?.contextLengthTokens).toBe(200_000);
    expect(JSON.stringify(anthropic)).not.toContain('claude-mythos-5');
    expect(JSON.stringify(anthropic)).not.toContain('claude-mythos-preview');
  });

  it('uses current OpenRouter route ids from the official 2026-07-01 models API', () => {
    const openrouter = PROVIDER_PRESETS.find(preset => preset.id === 'openrouter');
    expect(openrouter).toBeDefined();
    expect(openrouter!.models).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.4-mini',
      'moonshotai/kimi-k2.6',
      'stepfun/step-3.7-flash',
    ]);
    expect(openrouter!.defaultModel).toBe('anthropic/claude-sonnet-5');
    expect(openrouter!.modelMetadata['anthropic/claude-sonnet-5']?.status).toBe('recommended');
    expect(JSON.stringify(openrouter)).not.toContain('anthropic/claude-sonnet-4.6');
  });

  it('does not expose the unverified Kimi Code endpoint as a public provider preset', () => {
    expect(PROVIDER_PRESETS.map(preset => preset.id)).not.toContain('kimi-code');
    const serialized = JSON.stringify(PROVIDER_PRESETS);
    expect(serialized).not.toContain('kimi-for-coding');
    expect(serialized).not.toContain('api.kimi.com/coding');
  });

  it('exposes a refresh gate for stale provider/model metadata', () => {
    const baseline = new Date(`${PROVIDER_PRESETS_LAST_VERIFIED_AT}T12:00:00.000Z`);
    for (const preset of PROVIDER_PRESETS) {
      expect(isProviderPresetStale(preset, baseline), preset.id).toBe(false);
      expect(providerModelsNeedingRefresh(preset, baseline), preset.id).toEqual([]);
    }

    const old = new Date('2026-08-15T12:00:00.000Z');
    expect(PROVIDER_PRESETS.some(preset => isProviderPresetStale(preset, old))).toBe(true);
  });
});
