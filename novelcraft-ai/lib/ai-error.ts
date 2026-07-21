import type { StringKey, Translations } from '@/lib/i18n';

const AI_ERROR_CATEGORIES = [
  'invalid_credentials',
  'quota_or_balance',
  'network',
  'local_engine',
  'unknown',
] as const;

export type AIErrorCategory = (typeof AI_ERROR_CATEGORIES)[number];

export const AI_ERROR_I18N_KEYS = {
  invalid_credentials: 'aiErrorInvalidCredentials',
  quota_or_balance: 'aiErrorQuotaOrBalance',
  network: 'aiErrorNetwork',
  local_engine: 'aiErrorLocalEngine',
  unknown: 'aiErrorUnknown',
} as const satisfies Record<AIErrorCategory, StringKey>;

type AIErrorI18nKey = (typeof AI_ERROR_I18N_KEYS)[AIErrorCategory];

export interface AIErrorPayload {
  type: 'inkmarshal-ai-error';
  version: 1;
  category: AIErrorCategory;
  i18nKey: AIErrorI18nKey;
  status?: number;
}

export class AIUsageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly category: AIErrorCategory = 'unknown',
  ) {
    super(message);
    this.name = 'AIUsageError';
  }
}

const STREAM_ERROR_PREFIX = 'INKMARSHAL_AI_ERROR:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function statusFrom(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  for (const value of [error.statusCode, error.status, isRecord(error.response) ? error.response.status : undefined]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

function errorSearchText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value == null || seen.has(value)) return;
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (!isRecord(value)) return;
    seen.add(value);
    for (const key of ['name', 'message', 'code', 'type', 'url', 'responseBody']) {
      visit(value[key], depth + 1);
    }
    visit(value.cause, depth + 1);
    visit(value.response, depth + 1);
    visit(value.error, depth + 1);
  };
  visit(error, 0);
  return parts.join(' ').toLowerCase();
}

function includesAny(text: string, values: readonly string[]): boolean {
  return values.some(value => text.includes(value));
}

export function classifyAIError(error: unknown): AIErrorPayload {
  if (error instanceof AIUsageError) {
    return {
      type: 'inkmarshal-ai-error',
      version: 1,
      category: error.category,
      i18nKey: AI_ERROR_I18N_KEYS[error.category],
      status: error.status,
    };
  }

  const status = statusFrom(error);
  const text = errorSearchText(error);
  let category: AIErrorCategory = 'unknown';

  if (
    status === 401
    || status === 403
    || includesAny(text, [
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'authentication failed',
      'authentication_error',
      'unauthorized',
      'missing api key',
      'expired token',
    ])
  ) {
    category = 'invalid_credentials';
  } else if (
    status === 402
    || status === 429
    || includesAny(text, [
      'insufficient_quota',
      'insufficient quota',
      'rate limit',
      'rate_limit',
      'too many requests',
      'billing',
      'balance',
      'credit',
      'quota exceeded',
    ])
  ) {
    category = 'quota_or_balance';
  } else {
    const localRuntime = includesAny(text, [
      'local engine',
      'local runtime',
      'engine missing',
      'engine not found',
      'engine unavailable',
      'no model available',
      'llama-server',
      'mlx-server',
      'ollama',
      'lm studio',
      '127.0.0.1',
      'localhost',
      '[::1]',
    ]);
    const unavailable = includesAny(text, [
      'econnrefused',
      'connection refused',
      'not running',
      'unavailable',
      'missing',
      'not found',
      'failed to start',
      'crash',
      'exited',
    ]);
    if (localRuntime && unavailable) {
      category = 'local_engine';
    } else if (
      includesAny(text, [
        'failed to fetch',
        'fetch failed',
        'network',
        'enetunreach',
        'ehostunreach',
        'econnreset',
        'etimedout',
        'dns',
        'socket hang up',
        'connection closed',
        'offline',
      ])
    ) {
      category = 'network';
    }
  }

  return {
    type: 'inkmarshal-ai-error',
    version: 1,
    category,
    i18nKey: AI_ERROR_I18N_KEYS[category],
    ...(status === undefined ? {} : { status }),
  };
}

export function isAIErrorPayload(value: unknown): value is AIErrorPayload {
  if (!isRecord(value)) return false;
  const category = value.category;
  return value.type === 'inkmarshal-ai-error'
    && value.version === 1
    && typeof category === 'string'
    && (AI_ERROR_CATEGORIES as readonly string[]).includes(category)
    && value.i18nKey === AI_ERROR_I18N_KEYS[category as AIErrorCategory]
    && (value.status === undefined || typeof value.status === 'number');
}

export function serializeAIError(error: unknown): string {
  return `${STREAM_ERROR_PREFIX}${JSON.stringify(classifyAIError(error))}`;
}

export function serializeAIErrorPayload(payload: AIErrorPayload): string {
  return `${STREAM_ERROR_PREFIX}${JSON.stringify(payload)}`;
}

export function parseAIErrorMessage(message: string): AIErrorPayload | null {
  if (!message.startsWith(STREAM_ERROR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(message.slice(STREAM_ERROR_PREFIX.length)) as unknown;
    return isAIErrorPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function localizedAIErrorMessage(payload: AIErrorPayload, t: Translations): string {
  return t[payload.i18nKey];
}

export function presentAIErrorMessage(
  message: string,
  t: Translations,
  fallback: string,
): string {
  const payload = parseAIErrorMessage(message);
  return payload ? localizedAIErrorMessage(payload, t) : (message.trim() || fallback);
}
