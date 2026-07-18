import { NextResponse } from 'next/server';
import { createBlankNovel, createNovel, createNovelWithOpeningMessage, getActiveNovels } from '@/lib/db';
import { getUser, requireLocalUser } from '@/lib/local-auth';
import { safeParseJson, sanitizeError } from '@/lib/utils';
import { createNovelRequestSchema } from '@/lib/types/novel';

export async function GET() {
  const user = await getUser();
  const novels = await getActiveNovels(user.id);
  return NextResponse.json(novels);
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
    console.error('createNovel failed:', error);
    return NextResponse.json({ error: sanitizeError(error, 'Failed to create novel') }, { status: 400 });
  }
}
