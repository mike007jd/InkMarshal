import { z } from 'zod';

export const CONVERSATION_TOPICS = ['plot', 'characters', 'worldbuilding', 'chapter_editing', 'general'] as const;

export const createConversationSchema = z.object({
  topic: z.enum(CONVERSATION_TOPICS).default('general'),
  title: z.string().min(1).max(200),
  parentMessageId: z.string().min(1).max(128).nullable().default(null),
});

export const updateConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  isArchived: z.boolean().optional(),
}).strict();

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export interface Conversation {
  id: string;
  novelId: string;
  userId: string;
  topic: string;
  title: string;
  parentMessageId: string | null;
  isArchived: boolean;
  createdAt: number;
  updatedAt: number;
}
