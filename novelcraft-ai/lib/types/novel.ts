import { z } from 'zod';
import { MAX_TARGET_WORDS } from '@/lib/ai/types';

const novelTitleSchema = z.string().trim().min(1).max(200);
const novelGenreSchema = z.string().trim().max(100);
const novelTargetWordsSchema = z.number().int().min(1_000).max(MAX_TARGET_WORDS);
const novelInitialPromptSchema = z.string().trim().min(1).max(4000);
const novelOpeningAssistantMessageSchema = z.string().trim().min(1).max(4000);
const novelFirstChapterTitleSchema = z.string().trim().min(1).max(200);

export const createNovelRequestSchema = z.object({
  title: novelTitleSchema.optional(),
  genre: novelGenreSchema.optional(),
  targetWords: novelTargetWordsSchema.optional(),
  initialPrompt: novelInitialPromptSchema.optional(),
  openingAssistantMessage: novelOpeningAssistantMessageSchema.optional(),
  creationMode: z.literal('blank').optional(),
  firstChapterTitle: novelFirstChapterTitleSchema.optional(),
}).strict().superRefine((data, ctx) => {
  if (data.creationMode === 'blank') {
    if (!data.firstChapterTitle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['firstChapterTitle'],
        message: 'Blank novels require a first chapter title',
      });
    }
    if (data.initialPrompt || data.openingAssistantMessage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['creationMode'],
        message: 'Blank novels cannot include an opening message',
      });
    }
  } else if (data.firstChapterTitle) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['firstChapterTitle'],
      message: 'A first chapter title is only valid for blank novels',
    });
  }
});

export const updateNovelRequestSchema = z.object({
  title: novelTitleSchema.optional(),
  genre: novelGenreSchema.optional(),
  targetWords: novelTargetWordsSchema.optional(),
}).strict();

export type CreateNovelRequest = z.infer<typeof createNovelRequestSchema>;
export type UpdateNovelRequest = z.infer<typeof updateNovelRequestSchema>;
