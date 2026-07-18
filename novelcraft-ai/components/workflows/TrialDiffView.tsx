'use client';

// TrialDiffView (W3-2) — renders the dry-render comparison: the default
// variant's prompt next to the custom variant's prompt, with changed lines
// highlighted. Pure presentational; the parent owns the dryRender call.

import { useMemo } from 'react';
import type { WorkflowCopy } from '@/components/workflows/workflow-copy';

export interface TrialDiffViewProps {
  copy: WorkflowCopy;
  defaultText: string | null;
  variantText: string;
}

interface LineDiff {
  text: string;
  changed: boolean;
}

/** Cheap line-level diff: a line is "changed" when it has no exact-match line in
 *  the other side. Good enough to draw attention to where the variant diverges
 *  from the default without pulling in a diff library. */
function diffLines(a: string, b: string): { left: LineDiff[]; right: LineDiff[] } {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  return {
    left: aLines.map((text) => ({ text, changed: !bSet.has(text) })),
    right: bLines.map((text) => ({ text, changed: !aSet.has(text) })),
  };
}

function Column({ title, lines, side }: { title: string; lines: LineDiff[]; side: 'left' | 'right' }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-book-ink-muted">{title}</div>
      <pre className="min-h-[8rem] flex-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-book-border bg-book-bg-secondary p-3 font-mono text-xs leading-relaxed text-book-ink-primary">
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.changed
                ? side === 'right'
                  ? 'bg-book-success-light text-book-success'
                  : 'bg-book-danger-light text-book-danger'
                : undefined
            }
          >
            {line.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function TrialDiffView({ copy, defaultText, variantText }: TrialDiffViewProps) {
  const diff = useMemo(
    () => diffLines(defaultText ?? '', variantText),
    [defaultText, variantText],
  );

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Column title={copy.defaultColumn} lines={diff.left} side="left" />
      <Column title={copy.variantColumn} lines={diff.right} side="right" />
    </div>
  );
}
