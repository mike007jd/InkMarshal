'use client';

// WorkflowStudioSurface (W3-2) — the "creation style console".
//
// Layout: a left rail listing every workflow (stage × role) with its variant
// list and a clone action; a right pane with six tabs:
//   1. Variables   — the structured form (VariableSchemaForm) + save/publish
//   2. Versions    — version history + activate/rollback
//   3. Trial run   — dry-render diff (default vs variant) + opt-in model run
//   4. Model binding — embeds the shared CapabilityBindingPanel
//   5. Genre packs — apply a curated style variant to a novel
//   6. Import/Export — variant pack JSON round-trip + global default
//
// Self-contained: all transient state lives here; the server actions are pure
// round-trips. i18n is the inline `workflowCopy` table (shared bundle untouched).
//
// Mount point: /desktop-studio/workflows (page is a thin force-static shell,
// mirroring app/desktop-studio/models/page.tsx).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Wand2 } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CapabilityBindingPanel } from '@/components/CapabilityBindingPanel';
import { VariableSchemaForm } from '@/components/workflows/VariableSchemaForm';
import { TemplateVersionHistory } from '@/components/workflows/TemplateVersionHistory';
import { TrialDiffView } from '@/components/workflows/TrialDiffView';
import { workflowCopy } from '@/components/workflows/workflow-copy';
import { stageLabel } from '@/lib/prompt-stage-labels';
import { isTauriRuntime, readLocalFile } from '@/lib/desktop-runtime';
import { saveBlob } from '@/lib/download';
import { buildModelHeaders } from '@/lib/streaming-client';
import { getSettings, saveSettings } from '@/lib/settings';
import {
  listTemplateGroups,
  listVariants,
  getTemplate,
  listVersions,
  cloneAsVariant,
  saveVariantDraft,
  publishNewVersion,
  setActive,
  deleteVariant,
  novelsReferencingVariant,
  exportVariantPack,
  importVariantPackFromBase64,
  listGenrePackInfos,
  applyGenrePackToNovel,
  listNovelsForWorkflows,
  type TemplateGroup,
  type TemplateRecord,
  type GenrePackInfo,
  type NovelPick,
} from '@/app/actions/prompt-templates';
import { dryRender, runTrial, type DryRenderResult, type RunTrialResult } from '@/app/actions/prompt-trial';
import type { Locale } from '@/lib/i18n';

const VARIANT_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const LOCALES: Locale[] = ['en', 'zh-CN', 'zh-TW'];

// Stage → AI operation, mirrored from the trial action, so the client can build
// the right capability headers for a real trial run.
const STAGE_OPERATION: Record<string, Parameters<typeof buildModelHeaders>[0]> = {
  greenlight_pack: 'outline',
  book_blueprint: 'outline',
  chapter_write: 'chapter',
  chapter_continuation: 'chapter',
  chapter_summarize: 'summarize',
  chapter_validate: 'validate',
  unification: 'unify',
  chapter_edit: 'polish',
  interview_system: 'chat',
  chapter_ralph_revise: 'polish',
};

type TabKey = 'form' | 'history' | 'trial' | 'binding' | 'packs' | 'io';

interface Selection {
  stage: string;
  role: 'user' | 'system';
  variant: string;
}

