import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 审计 2026-06-10:Threads 视图曾缺失未绑定模型警告,用户发消息无响应
// 且无解释。约束 ConversationThread 必须渲染 WritingModelStatusBar,
// 与 Brainstorm / Manuscript 的状态表达保持一致。
describe('ConversationThread model status', () => {
  it('renders WritingModelStatusBar like the other writing surfaces', () => {
    const src = readFileSync(
      join(process.cwd(), 'components/conversations/ConversationThread.tsx'),
      'utf8',
    );
    expect(src).toContain("from '@/components/WritingModelStatusBar'");
    expect(src).toContain('<WritingModelStatusBar');
    expect(src).toContain('operation="chat"');
  });
});
