'use client';

import { Check, X, AlertTriangle } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import type { ChangeItem } from '@/lib/diff-utils';

interface DiffConfirmCardProps {
  changes: ChangeItem[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}

export function DiffConfirmCard({ changes, onAccept, onReject, onAcceptAll, onRejectAll }: DiffConfirmCardProps) {
  const { t } = useLanguage();
  const pendingCount = changes.filter(c => c.status === 'pending').length;

  if (changes.length === 0) return null;

  return (
    <div className="border border-book-gold/30 rounded-lg bg-book-bg-card overflow-hidden">
      <div className="px-4 py-2 border-b border-book-gold/20 flex items-center justify-between">
        <span className="text-xs font-semibold text-book-gold">
          {t.aiSuggestions} — {t.nChanges.replace('{n}', String(changes.length))}
        </span>
      </div>

      <div className="max-h-60 overflow-y-auto divide-y divide-book-border">
        {changes.map((change) => (
          <div key={change.id} className={`p-3 ${change.status !== 'pending' ? 'opacity-50' : ''}`}>
            {change.location === null && (
              <div className="mb-1 flex items-center gap-1 text-2xs text-book-warning">
                <AlertTriangle className="h-3 w-3" />
                {t.cannotLocate}
              </div>
            )}
            <div className="text-xs leading-relaxed font-serif space-y-1">
              <div className="text-book-danger/80 line-through">{change.original}</div>
              <div className="text-book-success/80">{change.replacement}</div>
            </div>
            {change.status === 'pending' && (
              <div className="flex gap-2 mt-2 justify-end">
                <Button
                  variant="success-soft"
                  size="sm"
                  type="button"
                  onClick={() => onAccept(change.id)}
                  disabled={change.location === null}
                >
                  <Check className="h-3 w-3" /> {t.acceptChange}
                </Button>
                <Button
                  variant="danger-soft"
                  size="sm"
                  type="button"
                  onClick={() => onReject(change.id)}
                >
                  <X className="h-3 w-3" /> {t.rejectChange}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {pendingCount > 0 && (
        <div className="px-4 py-2 border-t border-book-border flex gap-2 justify-end">
          <Button variant="success-soft" size="sm" type="button" onClick={onAcceptAll}>
            {t.acceptAll}
          </Button>
          <Button variant="danger-soft" size="sm" type="button" onClick={onRejectAll}>
            {t.rejectAll}
          </Button>
        </div>
      )}
    </div>
  );
}
