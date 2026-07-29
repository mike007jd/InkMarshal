import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, Output } from 'ai';
import { z } from 'zod';

import { OPERATION_ROLE, type OperationKind } from './types';
import { AIUsageError } from '@/lib/ai-error';
import { ChapterEditSchema } from '@/lib/ai/types';
import {
  disableThinkingFetch,
  resolveBaseUrl,
  resolveModelForRole,
} from './server-resolve';

// ── Helpers ─────────────────────────────────────────────────────────────────

function localRequest(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/api/novels/abc/messages', {
    method: 'POST',
    headers,
  });
}

function remoteRequest(headers: Record<string, string>): Request {
  return new Request('https://example.com/api/novels/abc/messages', {
    method: 'POST',
    headers,
  });
}

const FULL_OPENAI_HEADERS = {
  'x-im-role': 'draft',
  'x-im-transport': 'openai-compatible',
  'x-im-base-url': 'http://127.0.0.1:8000/v1',
  'x-im-model': 'local-model',
  'x-im-secret': 'sk-local-test',
};

// ── resolveBaseUrl (pure URL-derivation seam) ───────────────────────────────

describe('resolveBaseUrl', () => {
  it('leaves an openai-compatible base URL untouched (user URL is authoritative)', () => {
    expect(resolveBaseUrl('openai-compatible', 'http://127.0.0.1:8000/v1')).toBe(
      'http://127.0.0.1:8000/v1',
    );
  });

  it('leaves an anthropic base URL untouched', () => {
    expect(resolveBaseUrl('anthropic', 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com',
    );
  });

  it('appends /v1 to an ollama-native base URL', () => {
    expect(resolveBaseUrl('ollama-native', 'http://127.0.0.1:11434')).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('strips a trailing slash before appending /v1 for ollama-native', () => {
    expect(resolveBaseUrl('ollama-native', 'http://127.0.0.1:11434/')).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('does not double-append /v1 when ollama-native base already ends in /v1', () => {
    expect(resolveBaseUrl('ollama-native', 'http://127.0.0.1:11434/v1')).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });
});

// ── resolveModelForRole ─────────────────────────────────────────────────────

describe('resolveModelForRole', () => {
  it('resolves an openai-compatible local request for the matching role', async () => {
    const req = localRequest(FULL_OPENAI_HEADERS);
    const resolved = await resolveModelForRole(req, 'draft');
    expect(resolved).not.toBeNull();
    expect(resolved!.runtimeModel.model).toBe('local-model');
    expect(resolved!.runtimeModel.providerId).toBe('openai-compatible');
    expect(resolved!.runtimeModel.id).toBe('openai-compatible/local-model');
    expect(resolved!.runtimeModel.tags).toContain('user-owned-runtime');
    expect(resolved!.model).toBeTruthy();
  });

  it('returns null when the requested role does not match x-im-role', async () => {
    const req = localRequest(FULL_OPENAI_HEADERS);
    const resolved = await resolveModelForRole(req, 'recall');
    expect(resolved).toBeNull();
  });

  it('resolves role-scoped headers for multi-phase requests', async () => {
    const req = localRequest({
      'x-im-draft-kind': 'local',
      'x-im-draft-transport': 'openai-compatible',
      'x-im-draft-base-url': 'http://127.0.0.1:8000/v1',
      'x-im-draft-model': 'draft-model',
      'x-im-planning-kind': 'local',
      'x-im-planning-transport': 'openai-compatible',
      'x-im-planning-base-url': 'http://127.0.0.1:8001/v1',
      'x-im-planning-model': 'planning-model',
    });
    const draft = await resolveModelForRole(req, 'draft');
    const planning = await resolveModelForRole(req, 'planning');
    const recall = await resolveModelForRole(req, 'recall');
    expect(draft?.runtimeModel.model).toBe('draft-model');
    expect(planning?.runtimeModel.model).toBe('planning-model');
    expect(recall).toBeNull();
  });

  it('returns null for a non-local request even with full headers (localhost gate)', async () => {
    const req = remoteRequest(FULL_OPENAI_HEADERS);
    const resolved = await resolveModelForRole(req, 'draft');
    expect(resolved).toBeNull();
  });

  it('returns null for user runtime headers on production web even when the request URL is local', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INKMARSHAL_RUNTIME', '');
    try {
      const req = localRequest(FULL_OPENAI_HEADERS);
      const resolved = await resolveModelForRole(req, 'draft');
      expect(resolved).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('resolves an ollama-native runtime and appends /v1 to its base URL', async () => {
    const req = localRequest({
      'x-im-role': 'draft',
      'x-im-transport': 'ollama-native',
      'x-im-base-url': 'http://127.0.0.1:11434',
      'x-im-model': 'qwen3.5:4b',
    });
    const resolved = await resolveModelForRole(req, 'draft');
    expect(resolved).not.toBeNull();
    expect(resolved!.runtimeModel.model).toBe('qwen3.5:4b');
    expect(resolved!.runtimeModel.providerId).toBe('ollama-native');
    expect(resolved!.runtimeModel.contextWindow).toBe(262_144);
    // /v1 appending is now an internal detail of resolveBaseUrl (the resolved
    // model no longer surfaces a synthetic preset); assert it at the source.
    expect(resolveBaseUrl('ollama-native', 'http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1');
  });

  it('resolves anthropic transport when a secret is present', async () => {
    const req = localRequest({
      'x-im-role': 'rewrite',
      'x-im-kind': 'provider',
      'x-im-transport': 'anthropic',
      'x-im-base-url': 'https://api.anthropic.com',
      'x-im-model': 'claude-sonnet-4-6',
      'x-im-secret': 'sk-ant-test',
    });
    const resolved = await resolveModelForRole(req, 'rewrite');
    expect(resolved).not.toBeNull();
    expect(resolved!.runtimeModel.providerId).toBe('anthropic');
    expect(resolved!.runtimeModel.model).toBe('claude-sonnet-4-6');
  });

  it('rejects role-aware secrets on non-loopback HTTP endpoints', async () => {
    const req = localRequest({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://192.0.2.10:8000/v1',
      'x-im-model': 'remote-model',
      'x-im-secret': 'sk-must-not-forward',
    });

    await expect(resolveModelForRole(req, 'draft')).rejects.toMatchObject({
      name: 'AIUsageError',
      status: 400,
      category: 'invalid_credentials',
    } satisfies Partial<AIUsageError>);
  });

  it('rejects anthropic transport with no secret instead of falling through to BYOK', async () => {
    const req = localRequest({
      'x-im-role': 'rewrite',
      'x-im-kind': 'provider',
      'x-im-transport': 'anthropic',
      'x-im-base-url': 'https://api.anthropic.com',
      'x-im-model': 'claude-sonnet-4-6',
    });
    // MS-07: a single authoritative missing-secret gate runs BEFORE the
    // transport switch (no second per-transport re-check), so the message is
    // the unified one. The contract that matters — reject, never fall through
    // to a keyless BYOK model — is unchanged.
    await expect(resolveModelForRole(req, 'rewrite')).rejects.toMatchObject({
      name: 'AIUsageError',
      status: 400,
      category: 'invalid_credentials',
    } satisfies Partial<AIUsageError>);
  });

  it('rejects hosted OpenAI-compatible provider headers with no secret', async () => {
    const req = localRequest({
      'x-im-role': 'draft',
      'x-im-kind': 'provider',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'https://api.openai.com/v1',
      'x-im-model': 'gpt-5.4-mini',
    });

    await expect(resolveModelForRole(req, 'draft')).rejects.toMatchObject({
      name: 'AIUsageError',
      status: 400,
      category: 'invalid_credentials',
    } satisfies Partial<AIUsageError>);
  });

  it('keeps keyless OpenAI-compatible behavior for loopback local runtimes', async () => {
    const req = localRequest({
      'x-im-role': 'draft',
      'x-im-kind': 'local',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://127.0.0.1:8000/v1',
      'x-im-model': 'local-model',
    });

    const resolved = await resolveModelForRole(req, 'draft');
    expect(resolved?.runtimeModel.model).toBe('local-model');
    expect(resolved?.runtimeModel.contextWindow).toBeUndefined();
  });

  it('returns null when x-im-* headers are absent entirely', async () => {
    const req = localRequest({ 'content-type': 'application/json' });
    const resolved = await resolveModelForRole(req, 'draft');
    expect(resolved).toBeNull();
  });

  it('returns null when base-url is missing (incomplete headers)', async () => {
    const req = localRequest({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-model': 'local-model',
    });
    const resolved = await resolveModelForRole(req, 'draft');
    expect(resolved).toBeNull();
  });

  it('returns null when model is missing (incomplete headers)', async () => {
    const req = localRequest({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://127.0.0.1:8000/v1',
    });
    const resolved = await resolveModelForRole(req, 'draft');
    expect(resolved).toBeNull();
  });

  it('returns null when the base-url is not a valid http(s) URL', async () => {
    const req = localRequest({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'ftp://127.0.0.1/v1',
      'x-im-model': 'local-model',
    });
    const resolved = await resolveModelForRole(req, 'draft');
    expect(resolved).toBeNull();
  });

  it('returns null when the base-url contains credentials or URL decorations', async () => {
    const withCredentials = localRequest({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://user:pass@127.0.0.1:8000/v1',
      'x-im-model': 'local-model',
    });
    const withQuery = localRequest({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://127.0.0.1:8000/v1?token=secret',
      'x-im-model': 'local-model',
    });
    expect(await resolveModelForRole(withCredentials, 'draft')).toBeNull();
    expect(await resolveModelForRole(withQuery, 'draft')).toBeNull();
  });
});

// ── operation → role contract (locked end-to-end) ───────────────────────────

describe('OPERATION_ROLE contract (operation → capability role)', () => {
  const expected: Record<OperationKind, string> = {
    chat: 'draft',
    outline: 'planning',
    chapter: 'draft',
    polish: 'rewrite',
    summarize: 'recall',
    validate: 'recall',
    unify: 'rewrite',
  };

  for (const op of Object.keys(expected) as OperationKind[]) {
    it(`maps operation "${op}" → role "${expected[op]}"`, () => {
      expect(OPERATION_ROLE[op]).toBe(expected[op]);
    });
  }
});

describe('disableThinkingFetch (regression: BUG-5 empty local generation)', () => {
  it('injects chat_template_kwargs.enable_thinking=false into a JSON body', async () => {
    let seenBody: string | undefined;
    const base = (async (_url: unknown, init?: { body?: unknown }) => {
      seenBody = init?.body as string;
      return new Response('{}');
    }) as unknown as typeof fetch;

    await disableThinkingFetch(base)('http://127.0.0.1:1234/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'qwen', messages: [] }),
    });

    expect(seenBody).toBeDefined();
    expect(JSON.parse(seenBody!)).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('does not clobber a caller-provided chat_template_kwargs', async () => {
    let seenBody: string | undefined;
    const base = (async (_url: unknown, init?: { body?: unknown }) => {
      seenBody = init?.body as string;
      return new Response('{}');
    }) as unknown as typeof fetch;

    await disableThinkingFetch(base)('http://127.0.0.1:1234/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ chat_template_kwargs: { enable_thinking: true } }),
    });

    expect(JSON.parse(seenBody!).chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('leaves a non-JSON body untouched', async () => {
    let seenBody: unknown;
    const base = (async (_url: unknown, init?: { body?: unknown }) => {
      seenBody = init?.body;
      return new Response('{}');
    }) as unknown as typeof fetch;

    await disableThinkingFetch(base)('http://127.0.0.1:1234/v1/chat/completions', {
      method: 'POST',
      body: 'not-json',
    });

    expect(seenBody).toBe('not-json');
  });
});

// ── Structured outputs wire contract (regression: edit Markdown / no schema) ─

function chatCompletionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('openai-compatible structured outputs (supportsStructuredOutputs)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loopback user-runtime sends response_format.json_schema and keeps enable_thinking=false', async () => {
    let seenBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return chatCompletionResponse(
          JSON.stringify({
            changes: [{ original: '旧句', replacement: '新句' }],
            summary: '替换一句',
          }),
        );
      }),
    );

    const resolved = await resolveModelForRole(
      localRequest({
        'x-im-role': 'rewrite',
        'x-im-kind': 'local',
        'x-im-engine-format': 'gguf',
        'x-im-transport': 'openai-compatible',
        'x-im-base-url': 'http://127.0.0.1:8000/v1',
        'x-im-model': 'Qwen3.5-4B-Q4_K_M',
      }),
      'rewrite',
    );
    expect(resolved).not.toBeNull();
    expect(
      (resolved!.model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs,
    ).toBe(true);

    const { output } = await generateText({
      model: resolved!.model,
      output: Output.object({ schema: ChapterEditSchema }),
      prompt: 'edit',
    });

    expect(seenBody).toBeDefined();
    expect(seenBody).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: expect.any(String),
          strict: true,
        },
      },
      chat_template_kwargs: { enable_thinking: false },
    });
    const responseFormat = seenBody!.response_format as {
      type: string;
      json_schema?: { schema?: unknown };
    };
    expect(responseFormat.type).toBe('json_schema');
    expect(responseFormat.json_schema?.schema).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          changes: expect.any(Object),
          summary: expect.any(Object),
        }),
      }),
    );
    // ChapterEdit keeps its 20k/100 business bounds as runtime refinements.
    // Serializing them as maxLength/maxItems makes bundled llama.cpp reject
    // the generated grammar and silently fall back to unconstrained output.
    expect(JSON.stringify(responseFormat.json_schema?.schema)).not.toContain('maxLength');
    expect(JSON.stringify(responseFormat.json_schema?.schema)).not.toContain('maxItems');
    expect(output).toEqual({
      changes: [{ original: '旧句', replacement: '新句' }],
      summary: '替换一句',
    });
  });

  it('hosted openai-compatible keeps default (no schema / no thinking kwargs)', async () => {
    let seenBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return chatCompletionResponse(JSON.stringify({ ok: true }));
      }),
    );

    const resolved = await resolveModelForRole(
      localRequest({
        'x-im-role': 'draft',
        'x-im-kind': 'provider',
        'x-im-transport': 'openai-compatible',
        'x-im-base-url': 'https://api.openai.com/v1',
        'x-im-model': 'gpt-5.4-mini',
        'x-im-secret': 'sk-hosted-test',
      }),
      'draft',
    );
    expect(resolved).not.toBeNull();
    expect(
      (resolved!.model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs,
    ).toBe(false);

    await generateText({
      model: resolved!.model,
      output: Output.object({ schema: z.object({ ok: z.boolean() }) }),
      prompt: 'x',
    });

    expect(seenBody).toMatchObject({
      response_format: { type: 'json_object' },
    });
    expect(seenBody).not.toHaveProperty('chat_template_kwargs');
    expect(
      (seenBody!.response_format as { json_schema?: unknown }).json_schema,
    ).toBeUndefined();
  });

  it('custom non-loopback HTTPS openai-compatible does not enable structured schema', async () => {
    let seenBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return chatCompletionResponse(JSON.stringify({ ok: true }));
      }),
    );

    const resolved = await resolveModelForRole(
      localRequest({
        'x-im-role': 'draft',
        'x-im-kind': 'custom',
        'x-im-transport': 'openai-compatible',
        'x-im-base-url': 'https://llm.example.com/v1',
        'x-im-model': 'custom-model',
        'x-im-secret': 'sk-custom-test',
      }),
      'draft',
    );
    expect(resolved).not.toBeNull();
    expect(
      (resolved!.model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs,
    ).toBe(false);

    await generateText({
      model: resolved!.model,
      output: Output.object({ schema: z.object({ ok: z.boolean() }) }),
      prompt: 'x',
    });

    expect(seenBody).toMatchObject({
      response_format: { type: 'json_object' },
    });
    expect(seenBody).not.toHaveProperty('chat_template_kwargs');
  });

  it('custom loopback runtime does not claim json_schema support', async () => {
    const headers: Record<string, string> = {
      'x-im-role': 'rewrite',
      'x-im-kind': 'custom',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://127.0.0.1:8000/v1',
      'x-im-model': 'local-model',
    };

    const resolved = await resolveModelForRole(localRequest(headers), 'rewrite');
    expect(resolved).not.toBeNull();
    expect(
      (resolved!.model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs,
    ).toBe(false);
  });

  it('authoritatively rejects bundled MLX for structured-output roles', async () => {
    await expect(resolveModelForRole(
      localRequest({
        'x-im-role': 'rewrite',
        'x-im-kind': 'local',
        'x-im-engine-format': 'mlx',
        'x-im-transport': 'openai-compatible',
        'x-im-base-url': 'http://127.0.0.1:8000/v1',
        'x-im-model': 'local-model',
      }),
      'rewrite',
    )).rejects.toMatchObject({
      name: 'AIUsageError',
      status: 400,
      category: 'local_engine',
      message: expect.stringContaining('MLX local models currently support Draft only'),
    });
  });

  it('keeps bundled MLX available for Draft text generation', async () => {
    const resolved = await resolveModelForRole(
      localRequest({
        'x-im-role': 'draft',
        'x-im-kind': 'local',
        'x-im-engine-format': 'mlx',
        'x-im-transport': 'openai-compatible',
        'x-im-base-url': 'http://127.0.0.1:8000/v1',
        'x-im-model': 'local-model',
      }),
      'draft',
    );
    expect(resolved).not.toBeNull();
    expect(
      (resolved!.model as { supportsStructuredOutputs?: boolean }).supportsStructuredOutputs,
    ).toBe(false);
  });

  it('secret/security gates still reject keyless hosted and non-loopback HTTP secrets', async () => {
    await expect(
      resolveModelForRole(
        localRequest({
          'x-im-role': 'draft',
          'x-im-kind': 'provider',
          'x-im-transport': 'openai-compatible',
          'x-im-base-url': 'https://api.openai.com/v1',
          'x-im-model': 'gpt-5.4-mini',
        }),
        'draft',
      ),
    ).rejects.toMatchObject({
      name: 'AIUsageError',
      status: 400,
      category: 'invalid_credentials',
    } satisfies Partial<AIUsageError>);

    await expect(
      resolveModelForRole(
        localRequest({
          'x-im-role': 'draft',
          'x-im-transport': 'openai-compatible',
          'x-im-base-url': 'http://192.0.2.10:8000/v1',
          'x-im-model': 'remote-model',
          'x-im-secret': 'sk-must-not-forward',
        }),
        'draft',
      ),
    ).rejects.toMatchObject({
      name: 'AIUsageError',
      status: 400,
      category: 'invalid_credentials',
    } satisfies Partial<AIUsageError>);
  });
});
