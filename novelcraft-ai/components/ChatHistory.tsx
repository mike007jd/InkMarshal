'use client';

import { useRef, useEffect } from 'react';
import { Sparkles, User } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  changesCount?: number;
}

interface ChatHistoryProps {
  messages: ChatMessage[];
}

export function ChatHistory({ messages }: ChatHistoryProps) {
  const { t } = useLanguage();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (messages.length === 0) return null;

  return (
    <div className="max-h-40 overflow-y-auto px-3 py-2 space-y-2 border-t border-book-border bg-book-bg-secondary/50">
      {messages.map((msg) => (
        <div key={msg.id} className={`flex gap-2 text-xs ${msg.role === 'user' ? 'justify-end' : ''}`}>
          {msg.role === 'assistant' && (
            <div className="shrink-0 w-5 h-5 rounded-full bg-book-gold/10 flex items-center justify-center">
              <Sparkles className="h-3 w-3 text-book-gold" />
            </div>
          )}
          <div className={`max-w-[80%] rounded-lg px-3 py-1.5 ${
            msg.role === 'user'
              ? 'bg-book-gold/10 text-book-ink-primary'
              : 'bg-book-bg-card text-book-ink-secondary border border-book-border'
          }`}>
            <p className="font-serif whitespace-pre-wrap break-words">{msg.content}</p>
            {msg.changesCount !== undefined && (
              <span className="text-2xs text-book-ink-muted mt-0.5 block">
                {(t.nChanges || '{n} changes').replace('{n}', String(msg.changesCount))}
              </span>
            )}
          </div>
          {msg.role === 'user' && (
            <div className="shrink-0 w-5 h-5 rounded-full bg-book-bg-secondary flex items-center justify-center border border-book-border">
              <User className="h-3 w-3 text-book-ink-muted" />
            </div>
          )}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
