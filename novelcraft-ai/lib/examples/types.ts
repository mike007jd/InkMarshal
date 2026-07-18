import type { Novel, Chapter, Message, NovelBlueprint } from '@/lib/db-types';
import { countWords } from '@/lib/utils';

export interface ExampleCharacter {
  name: string;
  role: string;
  description: string;
}

export interface ExampleConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ExampleNovel {
  /** Slug used in /examples/[slug] URLs and as the synthetic novel id. */
  slug: string;
  /** Public-facing novel record, mirroring the Novel shape from /lib/db. */
  novel: Novel;
  /** Marketing pitch shown on the example card / studio shelf. */
  pitch: string;
  /** Persona-style "where this draft is in its lifecycle" line. */
  stageBlurb: string;
  /** Optional outline blueprint when the chapter map has been generated. */
  blueprint?: NovelBlueprint;
  /** Concrete chapters — may be partial when stage is mid-writing. */
  chapters: Chapter[];
  /** Brainstorm transcript snippets surfaced in the example "chat" view. */
  conversation: ExampleConversationTurn[];
  /** Character cards. */
  characters: ExampleCharacter[];
  /** Free-form world / lore notes. */
  worldNotes: string[];
}

const EXAMPLE_USER_ID = 'visitor-example';

export function makeNovel(partial: Partial<Novel> & {
  id: string;
  title: string;
  genre: string;
  stage: Novel['stage'];
  progress: number;
  storySummary: string;
  characterSummary: string;
  arcSummary: string;
}): Novel {
  return {
    userId: EXAMPLE_USER_ID,
    targetWords: 80000,
    interviewState: null,
    blueprint: null,
    writingLockToken: null,
    writingLockExpiresAt: null,
    unificationReport: null,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
    updatedAt: Date.now() - 1000 * 60 * 60,
    ...partial,
  };
}

export function makeChapter(partial: Partial<Chapter> & {
  novelId: string;
  chapterNumber: number;
  title: string;
  content: string;
}): Chapter {
  return {
    id: `${partial.novelId}-ch-${partial.chapterNumber}`,
    originalContent: null,
    wordCount: countWords(partial.content),
    version: 1,
    summary: '',
    keyFacts: null,
    qualityIssues: null,
    generationMeta: null,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * (12 - partial.chapterNumber),
    ...partial,
  };
}

export function makeMessage(novelId: string, idx: number, role: Message['role'], content: string): Message {
  return {
    id: `${novelId}-msg-${idx}`,
    novelId,
    role,
    content,
    conversationId: null,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 5 + idx * 60_000,
  };
}
