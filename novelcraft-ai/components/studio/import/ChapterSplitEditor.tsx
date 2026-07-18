'use client';

// ChapterSplitEditor (W2-1) — preview + hand-correction of detected chapters.
//
// The deterministic detector is never the final word: this panel lets the
// author fix boundaries before anything is written. Per chapter you can:
//   - edit the title,
//   - merge a chapter UP into the previous one (wrong split),
//   - split a chapter at a chosen paragraph (missed boundary),
//   - in merge mode, pick the dedupe action (skip / overwrite / append).
//
// Auto-detected boundaries (inferred from bold lines / regex, not real heading
// styles) are badged so the user double-checks them. All edits are local state
// owned by the parent wizard via `onChange`; this component is presentational +
// edit-affordances only.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Scissors, ArrowUpToLine, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { renumberCandidates } from '@/lib/import/detect-chapters';
import type {
  ChapterCandidate,
  DedupeAction,
  DedupeResult,
} from '@/lib/import/types';
import type { ImportEditorCopy } from '@/components/studio/import/import-copy';

interface ChapterSplitEditorProps {
  candidates: ChapterCandidate[];
  onChange: (next: ChapterCandidate[]) => void;
  /** Merge mode: dedupe report keyed by candidate id + the chosen actions. */
  dedupe?: DedupeResult[];
  actions?: Record<string, DedupeAction>;
  onActionChange?: (candidateId: string, action: DedupeAction) => void;
  copy: ImportEditorCopy;
}

export function ChapterSplitEditor({
  candidates,
  onChange,
  dedupe,
  actions,
  onActionChange,
  copy,
}: ChapterSplitEditorProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const dedupeById = useMemo(() => {
    const m = new Map<string, DedupeResult>();
    for (const d of dedupe ?? []) m.set(d.candidateId, d);
    return m;
  }, [dedupe]);

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateTitle = (index: number, title: string) => {
    const next = candidates.map((c, i) => (i === index ? { ...c, title } : c));
    onChange(next);
  };

  const mergeUp = (index: number) => {
    if (index === 0) return;
    const next = [...candidates];
    const prev = next[index - 1];
    const cur = next[index];
    next[index - 1] = {
      ...prev,
      content: [prev.content, cur.content].filter(Boolean).join('\n\n'),
    };
    next.splice(index, 1);
    onChange(renumberCandidates(next));
  };

  const splitAt = (index: number, paragraphIndex: number) => {
    const cur = candidates[index];
    const paras = cur.content.split(/\n\n+/);
    if (paragraphIndex <= 0 || paragraphIndex >= paras.length) return;
    const head = paras.slice(0, paragraphIndex).join('\n\n');
    const tail = paras.slice(paragraphIndex).join('\n\n');
    const next = [...candidates];
    next[index] = { ...cur, content: head };
    next.splice(index + 1, 0, {
      ...cur,
      id: `${cur.id}-split`,
      title: '',
      content: tail,
      inferred: false,
    });
    onChange(renumberCandidates(next));
  };

  return (
    <div className="space-y-2">
      {candidates.map((cand, index) => {
        // A volume header renders above a chapter when its volume differs from
        // the previous chapter's — a pure function of the list (no render-time
        // mutation).
        const showVolume = index === 0 || candidates[index - 1].volumeTitle !== cand.volumeTitle;
        const isOpen = expanded.has(cand.id);
        const dd = dedupeById.get(cand.id);
        const action = actions?.[cand.id] ?? dd?.defaultAction;
        const paras = cand.content.split(/\n\n+/).filter(Boolean);

        return (
          <div key={cand.id}>
            {showVolume && cand.volumeTitle && (
              <div className="mt-3 mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-book-ink-muted">
                {cand.volumeTitle}
              </div>
            )}
            <div className="rounded-md border border-book-border bg-book-bg-card">
              <div className="flex items-center gap-2 px-3 py-2">
                <Button
                  variant="unstyled"
                  size="unstyled"
                  type="button"
                  onClick={() => toggle(cand.id)}
                  aria-label={isOpen ? copy.collapse : copy.expand}
                  className="shrink-0 text-book-ink-muted hover:text-book-ink-primary"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
                <span className="w-8 shrink-0 text-right font-mono text-xs text-book-ink-muted">
                  {cand.chapterNumber}
                </span>
                <Input
                  variant="boxed"
                  type="text"
                  value={cand.title}
                  onChange={e => updateTitle(index, e.target.value)}
                  placeholder={copy.titlePlaceholder(cand.chapterNumber)}
                  className="min-w-0 flex-1 text-sm"
                />
                {cand.inferred && (
                  <Badge variant="info" className="shrink-0">
                    <Sparkles className="h-3 w-3" />
                    {copy.autoDetected}
                  </Badge>
                )}
                {dd && (
                  <DedupeBadge status={dd.status} copy={copy} />
                )}
                <span className="shrink-0 font-mono text-xs text-book-ink-muted">
                  {copy.wordCount(cand.wordCount)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-book-border px-3 py-1.5">
                <Button
                  variant="unstyled"
                  size="unstyled"
                  type="button"
                  onClick={() => mergeUp(index)}
                  disabled={index === 0}
                  className="inline-flex items-center gap-1 rounded border border-book-border px-2 py-0.5 text-xs text-book-ink-secondary transition hover:bg-book-bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUpToLine className="h-3 w-3" />
                  {copy.mergeUp}
                </Button>
                {dd && onActionChange && action && (
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-xs text-book-ink-muted">{copy.onConflict}</span>
                    <Select
                      value={action}
                      onValueChange={(v) => onActionChange(cand.id, v as DedupeAction)}
                    >
                      <SelectTrigger variant="boxed" className="h-7 w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="skip">{copy.actionSkip}</SelectItem>
                        <SelectItem value="overwrite">{copy.actionOverwrite}</SelectItem>
                        <SelectItem value="append">{copy.actionAppend}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {isOpen && (
                <div className="space-y-1 border-t border-book-border px-3 py-2">
                  {dd?.matchedTitle && (
                    <p className="text-xs text-book-ink-muted">
                      {copy.matchedWith(dd.matchedChapterNumber ?? 0, dd.matchedTitle)}
                    </p>
                  )}
                  {paras.length === 0 && (
                    <p className="text-xs italic text-book-ink-muted">{copy.emptyChapter}</p>
                  )}
                  {paras.map((para, pIndex) => (
                    <div key={pIndex} className="group flex items-start gap-2">
                      {pIndex > 0 && (
                        <Button
                          variant="unstyled"
                          size="unstyled"
                          type="button"
                          onClick={() => splitAt(index, pIndex)}
                          aria-label={copy.splitHere}
                          title={copy.splitHere}
                          className="mt-0.5 shrink-0 text-book-ink-muted opacity-0 transition hover:text-book-gold group-hover:opacity-100"
                        >
                          <Scissors className="h-3 w-3" />
                        </Button>
                      )}
                      {pIndex === 0 && <span className="w-3 shrink-0" />}
                      <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs leading-relaxed text-book-ink-secondary">
                        {para.length > 280 ? `${para.slice(0, 280)}…` : para}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DedupeBadge({ status, copy }: { status: DedupeResult['status']; copy: ImportEditorCopy }) {
  if (status === 'duplicate') {
    return <Badge variant="muted" className="shrink-0">{copy.statusDuplicate}</Badge>;
  }
  if (status === 'conflict') {
    return <Badge variant="danger" className="shrink-0">{copy.statusConflict}</Badge>;
  }
  return <Badge variant="success" className="shrink-0">{copy.statusNew}</Badge>;
}
