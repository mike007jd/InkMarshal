// PROVIDER_PRESETS is the curated, freshness-tracked RECORD of recommended BYOK
// provider models + their verification provenance (model ids, source URLs,
// lastVerifiedAt, status). Per CLAUDE.md it is the single source of truth for
// model-id freshness, and `providers.test.ts` enforces that discipline
// (source-backed lastVerifiedAt values, a 30-day staleness window, retired ids
// absent, model-id shape).
//
// IT IS NOT A RESOLVER INPUT. The runtime model resolver (server-resolve.ts)
// builds the live model from request headers / runtime health, not from this
// catalog — so nothing here flows into generation. (R-14: an earlier synthetic
// `resolved.preset` of this shape was built by the resolver and discarded by
// ai-usage; that dead value flow has been removed. The catalog stays as the
// freshness record it is documented to be.)
import type { ModelTokenPricing } from '@/lib/model-supply/types';
import type { Translations } from '@/lib/i18n';

type ProviderNameKey =
  | 'providerNameDeepseek'
  | 'providerNameMoonshot'
  | 'providerNameDashscope'
  | 'providerNameVolcengine'
  | 'providerNameStepfun'
  | 'providerNameSiliconflow'
  | 'providerNameOpenai'
  | 'providerNameGemini'
  | 'providerNameAnthropic'
  | 'providerNameOpenrouter';

export interface ProviderPreset {
  id: string;
  nameKey: ProviderNameKey;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  lastVerifiedAt: string;
  sourceUrls: readonly string[];
  modelMetadata: Record<string, ProviderModelMetadata>;
}

export interface ProviderModelMetadata {
  status: 'recommended' | 'current' | 'compatibility' | 'legacy' | 'deprecated';
  lastVerifiedAt: string;
  sourceUrls: readonly string[];
  contextLengthTokens?: number;
  sunsetAt?: string;
  replacementModel?: string;
  note?: string;
  /**
   * Optional BYOK price (per million tokens) consumed by the local cost panel's
   * `resolvePricing`. Subject to the SAME freshness discipline as the rest of
   * this record (`lastVerifiedAt` + the 30-day staleness window + source URLs):
   * only fill it with a price you can cite. A missing price is rendered as
   * "unknown" (NOT 0) so an expensive cloud model never looks free — never
   * fabricate a number to fill the field.
   */
  pricing?: ModelTokenPricing;
}

