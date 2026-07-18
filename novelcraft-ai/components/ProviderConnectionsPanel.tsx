'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, KeyRound, PlugZap, Plus, Trash2, XCircle } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getConnections,
  getConnectionSecret,
  removeConnection,
  saveConnectionWithOptionalSecret,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import type {
  RuntimeConnection,
  RuntimeConnectionKind,
  RuntimeTransport,
} from '@/lib/model-supply/types';
import { PROVIDER_PRESETS, providerDisplayName } from '@/lib/providers';

interface DraftForm {
  id?: string;
  presetId?: string;
  label: string;
  kind: RuntimeConnectionKind;
  transport: RuntimeTransport;
  baseUrl: string;
  apiKey: string;
  hadKey: boolean;
}

type KeyPresenceState = 'present' | 'missing' | 'unavailable';

function emptyDraft(): DraftForm {
  return {
    label: '',
    kind: 'provider',
    transport: 'openai-compatible',
    baseUrl: '',
    apiKey: '',
    hadKey: false,
  };
}

// Provider Connections is the BYOK / custom-endpoint fallback surface. Per spec
// the product is local-first, so this section is collapsed by default and
// visually secondary to Local Models. Secrets NEVER live on the connection
// record or in component state beyond the in-flight submit — they go straight
// to secret-store (keychain on desktop).
export function ProviderConnectionsPanel() {
  const { t } = useLanguage();
  const [connections, setConnections] = useState<RuntimeConnection[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DraftForm>(() => emptyDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Inline result of the "Test connection" probe so a wrong/expired key surfaces
  // here at entry instead of silently saving a green "Key set" badge that only
  // fails much later mid-generation.
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const testingRef = useRef(false);
  const [removeTarget, setRemoveTarget] = useState<RuntimeConnection | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [keyPresence, setKeyPresence] = useState<Record<string, KeyPresenceState>>({});
  const mountedRef = useRef(true);
  const refreshSeqRef = useRef(0);
  const editSeqRef = useRef(0);
  const savingRef = useRef(false);
  const removeSeqRef = useRef(0);
  const removingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshKeyPresence = useCallback(async (list: RuntimeConnection[], seq: number) => {
    const entries = await Promise.all(
      list.map(async conn => {
        try {
          const secret = await getConnectionSecret(conn.id);
          return [conn.id, secret != null ? 'present' : 'missing'] as const;
        } catch {
          return [conn.id, 'unavailable'] as const;
        }
      }),
    );
    if (mountedRef.current && refreshSeqRef.current === seq) {
      setKeyPresence(Object.fromEntries(entries));
    }
  }, []);

  const refresh = useCallback(() => {
    const seq = ++refreshSeqRef.current;
    const next = getConnections();
    if (mountedRef.current) setConnections(next);
    void refreshKeyPresence(next, seq);
  }, [refreshKeyPresence]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) refresh();
    });
    // Stay consistent when a sibling model-manager panel mutates a connection.
    const unsubscribe = subscribeConnectionsStore(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh]);

  const openAdd = useCallback(() => {
    editSeqRef.current += 1;
    savingRef.current = false;
    setSaving(false);
    setDraft(emptyDraft());
    setFormError(null);
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback(async (conn: RuntimeConnection) => {
    const seq = ++editSeqRef.current;
    let hadKey = false;
    let keyReadUnavailable = false;
    try {
      hadKey = (await getConnectionSecret(conn.id)) != null;
    } catch {
      // Keychain locked/unavailable — treat as "unknown", still allow editing.
      hadKey = Boolean(conn.secretRef);
      keyReadUnavailable = Boolean(conn.secretRef);
    }
    if (!mountedRef.current || editSeqRef.current !== seq) return;
    setDraft({
      id: conn.id,
      label: conn.label,
      kind: conn.kind,
      transport: conn.transport,
      baseUrl: conn.baseUrl,
      apiKey: '',
      hadKey,
    });
    setFormError(keyReadUnavailable ? t.modelManagerKeyReadFailed : null);
    setDialogOpen(true);
  }, [t.modelManagerKeyReadFailed]);

  const submit = useCallback(async () => {
    if (!draft.label.trim() || !draft.baseUrl.trim()) return;
    if (savingRef.current) return;
    const seq = ++editSeqRef.current;
    savingRef.current = true;
    setSaving(true);
    setFormError(null);
    try {
      await saveConnectionWithOptionalSecret({
        id: draft.id,
        label: draft.label.trim(),
        kind: draft.kind,
        transport: draft.transport,
        baseUrl: draft.baseUrl.trim(),
      }, draft.apiKey);
      if (!mountedRef.current || editSeqRef.current !== seq) return;
      setDialogOpen(false);
      setDraft(emptyDraft());
      refresh();
    } catch (error) {
      if (!mountedRef.current || editSeqRef.current !== seq) return;
      setFormError(
        error instanceof Error && /base URL/i.test(error.message)
          ? t.modelManagerConnectionBaseUrlInvalid
          : t.errorSaveFailed,
      );
    } finally {
      if (mountedRef.current && editSeqRef.current === seq) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }, [draft, refresh, t.errorSaveFailed, t.modelManagerConnectionBaseUrlInvalid]);

  const handleTest = useCallback(async () => {
    if (!draft.baseUrl.trim() || testingRef.current) return;
    testingRef.current = true;
    setTesting(true);
    setTestResult(null);
    try {
      const { isTauriRuntime, runtimeHealth } = await import('@/lib/desktop-runtime');
      if (!isTauriRuntime()) {
        setTestResult({ ok: false, message: t.modelManagerTestRequiresDesktop });
        return;
      }
      // Prefer the in-flight key the user just typed; fall back to the stored
      // secret when editing an existing connection without re-entering it.
      let secret: string | null = draft.apiKey.trim() || null;
      if (!secret && draft.id && draft.hadKey) {
        try {
          secret = await getConnectionSecret(draft.id);
        } catch {
          setTestResult({ ok: false, message: t.modelManagerKeyReadFailed });
          return;
        }
      }
      const health = await runtimeHealth({
        connectionId: draft.id || 'draft-test',
        baseUrl: draft.baseUrl.trim(),
        transport: draft.transport,
        secret,
      });
      const ok = health.reachable && health.transportOk;
      setTestResult({
        ok,
        message: ok ? t.modelManagerTestReachable : health.message || t.statusBarHealthDown,
      });
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error && error.message ? error.message : t.statusBarHealthDown,
      });
    } finally {
      testingRef.current = false;
      if (mountedRef.current) setTesting(false);
    }
  }, [draft, t.modelManagerKeyReadFailed, t.modelManagerTestRequiresDesktop, t.modelManagerTestReachable, t.statusBarHealthDown]);

  const confirmRemove = useCallback(async () => {
    if (!removeTarget || removingRef.current) return;
    const targetId = removeTarget.id;
    const seq = ++removeSeqRef.current;
    removingRef.current = true;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeConnection(targetId);
      if (!mountedRef.current || removeSeqRef.current !== seq) return;
      setRemoveTarget(null);
      refresh();
    } catch {
      if (mountedRef.current && removeSeqRef.current === seq) {
        setRemoveError(t.errorSaveFailed);
      }
    } finally {
      if (mountedRef.current && removeSeqRef.current === seq) {
        removingRef.current = false;
        setRemoving(false);
      }
    }
  }, [removeTarget, refresh, t.errorSaveFailed]);

  return (
    <section>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="unstyled"
            size="unstyled"
            aria-controls="provider-connections-panel"
            className="mb-3 flex w-full items-center justify-start gap-2 text-left"
          >
            <PlugZap className="h-3.5 w-3.5 text-book-ink-muted" />
            <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
              {t.providerConnectionsTitle}
            </span>
            {connections.length > 0 && (
              <Badge variant="muted">{connections.length}</Badge>
            )}
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-book-ink-muted" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-book-ink-muted" />
            )}
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent id="provider-connections-panel" className="flex flex-col gap-3">
          {connections.length === 0 ? (
            <p className="rounded-md border border-dashed border-book-border px-3 py-3 text-xs text-book-ink-muted">
              {t.modelManagerConnectionsEmpty}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {connections.map(conn => (
                <li
                  key={conn.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-book-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-book-ink-primary">
                        {conn.label}
                      </span>
                      <Badge variant="muted">{kindLabel(conn.kind, t)}</Badge>
                      {keyPresence[conn.id] === 'present' && (
                        <Badge variant="success">{t.modelManagerKeySet}</Badge>
                      )}
                      {keyPresence[conn.id] === 'unavailable' && (
                        <Badge variant="danger">{t.modelManagerKeyUnavailable}</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-xs-tight text-book-ink-muted">
                      {transportLabel(conn.transport, t)} · {conn.baseUrl}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void openEdit(conn)}
                    >
                      {t.edit}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t.modelManagerRemoveConnection}
                      onClick={() => {
                        setRemoveError(null);
                        setRemoveTarget(conn);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-book-ink-muted" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Button type="button" variant="outline" size="sm" onClick={openAdd}>
            <Plus className="h-3.5 w-3.5" />
            {t.modelManagerAddConnection}
          </Button>
        </CollapsibleContent>
      </Collapsible>

      <Dialog
        open={dialogOpen}
        onOpenChange={open => {
          setDialogOpen(open);
          if (!open) {
            editSeqRef.current += 1;
            savingRef.current = false;
            setSaving(false);
            setFormError(null);
            setTestResult(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {draft.id ? t.modelManagerEditConnection : t.modelManagerAddConnection}
            </DialogTitle>
            <DialogDescription>
              {t.modelManagerProviderConnectionsDesc}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!draft.id && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-book-ink-secondary">
                  {t.providerDirectoryLabel}
                </span>
                <Select
                  value={draft.presetId ?? 'custom'}
                  onValueChange={value => {
                    if (value === 'custom') {
                      setDraft(current => ({
                        ...current,
                        presetId: undefined,
                        label: '',
                        kind: 'provider',
                        transport: 'openai-compatible',
                        baseUrl: '',
                      }));
                      setFormError(null);
                      setTestResult(null);
                      return;
                    }
                    const preset = PROVIDER_PRESETS.find(candidate => candidate.id === value);
                    if (!preset) return;
                    setDraft(current => ({
                      ...current,
                      presetId: preset.id,
                      label: providerDisplayName(preset, t),
                      kind: 'provider',
                      transport: preset.id === 'anthropic' ? 'anthropic' : 'openai-compatible',
                      baseUrl: preset.baseUrl,
                    }));
                    setFormError(null);
                    setTestResult(null);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_PRESETS.map(preset => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {providerDisplayName(preset, t)}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">{t.providerDirectoryCustom}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            )}

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-book-ink-secondary">
                {t.modelManagerConnectionLabel}
              </span>
              <Input
                value={draft.label}
                placeholder={t.modelManagerConnectionLabelPlaceholder}
                onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-book-ink-secondary">
                {t.modelManagerConnectionKind}
              </span>
              <Select
                value={draft.kind}
                onValueChange={v =>
                  setDraft(d => ({ ...d, kind: v as RuntimeConnectionKind }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{t.modelManagerConnectionKindLocal}</SelectItem>
                  <SelectItem value="provider">{t.modelManagerConnectionKindProvider}</SelectItem>
                  <SelectItem value="custom">{t.modelManagerConnectionKindCustom}</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-book-ink-secondary">
                {t.modelManagerConnectionTransport}
              </span>
              <Select
                value={draft.transport}
                onValueChange={v =>
                  setDraft(d => ({ ...d, transport: v as RuntimeTransport }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai-compatible">{t.modelManagerTransportOpenai}</SelectItem>
                  <SelectItem value="anthropic">{t.modelManagerTransportAnthropic}</SelectItem>
                  <SelectItem value="ollama-native">{t.modelManagerTransportOllama}</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-book-ink-secondary">
                {t.modelManagerConnectionBaseUrl}
              </span>
              <Input
                type="url"
                value={draft.baseUrl}
                placeholder="https://api.openai.com/v1"
                aria-invalid={Boolean(formError)}
                onChange={e => {
                  setFormError(null);
                  setTestResult(null);
                  setDraft(d => ({ ...d, baseUrl: e.target.value }));
                }}
              />
            </label>

            <label className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-book-ink-secondary">
                <KeyRound className="h-3 w-3" />
                {t.modelManagerConnectionApiKey}
                {draft.hadKey && (
                  <Badge variant="success" className="ml-1">
                    {t.modelManagerKeySet}
                  </Badge>
                )}
              </span>
              <Input
                type="password"
                value={draft.apiKey}
                autoComplete="off"
                placeholder={
                  draft.hadKey
                    ? t.modelManagerReplaceKey
                    : t.modelManagerConnectionApiKeyOptional
                }
                onChange={e => {
                  setTestResult(null);
                  setDraft(d => ({ ...d, apiKey: e.target.value }));
                }}
              />
              <span className="mt-1 block text-xs-tight text-book-ink-muted">
                {t.modelManagerKeyStored}
              </span>
            </label>

            {formError && (
              <p className="text-xs-tight text-book-danger" role="alert">
                {formError}
              </p>
            )}

            {testResult && (
              <p
                className={`flex items-center gap-1.5 text-xs-tight ${testResult.ok ? 'text-book-success' : 'text-book-danger'}`}
                role="status"
              >
                {testResult.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
                {testResult.message}
              </p>
            )}
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleTest()}
              disabled={saving || testing || !draft.baseUrl.trim()}
              className="gap-1.5"
            >
              {testing ? <Spinner size="sm" /> : <PlugZap className="h-3.5 w-3.5" aria-hidden />}
              {t.modelManagerTestConnection}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDialogOpen(false)}
                disabled={saving}
              >
                {t.modelManagerCancel}
              </Button>
              <Button
                type="button"
                onClick={() => void submit()}
                disabled={saving || !draft.label.trim() || !draft.baseUrl.trim()}
              >
                {t.modelManagerSave}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={open => {
          if (!open) {
            removeSeqRef.current += 1;
            removingRef.current = false;
            setRemoving(false);
            setRemoveError(null);
            setRemoveTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.modelManagerConfirmRemoveTitle}</DialogTitle>
            <DialogDescription>{t.modelManagerConfirmRemoveDesc}</DialogDescription>
          </DialogHeader>
          {removeError && (
            <p className="text-xs-tight text-book-danger" role="alert">
              {removeError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRemoveTarget(null)}
              disabled={removing}
            >
              {t.modelManagerCancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmRemove()}
              disabled={removing}
            >
              {t.modelManagerRemoveConnection}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function kindLabel(
  kind: RuntimeConnectionKind,
  t: ReturnType<typeof useLanguage>['t'],
): string {
  if (kind === 'local') return t.modelManagerConnectionKindLocal;
  if (kind === 'provider') return t.modelManagerConnectionKindProvider;
  return t.modelManagerConnectionKindCustom;
}

function transportLabel(
  transport: RuntimeTransport,
  t: ReturnType<typeof useLanguage>['t'],
): string {
  if (transport === 'anthropic') return t.modelManagerTransportAnthropic;
  if (transport === 'ollama-native') return t.modelManagerTransportOllama;
  return t.modelManagerTransportOpenai;
}
