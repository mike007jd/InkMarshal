'use client';

import { Zap } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { EngineFormat, EngineInfo } from '@/lib/desktop-runtime';
import type { ModelProgress } from '@/lib/model-download-progress';
import { normalizeModelPathForCompare } from '@/lib/model-supply/orchestrator';

type UseState = 'idle' | 'starting' | 'running' | 'failed';

export interface EngineUseState {
  state: UseState;
  error?: string;
}

export function DownloadProgressBar({
  dlKey,
  progress,
  cancelKey,
  t,
}: {
  dlKey: string;
  progress: Record<string, ModelProgress>;
  cancelKey: (progressKey: string) => Promise<void>;
  t: ReturnType<typeof useLanguage>['t'];
}) {
  const item = progress[dlKey];
  if (!item || (item.state !== 'downloading' && item.state !== 'verifying')) return null;
  return (
    <div className="mt-2 space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-book-bg-secondary">
        <div
          className="motion-essential h-full rounded-full bg-book-gold transition-progress"
          style={{ width: `${item.percent ?? 8}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs-tight text-book-ink-muted">
          {item.label}
          {item.percent != null ? ` ${item.percent}%` : ''}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void cancelKey(dlKey)}>
          {t.modelManagerCancelDownload}
        </Button>
      </div>
    </div>
  );
}

export function UseModelButton({
  modelPath,
  fmt,
  label,
  useStates,
  runningByPath,
  desktop,
  startModel,
  t,
}: {
  modelPath: string;
  fmt: EngineFormat;
  label: string;
  useStates: Record<string, EngineUseState>;
  runningByPath: Map<string, EngineInfo[]>;
  desktop: boolean;
  startModel: (modelPath: string, fmt: EngineFormat, label: string) => void;
  t: ReturnType<typeof useLanguage>['t'];
}) {
  const state = useStates[modelPath]?.state ?? 'idle';
  const running = runningByPath.get(normalizeModelPathForCompare(modelPath))?.[0];
  if (running || state === 'running') {
    return <Badge variant="success">{t.modelManagerEngineRunning}</Badge>;
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={state === 'starting' || !desktop}
      onClick={() => startModel(modelPath, fmt, label)}
    >
      {state === 'starting' ? (
        <Spinner size="sm" />
      ) : (
        <Zap className="h-3.5 w-3.5" />
      )}
      {state === 'starting' ? t.modelManagerEngineStarting : t.modelManagerStartAndAssign}
    </Button>
  );
}
