// SERVER module. Resolves an `x-im-*` role-aware request into an ai-sdk
// LanguageModel. The CLIENT counterpart that emits these headers is
// `headers.ts`'s `buildRoleAwareHeaders(operation)`.
//
// Header scheme (LOCKED — must match headers.ts + server-resolve.test.ts):
//   x-im-role      the resolved CapabilityRole
//   x-im-kind      local | provider | custom
//   x-im-transport openai-compatible | anthropic | ollama-native
//   x-im-base-url  the connection baseUrl
//   x-im-model     the bound modelId
//   x-im-secret    the API key/token (OMITTED entirely when none)
//
// SECURITY: honored ONLY behind the shared `requestAllowsUserRuntime`
// localhost gate. A non-local request returns null immediately — it can never
// carry/honor a secret. The secret is never logged.

import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import {
  headerValue,
  parseUserRuntimeBaseUrl,
  requestAllowsUserRuntime,
  runtimeBaseUrlCanCarrySecret,
  type ResolvedModel,
} from '@/lib/ai-providers';
import { AIUsageError } from '@/lib/ai-error';
import { getTranslations } from '@/lib/i18n';
import { isLoopbackHost } from '@/lib/loopback-hosts';
import { requestLocale } from '@/lib/request-locale';
import {
  isRuntimeConnectionKind,
  isRuntimeTransport,
  type CapabilityRole,
  type RuntimeConnectionKind,
  type RuntimeTransport,
} from './types';
import { MODEL_CATALOG } from './catalog';

function runtimeBaseUrlIsLoopback(baseURL: string): boolean {
  try {
    return isLoopbackHost(new URL(baseURL).hostname);
  } catch {
    return false;
  }
}

/**
 * Thinking-capable local models (e.g. the curated Qwen3.x served by the bundled
 * llama-server) default to "thinking" mode: they spend the whole token budget on
 * a hidden reasoning channel and return EMPTY `content`, so the Studio renders
 * blank generations / a stuck spinner (BUG-5, 2026-06). For loopback self-hosted
 * runtimes we disable thinking by injecting llama.cpp's
 * `chat_template_kwargs.enable_thinking=false` into the request body. This is
 * loopback-gated, so cloud providers never see it; a self-hosted server that
 * doesn't recognize the field simply ignores the extra key.
 */
export function disableThinkingFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body && typeof body === 'object' && !('chat_template_kwargs' in body)) {
          body.chat_template_kwargs = { enable_thinking: false };
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // Non-JSON body — leave it untouched.
      }
    }
    return baseFetch(input, init);
  }) as typeof fetch;
}

function runtimeRequiresSecret(
  transport: RuntimeTransport,
  kind: RuntimeConnectionKind | null,
  baseURL: string,
): boolean {
  if (transport === 'anthropic') return true;
  if (transport === 'ollama-native') return false;
  if (kind === 'provider') return true;
  return !runtimeBaseUrlIsLoopback(baseURL);
}

function contextWindowForModel(modelId: string): number | undefined {
  const entry = MODEL_CATALOG.find(candidate =>
    candidate.id === modelId ||
    candidate.ollamaName === modelId ||
    candidate.gguf?.repo === modelId ||
    candidate.mlx?.repo === modelId,
  );
  return entry?.contextLengthTokens;
}

/**
 * Pure URL-derivation seam (unit-tested directly). `ollama-native` talks to
 * Ollama's OpenAI-compat endpoint at `{base}/v1`; strip any trailing slash
 * then append `/v1` unless the URL already ends in `/v1`. For
 * `openai-compatible` / `anthropic` the user's baseUrl is authoritative and
 * returned untouched.
 */
export function resolveBaseUrl(
  transport: RuntimeTransport,
  baseUrl: string,
): string {
  if (transport !== 'ollama-native') return baseUrl;
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * Resolve a role-aware request into a {@link ResolvedModel}, or `null` when the
 * request is non-local, the headers are absent/incomplete, or `x-im-role` does
 * not match the requested `role` (the caller then surfaces a "bind a model"
 * error). Returns `{ model, runtimeModel }` for `createAIUsageSession`.
 */
export async function resolveModelForRole(
  req: Request,
  role: CapabilityRole,
): Promise<ResolvedModel | null> {
  // Single shared localhost gate — non-local can never carry/honor a secret.
  if (!requestAllowsUserRuntime(req)) return null;

  const headerRole = headerValue(req, 'x-im-role');
  const singleRoleMatches = headerRole === role;
  const prefix = singleRoleMatches ? 'x-im' : `x-im-${role}`;
  if (headerRole && !singleRoleMatches && !headerValue(req, `${prefix}-model`)) return null;

  const rawTransport = headerValue(req, `${prefix}-transport`);
  const transport: RuntimeTransport = isRuntimeTransport(rawTransport)
    ? rawTransport
    : 'openai-compatible';
  const rawKind = headerValue(req, `${prefix}-kind`);
  const kind = isRuntimeConnectionKind(rawKind) ? rawKind : null;

  const parsedBase = parseUserRuntimeBaseUrl(
    headerValue(req, `${prefix}-base-url`) ?? '',
  );
  const modelId = headerValue(req, `${prefix}-model`);
  if (!parsedBase || !modelId) return null;

  const baseURL = resolveBaseUrl(transport, parsedBase);
  // Read once; never log it.
  const secret = headerValue(req, `${prefix}-secret`);
  if (secret && !runtimeBaseUrlCanCarrySecret(baseURL)) {
    throw new AIUsageError(
      getTranslations(requestLocale(req.headers)).aiErrorInvalidCredentials,
      400,
      'invalid_credentials',
    );
  }

  // Single authoritative missing-secret gate, BEFORE any model is
  // constructed. Hosted OpenAI-compatible providers are not allowed to degrade
  // into a placeholder key; keyless behavior is reserved for loopback local
  // runtimes.
  if (runtimeRequiresSecret(transport, kind, baseURL) && !secret) {
    throw new AIUsageError(
      getTranslations(requestLocale(req.headers)).aiErrorInvalidCredentials,
      400,
      'invalid_credentials',
    );
  }

  let model: LanguageModel;
  switch (transport) {
    case 'anthropic': {
      model = createAnthropic({ apiKey: secret!, baseURL })(modelId);
      break;
    }
    case 'ollama-native': {
      model = createOpenAICompatible({
        name: 'ollama',
        apiKey: secret || 'ollama',
        baseURL,
      }).chatModel(modelId);
      break;
    }
    case 'openai-compatible':
    default: {
      // Bundled llama-server (and other loopback self-hosted runtimes) reach
      // this branch; disable model "thinking" so writing tasks emit prose
      // instead of burning the budget on hidden reasoning (BUG-5).
      const loopback = runtimeBaseUrlIsLoopback(baseURL);
      model = createOpenAICompatible({
        name: 'user-runtime',
        apiKey: secret || 'user-owned-runtime',
        baseURL,
        ...(loopback ? { fetch: disableThinkingFetch() } : {}),
      }).chatModel(modelId);
      break;
    }
  }

  return {
    model,
    runtimeModel: {
      id: `${transport}/${modelId}`,
      name: `${transport} ${modelId}`,
      providerId: transport,
      model: modelId,
      contextWindow: contextWindowForModel(modelId),
      tags: ['user-owned-runtime'],
    },
  };
}
