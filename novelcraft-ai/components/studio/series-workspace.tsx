'use client';

// W3-3 series / shared worldbuilding — the series workspace surface.
//
// Self-contained client panel mounted at /desktop-studio/series/[id]. Fetches
// everything via the server actions in app/actions/series.ts (no API routes —
// desktop-only, local SQLite). Three tabs:
//   1. Books        — member list + add/remove (with anchor-transfer guard).
//   2. Shared       — shared knowledge browser; share/unshare, edit the
//                     canonical "main value" (confirms affected books), set a
//                     per-book override, and record per-book cross-book state.
//   3. Cross-book   — run the consistency checker; severity-graded report.
//
// Design-system only: components/ui/* primitives + --book-* tokens, no raw
// controls / palette classes / hardcoded colors. i18n is inline (see
// series-workspace-copy.ts).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookMarked,
  Users,
  Share2,
  AlertTriangle,
  RefreshCw,
  Plus,
  Trash2,
  Lock,
  Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLanguage } from '@/components/LanguageProvider';
import { seriesCopy, type SeriesCopy } from '@/components/studio/series-workspace-copy';
import {
  getSeriesDetail,
  listAddableNovels,
  listShareableEntries,
  addNovelToSeries,
  removeNovelFromSeries,
  shareKnowledgeEntry,
  unshareKnowledgeEntry,
  updateSharedEntryMainValue,
  setPerNovelOverride,
  setCrossBookState,
  runCrossBookCheck,
  type SeriesDetail,
  type CrossBookReport,
} from '@/app/actions/series';
import type { KnowledgeType } from '@/lib/types/knowledge';

type SharedEntry = SeriesDetail['sharedEntries'][number];

function typeLabel(t: SeriesCopy, type: KnowledgeType): string {
  switch (type) {
    case 'character': return t.typeCharacter;
    case 'world': return t.typeWorld;
    case 'timeline': return t.typeTimeline;
    case 'style_reference': return t.typeStyle;
    case 'outline': return t.typeOutline;
    default: return type;
  }
}

function describeEntry(entry: SharedEntry): string {
  const desc = entry.data['description'];
  if (typeof desc === 'string' && desc.trim()) return desc;
  return entry.summary;
}

