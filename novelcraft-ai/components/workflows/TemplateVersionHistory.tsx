'use client';

// TemplateVersionHistory (W3-2) — lists every version row for a
// (stage, role, variant), marks the active one, and lets the author activate
// (roll back to) any prior version. Rollback never deletes — it flips the
// `active` flag, so the full history stays intact.

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { TemplateRecord } from '@/app/actions/prompt-templates';
import type { WorkflowCopy } from '@/components/workflows/workflow-copy';

export interface TemplateVersionHistoryProps {
  copy: WorkflowCopy;
  /** All version rows for the selected (stage, role, variant), filtered to the
   *  active locale by the parent. */
  versions: TemplateRecord[];
  busy?: boolean;
  onActivate: (version: number) => void;
}

export function TemplateVersionHistory({ copy, versions, busy, onActivate }: TemplateVersionHistoryProps) {
  if (versions.length === 0) {
    return <p className="text-sm text-book-ink-muted">{copy.noHistory}</p>;
  }
  const sorted = [...versions].sort((a, b) => b.version - a.version);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-serif text-base font-semibold text-book-ink-primary">{copy.historyHeading}</h3>
      <ul className="flex flex-col gap-2">
        {sorted.map((v) => (
          <li
            key={v.id}
            className="flex items-center justify-between gap-3 rounded-md border border-book-border bg-book-bg-card px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-book-ink-primary">{copy.versionLabel(v.version)}</span>
                {v.active && <Badge variant="success">{copy.activeBadge}</Badge>}
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-book-ink-muted" title={v.templateText}>
                {v.templateText.slice(0, 80)}
                {v.templateText.length > 80 ? '…' : ''}
              </p>
            </div>
            {!v.active && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onActivate(v.version)}
                className="shrink-0"
              >
                {copy.activateAction}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
