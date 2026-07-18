// Wave 2 commit E — "Extract assistant message as knowledge entry".
//
// Given a single message body the user picked from a ConversationThread,
// ask the recall-class model to distill it into a structured prefill the
// KnowledgeEntryForm can open with. The route layer never writes anything
// — the form drives the eventual create flow so the user can review the
// suggested type/title/summary before saving.
//
// All failures (abort, model error, validation, no model bound) collapse
// to a small "manual stub" the form still accepts. We never block the user
// on an unreachable model.

import { type LanguageModel } from 'ai';
import { OUTPUT_TOKEN_CEILING } from '@/lib/ai/output-budget';
import { z } from 'zod';
import { generateStructuredObject } from '@/lib/ai/structured-output';

import { KNOWLEDGE_TYPES, type KnowledgeType } from '@/lib/types/knowledge';
import { RELATION_PRESETS } from '@/lib/types/knowledge-relations';

// We intentionally keep `data` loose (`Record<string, unknown>`) because the
// downstream KnowledgeEntryForm holds typed defaults for each KnowledgeType
// and overlays the prefill onto them. Forcing a tight schema here would
// double-encode the per-type shape and is harder to evolve.
export const ExtractedEntrySchema = z.object({
  type: z.enum(KNOWLEDGE_TYPES).default('character'),
  title: z.string().max(200).default(''),
  summary: z.string().max(2_000).default(''),
  data: z.record(z.string(), z.unknown()).default({}),
  suggestedWikilinks: z.array(z.string().max(200)).max(20).default([]),
  suggestedRelations: z
    .array(
      z.object({
        target: z.string().min(1).max(200),
        // Free-form to allow user vocabulary; the form's RelationsEditor maps
        // known presets to its dropdown and treats the rest as "custom".
        type: z.string().min(1).max(50).default('friend'),
        label: z.string().max(200).default(''),
      }),
    )
    .max(20)
    .default([]),
});

export type ExtractedEntry = z.infer<typeof ExtractedEntrySchema>;

export interface ExtractedEntryResult {
  entry: ExtractedEntry;
  ok: boolean;
}

const STUB_TYPE: KnowledgeType = 'character';

/**
 * Tail-truncated fallback used when no model is available or extraction errors
 * out. Keeps the form usable — user can hand-edit type/title/summary.
 */
export function buildExtractStub(messageContent: string, type: KnowledgeType = STUB_TYPE): ExtractedEntry {
  const summary = (messageContent ?? '').slice(0, 400).trim();
  return {
    type,
    title: '',
    summary,
    data: {},
    suggestedWikilinks: [],
    suggestedRelations: [],
  };
}

export interface ExtractFromMessageArgs {
  messageContent: string;
  model: LanguageModel;
  /** Hint the LLM toward a specific KnowledgeType when the caller has UI context. */
  targetType?: KnowledgeType;
  locale?: string;
  signal?: AbortSignal;
}

const CONTENT_CAP = 4_000;

/**
 * Run the extraction. On any failure (including model abort / validation /
 * empty response) returns {@link buildExtractStub} so the caller can render
 * the manual-fill form without an extra try/catch.
 */
export async function extractEntryFromMessage(
  args: ExtractFromMessageArgs,
): Promise<ExtractedEntry> {
  return (await extractEntryFromMessageResult(args)).entry;
}

export async function extractEntryFromMessageResult(
  args: ExtractFromMessageArgs,
): Promise<ExtractedEntryResult> {
  const raw = (args.messageContent ?? '').trim();
  if (raw.length < 8) {
    // Nothing for the model to chew on. Skip the call and return a stub so
    // the form still opens — user can paste / rephrase manually.
    return { entry: buildExtractStub(args.messageContent, args.targetType), ok: false };
  }
  const capped = raw.slice(0, CONTENT_CAP);
  const isZh = (args.locale ?? '').startsWith('zh');
  const typeHint = args.targetType
    ? (isZh
        ? `\n\n用户已指定类型为 \`${args.targetType}\`，请按该类型组织字段。`
        : `\n\nUser pre-selected type \`${args.targetType}\`; structure fields to fit that type.`)
    : '';

  const relationVocab = RELATION_PRESETS.join(', ');
  const system = isZh
    ? '你是一位资深小说编辑，专长是从对话片段中识别人物/世界/时间线/大纲信息，并把它们整理成结构化的知识库条目预填。保持客观、忠于原文。'
    : "You are a senior story editor extracting character / world / timeline / outline facts from a discussion snippet into a structured knowledge-base prefill. Stay faithful to the source.";

  const prompt = isZh
    ? `请阅读以下对话片段，输出一份知识库条目的预填 JSON：
- type：从 character / world / timeline / outline / style_reference 中选一项，对应片段最主要描述的事物。
- title：候选条目名（角色名 / 地名 / 章节标题等）。若片段未提名字，留空字符串。
- summary：60-200 字的中文摘要，提炼最关键事实。
- data：按 type 的关键字段填充（character 用 role/description/motivation/traits[]/arc；world 用 category/description；timeline 用 date/eventType/description；outline 用 chapterNumber/synopsis/keyEvents[]/pov）；不确定的字段留空。
- suggestedWikilinks：片段中出现的、可能值得另建条目的其他人物/地名/事物（字符串数组，每项即将作为 [[wikilink]] 写入正文）。
- suggestedRelations：若片段提到角色之间的关系，列出 { target: 对方姓名, type: ${relationVocab} 之一或自定义短语, label: 关系简述 } 数组。${typeHint}

--- 对话片段 ---
${capped}
--- 片段结束 ---`
    : `Read the conversation snippet and output a knowledge-entry prefill JSON:
- type: one of character / world / timeline / outline / style_reference (pick the dominant subject).
- title: candidate entry name (character name, place, chapter title). Empty string if the snippet doesn't name one.
- summary: 1-3 sentence neutral summary of the key facts.
- data: type-specific fields (character: role/description/motivation/traits[]/arc; world: category/description; timeline: date/eventType/description; outline: chapterNumber/synopsis/keyEvents[]/pov). Leave fields you cannot infer empty.
- suggestedWikilinks: array of other named entities in the snippet worth their own entry (each will be written as a [[wikilink]] in the entry body).
- suggestedRelations: when the snippet mentions a relationship between two characters, emit { target, type (one of ${relationVocab} or a free phrase), label (short note) }.${typeHint}

--- SNIPPET ---
${capped}
--- END SNIPPET ---`;

  try {
    const { object } = await generateStructuredObject({
      model: args.model,
      system,
      prompt,
      schema: ExtractedEntrySchema,
      temperature: 0.3,
      maxOutputTokens: OUTPUT_TOKEN_CEILING,
      abortSignal: args.signal,
    });
    return { entry: ExtractedEntrySchema.parse(object), ok: true };
  } catch (err) {
    // A user-initiated cancel must propagate, not masquerade as a
    // succeeded-with-fallback stub the form would then render.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return { entry: buildExtractStub(args.messageContent, args.targetType), ok: false };
  }
}