export function SeriesWorkspace({ seriesId }: { seriesId: string }) {
  const { locale } = useLanguage();
  const t = useMemo(() => seriesCopy(locale), [locale]);

  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSeriesDetail(seriesId);
      setDetail(data);
    } catch {
      setError(t.loadError);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [seriesId, t.loadError]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const runMutation = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-book-ink-muted">
        <Spinner className="mr-2" />
        {t.refresh}…
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-book-ink-secondary">
        <AlertTriangle className="h-5 w-5 text-book-danger" aria-hidden />
        <p>{error ?? t.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>{t.retry}</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-book-ink-primary">
            <BookMarked className="h-5 w-5 text-book-gold" aria-hidden />
            {detail.series.title || t.title}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-book-ink-secondary">{t.subtitle}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t.refresh}
        </Button>
      </header>

      <Tabs defaultValue="members" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="members">
            <Users className="h-4 w-4" aria-hidden /> {t.tabMembers}
            <Badge variant="muted" className="ml-1">{detail.members.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="shared">
            <Share2 className="h-4 w-4" aria-hidden /> {t.tabShared}
            <Badge variant="muted" className="ml-1">{detail.sharedEntries.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="conflicts">
            <AlertTriangle className="h-4 w-4" aria-hidden /> {t.tabConflicts}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="min-h-0 flex-1 overflow-auto">
          <MembersTab detail={detail} t={t} busy={busy} seriesId={seriesId} runMutation={runMutation} />
        </TabsContent>
        <TabsContent value="shared" className="min-h-0 flex-1 overflow-auto">
          <SharedTab detail={detail} t={t} busy={busy} seriesId={seriesId} runMutation={runMutation} />
        </TabsContent>
        <TabsContent value="conflicts" className="min-h-0 flex-1 overflow-auto">
          <ConflictsTab seriesId={seriesId} t={t} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- Books tab -------------------------------------------------------------

function MembersTab({
  detail, t, busy, seriesId, runMutation,
}: {
  detail: SeriesDetail;
  t: SeriesCopy;
  busy: boolean;
  seriesId: string;
  runMutation: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addable, setAddable] = useState<{ id: string; title: string; currentSeriesId: string | null }[]>([]);
  const [picked, setPicked] = useState<string>('');
  const [removeTarget, setRemoveTarget] = useState<{ id: string; title: string } | null>(null);
  const [blocked, setBlocked] = useState<{ count: number } | null>(null);
  const [transferTo, setTransferTo] = useState<string>('');

  const openAdd = useCallback(async () => {
    const list = await listAddableNovels(seriesId);
    setAddable(list);
    setPicked(list[0]?.id ?? '');
    setAddOpen(true);
  }, [seriesId]);

  const pickedNovel = addable.find(n => n.id === picked);

  const onAdd = useCallback(async () => {
    if (!picked) return;
    setAddOpen(false);
    await runMutation(() => addNovelToSeries(seriesId, picked));
  }, [picked, seriesId, runMutation]);

  const onRemove = useCallback(async (member: { id: string; title: string }) => {
    const result = await removeNovelFromSeries(seriesId, member.id);
    if (result.ok === false) {
      setRemoveTarget(member);
      setBlocked({ count: result.sharedCount });
      setTransferTo('');
      return;
    }
    setRemoveTarget(null);
    setBlocked(null);
    // Refresh the member list after a clean removal (the failure path opens the
    // transfer dialog instead and must not refresh). Reuses runMutation's reload.
    await runMutation(async () => {});
  }, [seriesId, runMutation]);

  const onConfirmTransfer = useCallback(async () => {
    if (!removeTarget || !transferTo) return;
    await runMutation(async () => {
      await removeNovelFromSeries(seriesId, removeTarget.id, { transferToNovelId: transferTo });
    });
    setRemoveTarget(null);
    setBlocked(null);
  }, [removeTarget, transferTo, seriesId, runMutation]);

  const otherMembers = detail.members.filter(m => m.id !== removeTarget?.id);

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-book-ink-secondary">{t.members}</h2>
        <Button variant="book" size="sm" onClick={() => void openAdd()} disabled={busy}>
          <Plus className="h-4 w-4" aria-hidden /> {t.addNovel}
        </Button>
      </div>

      {detail.members.length === 0 ? (
        <p className="rounded-md border border-dashed border-book-border bg-book-bg-secondary p-6 text-center text-sm text-book-ink-muted">
          {t.noMembers}
        </p>
      ) : (
        <ul className="space-y-2">
          {detail.members.map(member => {
            const anchors = detail.sharedEntries.some(e => e.novelId === member.id);
            return (
              <li
                key={member.id}
                className="flex items-center justify-between rounded-md border border-book-border bg-book-bg-card px-4 py-3"
              >
                <span className="flex items-center gap-2 text-sm text-book-ink-primary">
                  <BookMarked className="h-4 w-4 text-book-ink-muted" aria-hidden />
                  {member.title}
                  {anchors && <Badge variant="gold">{t.anchor}</Badge>}
                </span>
                <Button
                  variant="danger-soft"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onRemove(member)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden /> {t.removeMember}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add-book dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.addNovel}</DialogTitle>
          </DialogHeader>
          {addable.length === 0 ? (
            <p className="text-sm text-book-ink-muted">{t.noMembers}</p>
          ) : (
            <div className="space-y-3">
              <Select value={picked} onValueChange={setPicked}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {addable.map(n => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.title}{n.currentSeriesId ? ` · ${t.alreadyInSeries}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {pickedNovel?.currentSeriesId && (
                <p className="flex items-center gap-2 rounded-md border border-book-warning-border bg-book-warning-light p-2 text-xs text-book-warning">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {t.movePrompt}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>{t.cancel}</Button>
            <Button variant="book" size="sm" disabled={!picked} onClick={() => void onAdd()}>{t.add}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Anchor-transfer-required dialog */}
      <Dialog
        open={blocked !== null}
        onOpenChange={(open) => { if (!open) { setBlocked(null); setRemoveTarget(null); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.removeBlockedTitle}</DialogTitle>
            <DialogDescription>
              {blocked ? t.removeBlockedBody(blocked.count) : ''}
            </DialogDescription>
          </DialogHeader>
          {otherMembers.length > 0 ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-book-ink-secondary">{t.transferTo}</label>
              <Select value={transferTo} onValueChange={setTransferTo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {otherMembers.map(m => (
                    <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-sm text-book-ink-muted">{t.noMembers}</p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setBlocked(null); setRemoveTarget(null); }}
            >
              {t.cancel}
            </Button>
            <Button
              variant="danger-soft"
              size="sm"
              disabled={!transferTo || busy}
              onClick={() => void onConfirmTransfer()}
            >
              {t.confirmRemove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- Shared tab ------------------------------------------------------------

function SharedTab({
  detail, t, busy, seriesId, runMutation,
}: {
  detail: SeriesDetail;
  t: SeriesCopy;
  busy: boolean;
  seriesId: string;
  runMutation: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [fromNovel, setFromNovel] = useState<string>('');
  const [shareable, setShareable] = useState<{ id: string; type: KnowledgeType; title: string; summary: string }[]>([]);
  const [pickedEntry, setPickedEntry] = useState<string>('');

  const [editing, setEditing] = useState<SharedEntry | null>(null);
  const [overriding, setOverriding] = useState<SharedEntry | null>(null);
  const [stating, setStating] = useState<SharedEntry | null>(null);

  const loadShareable = useCallback(async (novelId: string) => {
    if (!novelId) { setShareable([]); setPickedEntry(''); return; }
    const list = await listShareableEntries(seriesId, novelId);
    setShareable(list);
    setPickedEntry(list[0]?.id ?? '');
  }, [seriesId]);

  const openPromote = useCallback(async () => {
    const first = detail.members[0]?.id ?? '';
    setFromNovel(first);
    await loadShareable(first);
    setPromoteOpen(true);
  }, [detail.members, loadShareable]);

  const onPromote = useCallback(async () => {
    if (!pickedEntry) return;
    setPromoteOpen(false);
    await runMutation(() => shareKnowledgeEntry(seriesId, pickedEntry));
  }, [pickedEntry, seriesId, runMutation]);

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-book-ink-secondary">{t.sharedEntries}</h2>
        <Button
          variant="book"
          size="sm"
          disabled={busy || detail.members.length === 0}
          onClick={() => void openPromote()}
        >
          <Share2 className="h-4 w-4" aria-hidden /> {t.promote}
        </Button>
      </div>

      {detail.sharedEntries.length === 0 ? (
        <p className="rounded-md border border-dashed border-book-border bg-book-bg-secondary p-6 text-center text-sm text-book-ink-muted">
          {t.noShared}
        </p>
      ) : (
        <ul className="space-y-2">
          {detail.sharedEntries.map(entry => {
            const anchorTitle = detail.members.find(m => m.id === entry.novelId)?.title ?? '';
            const overrideCount = countOverrides(entry);
            const overrideRows = describeOverrides(entry, detail.members);
            return (
              <li key={entry.id} className="rounded-md border border-book-border bg-book-bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="info">{typeLabel(t, entry.type)}</Badge>
                      <span className="truncate text-sm font-medium text-book-ink-primary">{entry.title}</span>
                      {overrideCount > 0 && (
                        <Badge variant="gold">{t.perNovelOverride} · {overrideCount}</Badge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-book-ink-secondary">{describeEntry(entry)}</p>
                    {anchorTitle && (
                      <p className="mt-1 text-2xs text-book-ink-muted">{t.anchor}: {anchorTitle}</p>
                    )}
                    {overrideRows.length > 0 && (
                      <div className="mt-2 rounded-md border border-book-border bg-book-bg-secondary/60 px-3 py-2">
                        <p className="text-2xs font-semibold uppercase tracking-wider text-book-ink-muted">
                          {t.overrideDifferences}
                        </p>
                        <ul className="mt-1 space-y-1 text-xs text-book-ink-secondary">
                          {overrideRows.map(row => (
                            <li key={row.novelId}>
                              <span className="font-medium text-book-ink-primary">{row.novelTitle}:</span>{' '}
                              {row.description}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(entry)}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden /> {t.editMain}
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setOverriding(entry)}>
                      {t.perNovelOverride}
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setStating(entry)}>
                      {t.crossBookState}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void runMutation(() => unshareKnowledgeEntry(seriesId, entry.id))}
                    >
                      <Lock className="h-3.5 w-3.5" aria-hidden /> {t.unshare}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Promote dialog */}
      <Dialog open={promoteOpen} onOpenChange={setPromoteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.promoteTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-book-ink-secondary">{t.promoteFrom}</label>
              <Select value={fromNovel} onValueChange={(v) => { setFromNovel(v); void loadShareable(v); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {detail.members.map(m => (
                    <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {shareable.length === 0 ? (
              <p className="text-sm text-book-ink-muted">{t.noShareable}</p>
            ) : (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-book-ink-secondary">{t.promoteEntry}</label>
                <Select value={pickedEntry} onValueChange={setPickedEntry}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {shareable.map(e => (
                      <SelectItem key={e.id} value={e.id}>{typeLabel(t, e.type)} · {e.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPromoteOpen(false)}>{t.cancel}</Button>
            <Button variant="book" size="sm" disabled={!pickedEntry} onClick={() => void onPromote()}>{t.share}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editing && (
        <EditMainDialog
          entry={editing}
          members={detail.members}
          t={t}
          seriesId={seriesId}
          onClose={() => setEditing(null)}
          runMutation={runMutation}
        />
      )}
      {overriding && (
        <OverrideDialog
          entry={overriding}
          members={detail.members}
          t={t}
          seriesId={seriesId}
          onClose={() => setOverriding(null)}
          runMutation={runMutation}
        />
      )}
      {stating && (
        <CrossBookStateDialog
          entry={stating}
          members={detail.members}
          t={t}
          seriesId={seriesId}
          onClose={() => setStating(null)}
          runMutation={runMutation}
        />
      )}
    </div>
  );
}

function countOverrides(entry: SharedEntry): number {
  const ov = entry.data['perNovelOverrides'];
  if (ov && typeof ov === 'object' && !Array.isArray(ov)) return Object.keys(ov).length;
  return 0;
}

function describeOverrides(
  entry: SharedEntry,
  members: { id: string; title: string }[],
): { novelId: string; novelTitle: string; description: string }[] {
  const overrides = entry.data['perNovelOverrides'];
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return [];
  return Object.entries(overrides)
    .map(([novelId, patch]) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
      const description = (patch as Record<string, unknown>)['description'];
      if (typeof description !== 'string' || !description.trim()) return null;
      return {
        novelId,
        novelTitle: members.find(member => member.id === novelId)?.title ?? novelId,
        description: description.trim(),
      };
    })
    .filter((row): row is { novelId: string; novelTitle: string; description: string } => row !== null);
}

function EditMainDialog({
  entry, members, t, seriesId, onClose, runMutation,
}: {
  entry: SharedEntry;
  members: { id: string; title: string }[];
  t: SeriesCopy;
  seriesId: string;
  onClose: () => void;
  runMutation: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [description, setDescription] = useState<string>(
    typeof entry.data['description'] === 'string' ? (entry.data['description'] as string) : '',
  );
  const onSave = useCallback(async () => {
    onClose();
    await runMutation(() => updateSharedEntryMainValue(seriesId, entry.id, {
      data: { ...entry.data, description },
    }));
  }, [description, entry, seriesId, onClose, runMutation]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.editMainTitle}</DialogTitle>
          <DialogDescription className="flex items-center gap-2 text-book-warning">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {t.editMainWarn(members.length)}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs leading-relaxed text-book-ink-secondary">
          <span className="font-medium text-book-ink-primary">{t.affectedBooks}:</span>{' '}
          {members.map(member => member.title).join(' · ')}
        </p>
        <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{t.cancel}</Button>
          <Button variant="book" size="sm" onClick={() => void onSave()}>{t.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OverrideDialog({
  entry, members, t, seriesId, onClose, runMutation,
}: {
  entry: SharedEntry;
  members: { id: string; title: string }[];
  t: SeriesCopy;
  seriesId: string;
  onClose: () => void;
  runMutation: (fn: () => Promise<void>) => Promise<void>;
}) {
  // Outer dialog owns only the target-book picker; the form fields live in a
  // child keyed by `novelId` so switching books remounts the editor with fresh
  // initial state (no set-state-in-effect re-seeding).
  const [novelId, setNovelId] = useState<string>(members[0]?.id ?? '');
  const overrides = (entry.data['perNovelOverrides'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const seedValue = overrides[novelId]?.['description'];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.overrideTitle}</DialogTitle>
          <DialogDescription>{entry.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-book-ink-secondary">{t.overrideFor}</label>
            <Select value={novelId} onValueChange={setNovelId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {members.map(m => <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <OverrideEditor
            key={novelId}
            initial={typeof seedValue === 'string' ? seedValue : ''}
            label={t.overrideValue}
            clearLabel={t.clearOverride}
            saveLabel={t.save}
            onSave={(value) => {
              onClose();
              const patch = value.trim() ? { description: value } : null;
              void runMutation(() => setPerNovelOverride(seriesId, entry.id, novelId, patch));
            }}
            onClear={() => {
              onClose();
              void runMutation(() => setPerNovelOverride(seriesId, entry.id, novelId, null));
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OverrideEditor({
  initial, label, clearLabel, saveLabel, onSave, onClear,
}: {
  initial: string;
  label: string;
  clearLabel: string;
  saveLabel: string;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-book-ink-secondary">{label}</label>
        <Textarea rows={4} value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClear}>{clearLabel}</Button>
        <Button variant="book" size="sm" onClick={() => onSave(value)}>{saveLabel}</Button>
      </DialogFooter>
    </>
  );
}

function CrossBookStateDialog({
  entry, members, t, seriesId, onClose, runMutation,
}: {
  entry: SharedEntry;
  members: { id: string; title: string }[];
  t: SeriesCopy;
  seriesId: string;
  onClose: () => void;
  runMutation: (fn: () => Promise<void>) => Promise<void>;
}) {
  // Same keyed pattern as OverrideDialog: outer owns the book picker, the form
  // fields remount per book.
  const [novelId, setNovelId] = useState<string>(members[0]?.id ?? '');
  const bag = (entry.data['crossBookState'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const seed = bag[novelId] ?? {};

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.crossBookState}</DialogTitle>
          <DialogDescription>{entry.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-book-ink-secondary">{t.overrideFor}</label>
            <Select value={novelId} onValueChange={setNovelId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {members.map(m => <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <CrossBookStateEditor
            key={novelId}
            initialAge={stringField(seed['age'])}
            initialStatus={stringField(seed['status'])}
            initialDelta={stringField(seed['relationsDelta'])}
            t={t}
            onCancel={onClose}
            onSave={(age, status, delta) => {
              onClose();
              const ageNum = age.trim() && Number.isFinite(Number(age)) ? Number(age) : (age.trim() || undefined);
              const state = (age.trim() || status.trim() || delta.trim())
                ? {
                    ...(ageNum !== undefined ? { age: ageNum } : {}),
                    ...(status.trim() ? { status: status.trim() } : {}),
                    ...(delta.trim() ? { relationsDelta: delta.trim() } : {}),
                  }
                : null;
              void runMutation(() => setCrossBookState(seriesId, entry.id, novelId, state));
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CrossBookStateEditor({
  initialAge, initialStatus, initialDelta, t, onCancel, onSave,
}: {
  initialAge: string;
  initialStatus: string;
  initialDelta: string;
  t: SeriesCopy;
  onCancel: () => void;
  onSave: (age: string, status: string, delta: string) => void;
}) {
  const [age, setAge] = useState(initialAge);
  const [status, setStatus] = useState(initialStatus);
  const [delta, setDelta] = useState(initialDelta);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-book-ink-secondary">{t.age}</label>
          <Input value={age} onChange={(e) => setAge(e.target.value)} inputMode="numeric" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-book-ink-secondary">{t.status}</label>
          <Input value={status} onChange={(e) => setStatus(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-book-ink-secondary">{t.relationsDelta}</label>
        <Textarea rows={3} value={delta} onChange={(e) => setDelta(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t.cancel}</Button>
        <Button variant="book" size="sm" onClick={() => onSave(age, status, delta)}>{t.saveState}</Button>
      </DialogFooter>
    </>
  );
}

function stringField(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

// --- Cross-book tab --------------------------------------------------------

function ConflictsTab({ seriesId, t }: { seriesId: string; t: SeriesCopy }) {
  const [report, setReport] = useState<CrossBookReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      setReport(await runCrossBookCheck(seriesId));
    } finally {
      setRunning(false);
    }
  }, [seriesId]);

  const kindLabel = useCallback((kind: CrossBookReport['conflicts'][number]['kind']) => {
    switch (kind) {
      case 'age_regression': return t.conflictAge;
      case 'status_conflict': return t.conflictStatus;
      case 'relation_conflict': return t.conflictRelation;
      default: return kind;
    }
  }, [t]);
  const suggestion = useCallback((kind: CrossBookReport['conflicts'][number]['kind']) => {
    if (kind === 'age_regression') return t.ageSuggestion;
    if (kind === 'status_conflict') return t.statusSuggestion;
    return t.relationSuggestion;
  }, [t]);

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-book-ink-secondary">{t.conflicts}</h2>
        <Button variant="book" size="sm" disabled={running} onClick={() => void run()}>
          {running
            ? <Spinner />
            : <AlertTriangle className="h-4 w-4" aria-hidden />}
          {t.runCheck}
        </Button>
      </div>

      {report && (
        <p className="text-xs text-book-ink-muted">
          {t.conflictSummary(report.summary.total, report.summary.major, report.summary.minor)}
        </p>
      )}

      {report && report.conflicts.length === 0 ? (
        <p className="rounded-md border border-book-success-border bg-book-success-light p-4 text-center text-sm text-book-success">
          {t.noConflicts}
        </p>
      ) : (
        <ul className="space-y-2">
          {report?.conflicts.map((c, idx) => (
            <li
              key={`${c.entryId}-${idx}`}
              className="rounded-md border border-book-border bg-book-bg-card p-4"
            >
              <div className="flex items-center gap-2">
                <Badge variant={c.severity === 'major' ? 'danger' : 'muted'}>
                  {c.severity === 'major' ? t.major : t.minor}
                </Badge>
                <Badge variant="info">{kindLabel(c.kind)}</Badge>
                <span className="text-sm font-medium text-book-ink-primary">{c.entryTitle}</span>
              </div>
              <p className="mt-1 text-xs text-book-ink-secondary">{c.description}</p>
              <p className="mt-1 text-2xs text-book-ink-muted">
                {t.involves}: {c.novelIds.map(id => report.novelTitles[id] ?? id).join(' · ')}
              </p>
              <p className="mt-2 rounded-md border border-book-border bg-book-bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-book-ink-secondary">
                <span className="font-medium text-book-ink-primary">{t.suggestedFix}:</span>{' '}
                {suggestion(c.kind)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
