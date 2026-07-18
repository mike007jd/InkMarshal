import type { StyleReferenceData } from '@/lib/types/knowledge';
import { type Locale, isZhLocale } from '@/lib/i18n';
import { type Novel } from '@/lib/db';
import {
  buildAIContext,
  type AIContextResult,
  type AIOpKind,
  type BuildAIContextFocus,
} from '@/lib/ai-context-builder';
import type { EmbeddingEndpointHint } from '@/lib/knowledge/embedding';

interface SystemPromptInput {
  novelTitle: string;
  novelGenre: string;
  knowledgeSummaries: string;
  styleReference: StyleReferenceData | null;
  language: Locale | string;
}

/**
 * Assemble the system prompt for AI writing operations.
 * Combines novel metadata, knowledge base summaries, and optional style reference.
 */
export function assembleSystemPrompt(input: SystemPromptInput): string {
  const { novelTitle, novelGenre, knowledgeSummaries, styleReference, language } = input;
  const isZh = isZhLocale(language as Locale);

  const parts: string[] = [];

  // Base instruction
  if (isZh) {
    parts.push(`你是一位专业的小说写作助手。你正在协助创作小说《${novelTitle}》${novelGenre ? `，类型为${novelGenre}` : ''}。`);
    parts.push('请用中文写作，文风流畅自然。保持情节连贯、角色行为一致。');
  } else {
    parts.push(`You are a professional novel writing assistant. You are helping write "${novelTitle}"${novelGenre ? `, genre: ${novelGenre}` : ''}.`);
    parts.push('Write with a fluid, engaging literary style. Maintain plot coherence and character consistency.');
  }

  // Knowledge base summaries
  if (knowledgeSummaries.trim()) {
    if (isZh) {
      parts.push('\n--- 小说世界观与角色设定 ---');
    } else {
      parts.push('\n--- Novel World & Character Reference ---');
    }
    parts.push(knowledgeSummaries);
  }

  // Style reference
  if (styleReference) {
    if (isZh) {
      parts.push(`\n--- 写作风格参考（来源：${styleReference.source}）---`);
      parts.push(`风格特征：${styleReference.styleNotes}`);
      parts.push(`参考片段：\n${styleReference.sampleText}`);
      parts.push('请模仿上述风格进行写作，但不要直接复制原文。');
    } else {
      parts.push(`\n--- Writing Style Reference (source: ${styleReference.source}) ---`);
      parts.push(`Style notes: ${styleReference.styleNotes}`);
      parts.push(`Sample:\n${styleReference.sampleText}`);
      parts.push('Emulate this writing style but do not copy the sample directly.');
    }
  }

  return parts.join('\n');
}

export type BuildNovelSystemPromptResult = AIContextResult;

/**
 * Fetch novel + knowledge entries + rolling memory + conversation digest and
 * assemble a system prompt. Returns null if the novel is not found.
 *
 * Returns the `{ novel, systemPrompt, knowledgeSummaries }` triple plus the
 * full AIContextResult fields so routes that want pressure / memory blocks can
 * opt in. The knowledge budget is owned by the builder per `op`.
 *
 * `op` defaults to `'chapter'` (full-context behaviour). Other routes —
 * continue/rewrite/edit/chat/unify — should pass the matching op so they get
 * the smaller, op-appropriate memory window.
 */
export interface BuildNovelSystemPromptOpts {
  op?: AIOpKind;
  focus?: BuildAIContextFocus;
  styleId?: string;
  modelCtxTokens?: number;
  embeddingHint?: EmbeddingEndpointHint | null;
}

export async function buildNovelSystemPromptFromDB(
  novelId: string,
  locale: string,
  prefetchedNovel?: Novel,
  opts: BuildNovelSystemPromptOpts = {},
): Promise<BuildNovelSystemPromptResult | null> {
  const op: AIOpKind = opts.op ?? 'chapter';

  return buildAIContext({
    novelId,
    locale,
    novel: prefetchedNovel,
    op,
    focus: opts.focus,
    styleId: opts.styleId,
    modelCtxTokens: opts.modelCtxTokens,
    embeddingHint: opts.embeddingHint ?? null,
  });
}
