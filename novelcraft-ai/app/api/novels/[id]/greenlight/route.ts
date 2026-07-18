import { NextResponse } from 'next/server';
import { getMessages, promoteGreenlightDraftWithMessage } from '@/lib/db';
import { generateGreenlightPack } from '@/lib/ai';
import { GreenlightPackSchema } from '@/lib/ai/types';
import { isZhLocale } from '@/lib/i18n';
import { detectLanguage, sanitizeError } from '@/lib/utils';
import { requireNovelOwner } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIUsageSession } from '@/lib/ai-usage';
import { getInterviewState } from '@/lib/interview-state-server';
import type { ChatMessage } from '@/lib/ai/types';
import type { InterviewState } from '@/lib/interview-state';

export const runtime = 'nodejs';
export const maxDuration = 120;

export function interviewStateToGreenlightHistory(state: InterviewState): ChatMessage[] {
  const profileText = Object.entries(state.collectedProfile)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => `${key}: ${value.trim()}`)
    .join('\n');
  return [
    {
      role: 'user',
      content: [
        'Guided interview profile:',
        profileText || '(empty)',
        state.proposalSummary ? `Proposal summary:\n${state.proposalSummary}` : null,
      ].filter(Boolean).join('\n\n'),
    },
  ];
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user, novel } = ownerCheck;

  if (novel.stage === 'ready_for_greenlight') {
    return NextResponse.json(novel);
  }
  if (novel.stage !== 'discovery_interview') {
    return NextResponse.json(
      { error: 'Greenlight can only be generated before writing starts.' },
      { status: 409 },
    );
  }
  const interviewState = await getInterviewState(id);
  if (interviewState?.mode !== 'proposal_review') {
    return NextResponse.json(
      { error: 'Build the story direction in Agent before generating the outline-ready pack.' },
      { status: 409 },
    );
  }

  try {
    const messages = await getMessages(id);
    const aiUsage = await createAIUsageSession(request, { userId: user.id, operation: 'outline' });
    const history = interviewStateToGreenlightHistory(interviewState);
    aiUsage.addPromptText(JSON.stringify({ novel, history }));

    let usageSettled = false;
    const failUsageOnce = async () => {
      if (!usageSettled) {
        usageSettled = true;
        await aiUsage.fail();
      }
    };
    const cancelUsageOnce = async () => {
      if (!usageSettled) {
        usageSettled = true;
        await aiUsage.cancel();
      }
    };
    try {
      const result = await generateGreenlightPack({
        model: aiUsage.model,
        novelContext: novel,
        history,
        signal: request.signal,
      });
      const pack = GreenlightPackSchema.parse(result.pack);
      aiUsage.addPartialOutput(JSON.stringify(pack));
      if (request.signal.aborted) {
        await cancelUsageOnce();
        return new Response(null, { status: 499 });
      }

      const language = detectLanguage([
        ...Object.values(interviewState.collectedProfile),
        interviewState.proposalSummary ?? '',
      ]);
      const confirmMsg = isZhLocale(language)
        ? `我已根据我们的对话梳理出创作大纲。请在右侧「创作桌面」查看故事核心、人物小传和剧情推演。如果大纲符合你的设想，点击「大纲无误，开始动笔」，我将全力代笔，完成整本小说。`
        : `I've generated a Writing Plan based on our conversation. Please review the Story Summary, Character Profiles, and Plot Arc in the Writer Desk tab. If everything looks good, click "Approve & Begin Writing" to start the autonomous writing process!`;
      const promoted = await promoteGreenlightDraftWithMessage(
        id,
        novel,
        messages.map(message => message.id),
        {
          title: pack.title || novel.title,
          genre: pack.genre || novel.genre,
          storySummary: pack.storySummary || novel.storySummary,
          characterSummary: pack.characterSummary || novel.characterSummary,
          arcSummary: pack.arcSummary || novel.arcSummary,
        },
        confirmMsg,
      );
      if (!promoted.ok) {
        await failUsageOnce();
        const notFound = promoted.reason === 'not_found';
        return NextResponse.json(
          { error: notFound ? 'Novel not found' : 'Interview changed while generating the writing plan. Please try again.' },
          { status: notFound ? 404 : 409 },
        );
      }

      await aiUsage.recordUsage(result.usage);
      usageSettled = true;
      return NextResponse.json(promoted.novel);
    } catch (error) {
      if (request.signal.aborted) await cancelUsageOnce();
      else await failUsageOnce();
      throw error;
    }
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) return response;
    console.error('Error generating greenlight pack:', error);
    return NextResponse.json({ error: sanitizeError(error, 'Failed to generate greenlight pack') }, { status: 500 });
  }
}