export function WorkflowStudioSurface() {
  const { locale, t } = useLanguage();
  const { toast } = useToast();
  const copy = useMemo(() => workflowCopy(locale), [locale]);

  const [groups, setGroups] = useState<TemplateGroup[]>([]);
  const [allVariants, setAllVariants] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('form');
  const [editLocale, setEditLocale] = useState<Locale>(locale);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Editing state for the current (stage, role, variant, locale).
  const [record, setRecord] = useState<TemplateRecord | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftSchema, setDraftSchema] = useState('{}');
  const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<TemplateRecord[]>([]);

  // Trial state.
  const [trial, setTrial] = useState<DryRenderResult | null>(null);
  const [trialOutput, setTrialOutput] = useState<RunTrialResult | null>(null);
  const [trialRunning, setTrialRunning] = useState(false);

  // Genre packs / novel picker.
  const [packs, setPacks] = useState<GenrePackInfo[]>([]);
  const [novels, setNovels] = useState<NovelPick[]>([]);
  const [selectedNovelId, setSelectedNovelId] = useState<string>('');

  // Clone dialog.
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [cloneError, setCloneError] = useState('');

  // Global default variant.
  const [globalDefault, setGlobalDefault] = useState<string>('');
  const [developerToolsEnabled, setDeveloperToolsEnabled] = useState(
    () => Boolean(getSettings().developerTools),
  );

  const isDefault = selection?.variant === 'default';

  // ── initial load ───────────────────────────────────────────────────────────
  const reloadGroups = useCallback(async () => {
    const [g, v] = await Promise.all([listTemplateGroups(), listVariants()]);
    setGroups(g);
    setAllVariants(v);
    return g;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const g = await reloadGroups();
        if (cancelled) return;
        if (g.length > 0 && !selection) {
          const first = g[0];
          setSelection({ stage: first.stage, role: first.role, variant: 'default' });
        }
        const [p, n] = await Promise.all([listGenrePackInfos(), listNovelsForWorkflows()]);
        if (cancelled) return;
        setPacks(p);
        setNovels(n);
        if (n.length > 0) setSelectedNovelId(n[0].id);
        setGlobalDefault(getSettings().defaultPromptVariant ?? '');
      } catch {
        if (!cancelled) toast(copy.errorToast, 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── load the selected coordinate ─────────────────────────────────────────────
  const loadSelection = useCallback(
    async (sel: Selection, loc: Locale) => {
      setBusy(true);
      try {
        const [rec, vers] = await Promise.all([
          getTemplate(sel.stage, sel.role, sel.variant, loc),
          listVersions(sel.stage, sel.role, sel.variant),
        ]);
        setRecord(rec);
        setDraftText(rec?.templateText ?? '');
        setDraftSchema(rec?.variablesSchema ?? '{}');
        setVersions(vers.filter((v) => v.locale === loc));
        setTrial(null);
        setTrialOutput(null);
      } catch {
        toast(copy.errorToast, 'error');
      } finally {
        setBusy(false);
      }
    },
    [copy, toast],
  );

  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    // Defer off the synchronous effect phase (loadSelection sets state before
    // its first await) — matches the queueMicrotask pattern used elsewhere.
    queueMicrotask(() => {
      if (!cancelled) void loadSelection(selection, editLocale);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, editLocale]);

  // ── derived: variant list for the selected (stage, role) ─────────────────────
  const variantsForSelection = useMemo(() => {
    if (!selection) return ['default'];
    const g = groups.find((x) => x.stage === selection.stage && x.role === selection.role);
    return g?.variants ?? ['default'];
  }, [groups, selection]);

  // ── actions ──────────────────────────────────────────────────────────────────
  const handleSelectWorkflow = (stage: string, role: 'user' | 'system') => {
    setSelection({ stage, role, variant: 'default' });
    setActiveTab('form');
  };

  const handleSelectVariant = (variant: string) => {
    if (selection) setSelection({ ...selection, variant });
  };

  const openClone = () => {
    setCloneName('');
    setCloneError('');
    setCloneOpen(true);
  };

  const confirmClone = async () => {
    if (!selection) return;
    const name = cloneName.trim();
    if (!VARIANT_RE.test(name) || name === 'default') {
      setCloneError(copy.cloneInvalidName);
      return;
    }
    setBusy(true);
    try {
      await cloneAsVariant(selection.stage, selection.role, name);
      await reloadGroups();
      setAllVariants(await listVariants());
      setCloneOpen(false);
      setSelection({ ...selection, variant: name });
    } catch (e) {
      setCloneError(e instanceof Error && /exists/i.test(e.message) ? copy.cloneExists : copy.errorToast);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!selection || isDefault) return;
    setBusy(true);
    try {
      await saveVariantDraft({
        stage: selection.stage,
        role: selection.role,
        locale: editLocale,
        variant: selection.variant,
        templateText: draftText,
        variablesSchema: draftSchema,
      });
      toast(copy.savedToast, 'success');
      await loadSelection(selection, editLocale);
    } catch (e) {
      toast(e instanceof Error ? e.message : copy.errorToast, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (!selection || isDefault) return;
    setBusy(true);
    try {
      await publishNewVersion({
        stage: selection.stage,
        role: selection.role,
        locale: editLocale,
        variant: selection.variant,
        templateText: draftText,
        variablesSchema: draftSchema,
      });
      toast(copy.publishedToast, 'success');
      await loadSelection(selection, editLocale);
    } catch (e) {
      toast(e instanceof Error ? e.message : copy.errorToast, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async (version: number) => {
    if (!selection) return;
    setBusy(true);
    try {
      await setActive({
        stage: selection.stage,
        role: selection.role,
        locale: editLocale,
        variant: selection.variant,
        version,
      });
      toast(copy.rollbackToast, 'success');
      await loadSelection(selection, editLocale);
    } catch {
      toast(copy.errorToast, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteVariant = async () => {
    if (!selection || isDefault) return;
    const refs = await novelsReferencingVariant(selection.variant);
    if (refs.length > 0) {
      toast(copy.deleteBlocked(refs.length), 'error');
      return;
    }
    if (!window.confirm(copy.deleteConfirm(selection.variant))) return;
    setBusy(true);
    try {
      await deleteVariant(selection.variant);
      toast(copy.deletedToast, 'success');
      await reloadGroups();
      setAllVariants(await listVariants());
      setSelection({ ...selection, variant: 'default' });
    } catch (e) {
      toast(e instanceof Error ? e.message : copy.errorToast, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDryRender = async () => {
    if (!selection) return;
    setBusy(true);
    try {
      const result = await dryRender({
        stage: selection.stage,
        role: selection.role,
        locale: editLocale,
        variant: selection.variant,
        sampleVars: sampleValues,
      });
      setTrial(result);
      setTrialOutput(null);
    } catch {
      toast(copy.errorToast, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRealRun = async () => {
    if (!selection) return;
    setTrialRunning(true);
    setTrialOutput(null);
    try {
      const operation = STAGE_OPERATION[selection.stage] ?? 'chapter';
      const modelHeaders = await buildModelHeaders(operation);
      const result = await runTrial({
        stage: selection.stage,
        role: selection.role,
        locale: editLocale,
        variant: selection.variant,
        sampleVars: sampleValues,
        modelHeaders,
      });
      setTrialOutput(result);
      if (!result.ok && result.error) toast(result.error, 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : copy.errorToast, 'error');
    } finally {
      setTrialRunning(false);
    }
  };

  const handleApplyPack = async (packId: string) => {
    if (!selectedNovelId) {
      toast(copy.packNeedsNovel, 'info');
      return;
    }
    setBusy(true);
    try {
      await applyGenrePackToNovel(selectedNovelId, packId);
      toast(copy.packAppliedToast, 'success');
      await reloadGroups();
      setAllVariants(await listVariants());
      setNovels(await listNovelsForWorkflows());
    } catch (e) {
      toast(e instanceof Error ? e.message : copy.errorToast, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    if (!selection || isDefault) return;
    setBusy(true);
    try {
      const json = await exportVariantPack(selection.variant);
      const blob = new Blob([json], { type: 'application/json' });
      await saveBlob(blob, `template-pack-${selection.variant}.json`);
      toast(copy.exportedToast, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : copy.errorToast, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!isTauriRuntime()) {
      toast(copy.importNeedsDesktop, 'info');
      return;
    }
    setBusy(true);
    try {
      const picked = await readLocalFile(['json']);
      if (!picked) return;
      const result = await importVariantPackFromBase64(picked.contentsBase64);
      toast(copy.importedToast(result.inserted), 'success');
      await reloadGroups();
      setAllVariants(await listVariants());
    } catch {
      toast(copy.importFailed, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveGlobalDefault = (value: string) => {
    const next = value === '__default__' ? '' : value;
    setGlobalDefault(next);
    saveSettings({ defaultPromptVariant: next || undefined });
    toast(copy.globalDefaultSaved, 'success');
  };

  // ── render ───────────────────────────────────────────────────────────────────
  if (!developerToolsEnabled) {
    return (
      <div className="flex h-full items-center justify-center bg-book-bg-primary px-6 text-book-ink-primary">
        <div className="max-w-lg rounded-xl border border-book-border bg-book-bg-card p-6 text-center shadow-sm">
          <h1 className="font-serif text-xl font-semibold">{t.developerToolsTitle}</h1>
          <p className="mt-2 text-sm leading-relaxed text-book-ink-secondary">
            {t.developerToolsWorkflowDescription}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              saveSettings({ developerTools: true });
              window.dispatchEvent(new Event('inkmarshal:settings-changed'));
              setDeveloperToolsEnabled(true);
            }}
            className="mt-4"
          >
            {t.developerToolsEnable}
          </Button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-book-ink-muted">
        <Spinner size="lg" className="mr-2" />
        {copy.loading}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-book-bg-primary text-book-ink-primary">
      <header className="border-b border-book-border px-5 py-4">
        <h1 className="font-serif text-lg font-semibold">{copy.title}</h1>
        <p className="mt-1 text-sm text-book-ink-muted">{copy.subtitle}</p>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left rail: workflow tree */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-book-border bg-book-bg-sidebar">
          <div className="px-4 py-3 font-serif text-xs font-bold uppercase tracking-widest text-book-ink-muted">
            {copy.workflowsHeading}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-0.5 px-2 pb-4">
              {groups.map((g) => {
                const sel = selection?.stage === g.stage && selection?.role === g.role;
                return (
                  <li key={`${g.stage}::${g.role}`}>
                    <Button
                      variant="ghost"
                      onClick={() => handleSelectWorkflow(g.stage, g.role)}
                      className={`flex h-auto w-full flex-col items-start gap-0.5 border-l-2 px-3 py-2 text-left text-sm font-normal transition-colors ${
                        sel
                          ? 'border-book-gold bg-book-bg-card text-book-ink-primary'
                          : 'border-transparent text-book-ink-secondary hover:bg-book-bg-secondary'
                      }`}
                    >
                      <span className="font-medium">{stageLabel(g.stage, locale)}</span>
                      <span className="flex items-center gap-1.5 text-xs text-book-ink-muted">
                        <Badge variant={g.role === 'system' ? 'muted' : 'info'}>{g.role}</Badge>
                        {g.variants.length > 1 && (
                          <span>
                            {g.variants.length - 1} {copy.variantsLabel.toLowerCase()}
                          </span>
                        )}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        </aside>

        {/* Right pane */}
        <section className="flex min-w-0 flex-1 flex-col">
          {selection && (
            <>
              {/* Variant selector bar */}
              <div className="flex flex-wrap items-center gap-2 border-b border-book-border px-5 py-3">
                <span className="text-sm font-medium text-book-ink-secondary">
                  {stageLabel(selection.stage, locale)} · {selection.role}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Select value={selection.variant} onValueChange={handleSelectVariant}>
                    <SelectTrigger className="h-8 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {variantsForSelection.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v === 'default' ? copy.defaultVariant : v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" onClick={openClone} className="gap-1.5">
                    <Plus className="h-4 w-4" />
                    {copy.cloneAction}
                  </Button>
                  {!isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleDeleteVariant}
                      disabled={busy}
                      className="gap-1.5 text-book-danger hover:bg-book-danger-light"
                    >
                      <Trash2 className="h-4 w-4" />
                      {copy.deleteVariant}
                    </Button>
                  )}
                </div>
              </div>

              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)} className="flex min-h-0 flex-1 flex-col">
                <div className="border-b border-book-border px-5">
                  <TabsList className="h-auto gap-0 bg-transparent p-0">
                    {(
                      [
                        ['form', copy.tabForm],
                        ['history', copy.tabHistory],
                        ['trial', copy.tabTrial],
                        ['binding', copy.tabBinding],
                        ['packs', copy.tabPacks],
                        ['io', copy.tabIo],
                      ] as [TabKey, string][]
                    ).map(([key, label]) => (
                      <TabsTrigger
                        key={key}
                        value={key}
                        className="rounded-none border-b-2 border-transparent px-3 py-3 text-sm data-[state=active]:border-book-gold data-[state=active]:text-book-ink-primary data-[state=inactive]:text-book-ink-muted"
                      >
                        {label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>

                <ScrollArea className="min-h-0 flex-1">
                  {/* Locale switch shared by form/history/trial */}
                  {(activeTab === 'form' || activeTab === 'history' || activeTab === 'trial') && (
                    <div className="flex items-center gap-2 px-5 pt-4">
                      <span className="text-xs text-book-ink-muted">{copy.localeLabel}</span>
                      <Select value={editLocale} onValueChange={(v) => setEditLocale(v as Locale)}>
                        <SelectTrigger className="h-7 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LOCALES.map((l) => (
                            <SelectItem key={l} value={l}>
                              {l}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <TabsContent value="form" className="m-0 p-5">
                    {isDefault && (
                      <p className="mb-4 rounded-md border border-book-warning-border bg-book-warning-light px-3 py-2 text-sm text-book-stage-writing">
                        {copy.readonlyDefault}
                      </p>
                    )}
                    {record || isDefault ? (
                      <>
                        <VariableSchemaForm
                          copy={copy}
                          templateText={draftText}
                          variablesSchema={draftSchema}
                          sampleValues={sampleValues}
                          readOnly={isDefault}
                          onTemplateTextChange={setDraftText}
                          onSampleValuesChange={setSampleValues}
                        />
                        {!isDefault && (
                          <div className="mt-5 flex gap-2">
                            <Button variant="outline" onClick={handleSaveDraft} disabled={busy || !draftText.trim()}>
                              {copy.saveDraft}
                            </Button>
                            <Button variant="ink" onClick={handlePublish} disabled={busy || !draftText.trim()}>
                              {copy.publishVersion}
                            </Button>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-book-ink-muted">{copy.noHistory}</p>
                    )}
                  </TabsContent>

                  <TabsContent value="history" className="m-0 p-5">
                    <TemplateVersionHistory copy={copy} versions={versions} busy={busy} onActivate={handleActivate} />
                  </TabsContent>

                  <TabsContent value="trial" className="m-0 p-5">
                    <div className="flex flex-col gap-4">
                      <div>
                        <h3 className="font-serif text-base font-semibold">{copy.trialHeading}</h3>
                        <p className="mt-1 text-sm text-book-ink-muted">{copy.trialHint}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" onClick={handleDryRender} disabled={busy}>
                          {copy.dryRunAction}
                        </Button>
                        <Button variant="ghost" onClick={handleRealRun} disabled={trialRunning} className="gap-1.5">
                          {trialRunning ? <Spinner /> : <Wand2 className="h-4 w-4" />}
                          {trialRunning ? copy.trialRunning : copy.realRunAction}
                        </Button>
                      </div>
                      {trial && (
                        <>
                          {trial.missingVars.length > 0 && (
                            <p className="text-xs text-book-ink-muted">{copy.missingVarsNote(trial.missingVars.join(', '))}</p>
                          )}
                          <TrialDiffView copy={copy} defaultText={trial.defaultText} variantText={trial.variantText} />
                        </>
                      )}
                      {trialOutput?.ok && trialOutput.text && (
                        <div>
                          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-book-ink-muted">
                            {copy.outputHeading}
                            {trialOutput.modelName && (
                              <span className="ml-2 font-normal normal-case text-book-ink-muted">{trialOutput.modelName}</span>
                            )}
                          </div>
                          <div className="whitespace-pre-wrap rounded-md border border-book-border bg-book-bg-card p-3 text-sm leading-relaxed">
                            {trialOutput.text}
                          </div>
                        </div>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="binding" className="m-0 p-5">
                    <div className="mb-4">
                      <h3 className="font-serif text-base font-semibold">{copy.bindingHeading}</h3>
                      <p className="mt-1 text-sm text-book-ink-muted">{copy.bindingHint}</p>
                    </div>
                    <CapabilityBindingPanel />
                  </TabsContent>

                  <TabsContent value="packs" className="m-0 p-5">
                    <GenrePacksTab
                      copy={copy}
                      locale={locale}
                      packs={packs}
                      novels={novels}
                      selectedNovelId={selectedNovelId}
                      onSelectNovel={setSelectedNovelId}
                      busy={busy}
                      onApply={handleApplyPack}
                    />
                  </TabsContent>

                  <TabsContent value="io" className="m-0 p-5">
                    <ImportExportTab
                      copy={copy}
                      isDefault={isDefault}
                      variant={selection.variant}
                      allVariants={allVariants}
                      globalDefault={globalDefault}
                      busy={busy}
                      onExport={handleExport}
                      onImport={handleImport}
                      onSaveGlobalDefault={handleSaveGlobalDefault}
                    />
                  </TabsContent>
                </ScrollArea>
              </Tabs>
            </>
          )}
        </section>
      </div>

      {/* Clone dialog */}
      <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.clonePrompt}</DialogTitle>
            <DialogDescription>{copy.cloneNameLabel}</DialogDescription>
          </DialogHeader>
          <Input
            value={cloneName}
            onChange={(e) => {
              setCloneName(e.target.value);
              setCloneError('');
            }}
            placeholder="my_style"
            autoFocus
          />
          {cloneError && <p className="text-sm text-book-danger">{cloneError}</p>}
          <DialogFooter>
            <Button variant="ink" onClick={confirmClone} disabled={busy || !cloneName.trim()}>
              {copy.cloneAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Genre packs tab ───────────────────────────────────────────────────────────

function GenrePacksTab({
  copy,
  locale,
  packs,
  novels,
  selectedNovelId,
  onSelectNovel,
  busy,
  onApply,
}: {
  copy: ReturnType<typeof workflowCopy>;
  locale: Locale;
  packs: GenrePackInfo[];
  novels: NovelPick[];
  selectedNovelId: string;
  onSelectNovel: (id: string) => void;
  busy: boolean;
  onApply: (packId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-serif text-base font-semibold">{copy.packsHeading}</h3>
        <p className="mt-1 text-sm text-book-ink-muted">{copy.packsHint}</p>
      </div>

      {novels.length === 0 ? (
        <p className="rounded-md border border-book-border bg-book-bg-secondary px-3 py-2 text-sm text-book-ink-muted">
          {copy.packNeedsNovel}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Select value={selectedNovelId} onValueChange={onSelectNovel}>
            <SelectTrigger className="h-8 w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {novels.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {packs.map((pack) => (
          <div key={pack.id} className="flex flex-col gap-2 rounded-md border border-book-border bg-book-bg-card p-4">
            <div className="font-serif text-sm font-semibold text-book-ink-primary">{pack.label[locale] ?? pack.label.en}</div>
            <p className="flex-1 text-xs text-book-ink-muted">{pack.description[locale] ?? pack.description.en}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || novels.length === 0}
              onClick={() => onApply(pack.id)}
              className="self-start"
            >
              {copy.applyPack}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Import / Export tab ───────────────────────────────────────────────────────

function ImportExportTab({
  copy,
  isDefault,
  variant,
  allVariants,
  globalDefault,
  busy,
  onExport,
  onImport,
  onSaveGlobalDefault,
}: {
  copy: ReturnType<typeof workflowCopy>;
  isDefault: boolean;
  variant: string;
  allVariants: string[];
  globalDefault: string;
  busy: boolean;
  onExport: () => void;
  onImport: () => void;
  onSaveGlobalDefault: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="font-serif text-base font-semibold">{copy.exportHeading}</h3>
        <p className="mt-1 text-sm text-book-ink-muted">{copy.exportHint}</p>
        <Button variant="outline" className="mt-3" disabled={busy || isDefault} onClick={onExport}>
          {copy.exportAction}
          {!isDefault && <span className="ml-1.5 font-mono text-xs text-book-ink-muted">{variant}</span>}
        </Button>
      </div>

      <div className="border-t border-book-border pt-5">
        <h3 className="font-serif text-base font-semibold">{copy.importHeading}</h3>
        <p className="mt-1 text-sm text-book-ink-muted">{copy.importHint}</p>
        <Button variant="outline" className="mt-3" disabled={busy} onClick={onImport}>
          {copy.importAction}
        </Button>
      </div>

      <div className="border-t border-book-border pt-5">
        <h3 className="font-serif text-base font-semibold">{copy.globalDefaultHeading}</h3>
        <p className="mt-1 text-sm text-book-ink-muted">{copy.globalDefaultHint}</p>
        <Select value={globalDefault || '__default__'} onValueChange={onSaveGlobalDefault}>
          <SelectTrigger className="mt-3 h-8 w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">{copy.globalDefaultNone}</SelectItem>
            {allVariants
              .filter((v) => v !== 'default')
              .map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
