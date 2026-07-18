import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { requireNovelOwner } from '@/lib/local-auth';
import { getKnowledgeEntry } from '@/lib/db';
import { aiUsageErrorResponse, createAIUsageSession, createUsageSettlement } from '@/lib/ai-usage';
import { buildKnowledgeIndexInsertForEntry } from '@/lib/knowledge/refresh-index';
import { applyKnowledgeEntryWrite } from '@/lib/knowledge/apply-write';
import { isUuid, nowIso, parseJsonField } from '@/lib/utils';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_GENERATED_SUMMARY_CHARS = 100;

export function normalizeGeneratedKnowledgeSummary(raw: string, fallback: string): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length > 0) return normalized.slice(0, MAX_GENERATED_SUMMARY_CHARS);
  return fallback.replace(/\s+/g, ' ').trim().slice(0, MAX_GENERATED_SUMMARY_CHARS);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id: novelId, entryId } = await params;

  if (!isUuid(entryId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user } = ownerCheck;

  const row = await getKnowledgeEntry(entryId, novelId);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(req, { userId: user.id, operation: 'summarize' });
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) return response as NextResponse;
    throw error;
  }

  const title = row.title;
  const type = row.type;
  const data = parseJsonField<Record<string, unknown>>(row.data, {});

  const prompt = `Generate a concise one-line summary (max 100 chars) for this novel element. Respond with ONLY the summary, no quotes or labels.\n\nType: ${type}\nTitle: ${title}\nData: ${JSON.stringify(data)}`;
  aiUsage.addPromptText(prompt);

  let summary: string;
  let usage: Awaited<ReturnType<typeof generateText>>['usage'];
  const usageSettlement = createUsageSettlement(aiUsage);
  try {
    const result = await generateText({ model: aiUsage.model, prompt, abortSignal: req.signal });
    usage = result.usage;
    summary = normalizeGeneratedKnowledgeSummary(result.text, row.summary || row.title);
    aiUsage.addPartialOutput(summary);
    if (req.signal.aborted) {
      await usageSettlement.cancelOnce(usage);
      return new Response(null, { status: 499 });
    }
  } catch (error) {
    if (req.signal.aborted) await usageSettlement.cancelOnce();
    else await usageSettlement.failOnce();
    throw error;
  }

  if (req.signal.aborted) {
    await usageSettlement.cancelOnce(usage);
    return new Response(null, { status: 499 });
  }
  const currentRow = await getKnowledgeEntry(entryId, novelId);
  if (!currentRow) {
    await usageSettlement.failOnce();
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (currentRow.updated_at !== row.updated_at) {
    await usageSettlement.failOnce();
    return NextResponse.json(
      { error: 'Knowledge entry changed during summary generation.' },
      { status: 409 },
    );
  }
  try {
    if (summary !== row.summary) {
      const updatedAt = nowIso();
      const index = await buildKnowledgeIndexInsertForEntry(entryId, updatedAt, { summary });
      if (!index) {
        await usageSettlement.failOnce();
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      // Same write unit as the update server action — DB+index, then the vault
      // .md mirror (without it the watcher reconciles the stale summary back
      // over the AI canon), embedding invalidation, and a scheduled re-embed.
      await applyKnowledgeEntryWrite({
        entryId,
        novelId,
        fields: { summary, updatedAt },
        index,
        context: 'summarize',
      });
    }
    await usageSettlement.recordOnce(usage);
  } catch (error) {
    await usageSettlement.failOnce();
    throw error;
  }

  return NextResponse.json({ summary });
}