export const PROVIDER_PRESETS_LAST_VERIFIED_AT = '2026-07-01';
const ANTHROPIC_PRESETS_LAST_VERIFIED_AT = '2026-07-01';
const ANTHROPIC_MODELS_SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview';
const PROVIDER_PRESETS_STALE_AFTER_DAYS = 30;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── China providers ──
  {
    id: 'deepseek',
    nameKey: 'providerNameDeepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-v4-flash',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: [
      'https://api-docs.deepseek.com/api/list-models/',
      'https://api-docs.deepseek.com/quick_start/pricing',
      'https://api-docs.deepseek.com/updates/',
    ],
    modelMetadata: {
      'deepseek-v4-flash': {
        status: 'recommended',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: [
          'https://api-docs.deepseek.com/api/list-models/',
          'https://api-docs.deepseek.com/quick_start/pricing',
        ],
        contextLengthTokens: 1_000_000,
        note: 'Current DeepSeek V4 API model id; legacy deepseek-chat/deepseek-reasoner aliases map to this model until their 2026-07-24 sunset.',
      },
      'deepseek-v4-pro': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: [
          'https://api-docs.deepseek.com/api/list-models/',
          'https://api-docs.deepseek.com/quick_start/pricing',
        ],
        contextLengthTokens: 1_000_000,
      },
    },
  },
  {
    id: 'moonshot',
    nameKey: 'providerNameMoonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.6'],
    defaultModel: 'kimi-k2.6',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: [
      'https://platform.kimi.ai/docs/models',
      'https://platform.kimi.ai/docs/api/list-models',
    ],
    modelMetadata: {
      'kimi-k2.6': {
        status: 'recommended',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://platform.kimi.ai/docs/models'],
        contextLengthTokens: 262_144,
      },
    },
  },
  {
    id: 'dashscope',
    nameKey: 'providerNameDashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'],
    defaultModel: 'qwen3.7-max',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: [
      'https://help.aliyun.com/zh/model-studio/text-generation-model',
      'https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope',
    ],
    modelMetadata: {
      'qwen3.7-max': {
        status: 'recommended',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://help.aliyun.com/zh/model-studio/text-generation-model'],
        contextLengthTokens: 1_010_000,
      },
      'qwen3.7-plus': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://help.aliyun.com/zh/model-studio/text-generation-model'],
        contextLengthTokens: 1_010_000,
      },
      'qwen3.6-flash': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://help.aliyun.com/zh/model-studio/text-generation-model'],
        contextLengthTokens: 1_010_000,
      },
    },
  },
  {
    id: 'volcengine',
    nameKey: 'providerNameVolcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
    defaultModel: '',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: ['https://www.volcengine.com/docs/82379'],
    modelMetadata: {},
  },
  {
    id: 'stepfun',
    nameKey: 'providerNameStepfun',
    baseUrl: 'https://api.stepfun.com/v1',
    models: ['step-3.7-flash'],
    defaultModel: 'step-3.7-flash',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: [
      'https://platform.stepfun.com/docs/api-reference/models/list',
      'https://github.com/stepfun-ai/Step-3.7-Flash',
    ],
    modelMetadata: {
      'step-3.7-flash': {
        status: 'recommended',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: [
          'https://platform.stepfun.com/docs/api-reference/models/list',
          'https://github.com/stepfun-ai/Step-3.7-Flash',
        ],
        contextLengthTokens: 256_000,
      },
    },
  },
  {
    id: 'siliconflow',
    nameKey: 'providerNameSiliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [],
    defaultModel: '',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: ['https://docs.siliconflow.cn/'],
    modelMetadata: {},
  },
  // ── Global providers ──
  {
    id: 'openai',
    nameKey: 'providerNameOpenai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'],
    defaultModel: 'gpt-5.4-mini',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: ['https://platform.openai.com/docs/models'],
    modelMetadata: {
      'gpt-5.5': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://platform.openai.com/docs/models'],
        contextLengthTokens: 1_048_576,
      },
      'gpt-5.4': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://platform.openai.com/docs/models'],
        contextLengthTokens: 1_048_576,
      },
      'gpt-5.4-mini': {
        status: 'recommended',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://platform.openai.com/docs/models'],
        contextLengthTokens: 400_000,
      },
      'gpt-5.4-nano': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://platform.openai.com/docs/models'],
        contextLengthTokens: 400_000,
      },
    },
  },
  {
    id: 'gemini',
    nameKey: 'providerNameGemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: ['gemini-3.1-pro-preview', 'gemini-3.5-flash'],
    defaultModel: 'gemini-3.5-flash',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: [
      'https://ai.google.dev/gemini-api/docs/models',
      'https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview',
      'https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash',
    ],
    modelMetadata: {
      'gemini-3.1-pro-preview': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview'],
        contextLengthTokens: 1_048_576,
      },
      'gemini-3.5-flash': {
        status: 'recommended',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash'],
        contextLengthTokens: 1_048_576,
      },
    },
  },
  {
    id: 'anthropic',
    nameKey: 'providerNameAnthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-5',
    lastVerifiedAt: ANTHROPIC_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: [ANTHROPIC_MODELS_SOURCE_URL],
    modelMetadata: {
      'claude-fable-5': {
        status: 'current',
        lastVerifiedAt: ANTHROPIC_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: [ANTHROPIC_MODELS_SOURCE_URL],
        contextLengthTokens: 1_000_000,
        note: 'Anthropic current most capable widely released model; kept available but not default because Sonnet 5 is the balanced writing pick.',
      },
      'claude-opus-4-8': {
        status: 'current',
        lastVerifiedAt: ANTHROPIC_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: [ANTHROPIC_MODELS_SOURCE_URL],
        contextLengthTokens: 1_000_000,
      },
      'claude-sonnet-5': {
        status: 'recommended',
        lastVerifiedAt: ANTHROPIC_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: [ANTHROPIC_MODELS_SOURCE_URL],
        contextLengthTokens: 1_000_000,
      },
      'claude-haiku-4-5-20251001': {
        status: 'current',
        lastVerifiedAt: ANTHROPIC_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: [ANTHROPIC_MODELS_SOURCE_URL],
        contextLengthTokens: 200_000,
        note: 'Pinned Claude API ID; claude-haiku-4-5 is only a convenience alias.',
      },
    },
  },
  {
    id: 'openrouter',
    nameKey: 'providerNameOpenrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-5', 'openai/gpt-5.4-mini', 'moonshotai/kimi-k2.6', 'stepfun/step-3.7-flash'],
    defaultModel: 'anthropic/claude-sonnet-5',
    lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
    sourceUrls: ['https://openrouter.ai/api/v1/models'],
    modelMetadata: {
      'anthropic/claude-sonnet-5': {
        status: 'recommended',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://openrouter.ai/api/v1/models'],
        contextLengthTokens: 1_000_000,
      },
      'openai/gpt-5.4-mini': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://openrouter.ai/api/v1/models'],
        contextLengthTokens: 400_000,
      },
      'moonshotai/kimi-k2.6': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://openrouter.ai/api/v1/models'],
        contextLengthTokens: 262_144,
      },
      'stepfun/step-3.7-flash': {
        status: 'current',
        lastVerifiedAt: PROVIDER_PRESETS_LAST_VERIFIED_AT,
        sourceUrls: ['https://openrouter.ai/api/v1/models'],
        contextLengthTokens: 256_000,
      },
    },
  },
];

export function providerDisplayName(
  preset: Pick<ProviderPreset, 'nameKey'>,
  translations: Translations,
): string {
  return translations[preset.nameKey];
}

export function getProviderDefaultModel(preset: ProviderPreset): string | null {
  return preset.defaultModel && preset.models.includes(preset.defaultModel)
    ? preset.defaultModel
    : preset.models[0] ?? null;
}

export function getRecommendedProviderModels(preset: ProviderPreset): string[] {
  return preset.models.filter(model => preset.modelMetadata[model]?.status === 'recommended');
}

export function isProviderPresetStale(
  preset: Pick<ProviderPreset, 'lastVerifiedAt'>,
  now: Date = new Date(),
): boolean {
  const verified = Date.parse(`${preset.lastVerifiedAt}T00:00:00.000Z`);
  if (!Number.isFinite(verified)) return true;
  const ageDays = (now.getTime() - verified) / 86_400_000;
  return ageDays > PROVIDER_PRESETS_STALE_AFTER_DAYS;
}

export function providerModelsNeedingRefresh(
  preset: ProviderPreset,
  now: Date = new Date(),
): string[] {
  return preset.models.filter(model => {
    const meta = preset.modelMetadata[model];
    if (!meta) return true;
    return isProviderPresetStale({ lastVerifiedAt: meta.lastVerifiedAt }, now);
  });
}
