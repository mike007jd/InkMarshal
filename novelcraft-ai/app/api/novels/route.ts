import { NextResponse } from 'next/server';
import { createBlankNovel, createNovel, createNovelWithOpeningMessage, getActiveNovels } from '@/lib/db';
import { mapLocalDatabaseApiError } from '@/lib/db/migrations';
import { getUser, requireLocalUser } from '@/lib/local-auth';
import { safeParseJson, sanitizeError } from '@/lib/utils';
import { createNovelRequestSchema } from '@/lib/types/novel';

export async function GET() {
  // Keep the desktop session / production-web wall outside the DB mapper so
  // auth notFound() responses are never rewritten as database failures.
  const user = await getUser();
  try {
    const novels = await getActiveNovels(user.id);
    return NextResponse.json(novels);
  } catch (error) {
    const mapped = mapLocalDatabaseApiError(error);
    if (mapped) {
      return NextResponse.json({ error: mapped.error, code: mapped.code }, { status: mapped.status });
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const { user } = await requireLocalUser();

  try {
    const parsed = await safeParseJson<unknown>(request);
    if (parsed.error) return parsed.error;
    const body = createNovelRequestSchema.parse(parsed.data);
    const {
      creationMode,
      firstChapterTitle,
      initialPrompt,
      openingAssistantMessage,
      ...novelInput
    } = body;
    const novel = creationMode === 'blank'
      ? await createBlankNovel({
          ...novelInput,
          userId: user.id,
          firstChapterTitle: firstChapterTitle!,
        })
      : openingAssistantMessage
      ? await createNovelWithOpeningMessage({
          ...novelInput,
          userId: user.id,
          openingMessage: openingAssistantMessage,
          openingMessageRole: 'assistant',
        })
      : initialPrompt
      ? await createNovelWithOpeningMessage({
          ...novelInput,
          userId: user.id,
          openingMessage: initialPrompt,
        })
      : await createNovel({ ...novelInput, userId: user.id });
    return NextResponse.json(novel, { status: 201 });
  } catch (error) {
    const mapped = mapLocalDatabaseApiError(error);
    if (mapped) {
      return NextResponse.json({ error: mapped.error, code: mapped.code }, { status: mapped.status });
    }
    console.error('createNovel failed:', error);
    return NextResponse.json({ error: sanitizeError(error, 'Failed to create novel') }, { status: 400 });
  }
}
