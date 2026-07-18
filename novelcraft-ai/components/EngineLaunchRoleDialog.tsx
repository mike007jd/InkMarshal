'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CAPABILITY_ROLES, type CapabilityRole } from '@/lib/model-supply/types';
import { formatBytes } from '@/lib/model-supply/format';
import {
  QuotaConflict,
  startEngineForRoles,
  type EngineStartPlan,
  type EngineStartResult,
  type QuotaConflictDetail,
} from '@/lib/model-supply/orchestrator';

interface EngineLaunchRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Plan minus `roles`/`onConflict` — the dialog supplies both based on user choice. */
  plan: Pick<EngineStartPlan, 'modelPath' | 'format' | 'modelLabel' | 'engineLabel'> | null;
  /** Called with the orchestrator result on success. */
  onSuccess?: (result: EngineStartResult) => void;
  /** Called when the user cancels / closes without launching. */
  onCancel?: () => void;
  /**
   * Wave 4 commit C: when set, the dialog pre-fills the role list and hides the
   * checkbox grid — used by the per-role "Launch for role" button on
   * CapabilityBindingPanel so the user doesn't redundantly pick the role they
   * just clicked. `null`/omitted falls back to the legacy multi-role picker.
   */
  presetRoles?: readonly CapabilityRole[];
}

const DEFAULT_ROLE_SELECTION: Record<CapabilityRole, boolean> = {
  draft: true,
  rewrite: true,
  planning: false,
  recall: false,
};

function roleLabel(
  role: CapabilityRole,
  t: ReturnType<typeof useLanguage>['t'],
): string {
  switch (role) {
    case 'draft':
      return t.engineLaunchRoleDraft;
    case 'rewrite':
      return t.engineLaunchRoleRewrite;
    case 'planning':
      return t.engineLaunchRolePlanning;
    case 'recall':
      return t.engineLaunchRoleRecall;
  }
}

/**
 * Two-stage dialog for explicitly picking which capability roles a freshly
 * downloaded (or imported) local model should serve, and resolving the
 * resource-budget conflict if the orchestrator says we can't fit a new engine.
 *
 * Stage 1 — role selection: 4 checkboxes (draft/rewrite/planning/recall),
 *   default = draft + rewrite (the writing main path). User confirms → calls
 *   `startEngineForRoles({ roles, onConflict: 'cancel' })`.
 *
 * Stage 2 — quota conflict (only when startEngineForRoles throws QuotaConflict):
 *   stop existing / reuse / cancel three-way panel. "Reuse" re-runs with
 *   `onConflict: 'reuse'`; "Stop" with `onConflict: 'replace'`.
 */
export function EngineLaunchRoleDialog({
  open,
  onOpenChange,
  plan,
  onSuccess,
  onCancel,
  presetRoles,
}: EngineLaunchRoleDialogProps) {
  const { t } = useLanguage();
  const presetMode = presetRoles != null && presetRoles.length > 0;
  const initialSelection = useMemo<Record<CapabilityRole, boolean>>(() => {
    if (presetMode) {
      const next: Record<CapabilityRole, boolean> = {
        draft: false,
        rewrite: false,
        planning: false,
        recall: false,
      };
      for (const r of presetRoles!) next[r] = true;
      return next;
    }
    return DEFAULT_ROLE_SELECTION;
    // Recompute when the preset role set identity changes; in normal use this
    // is a stable array supplied by the parent so the recompute is rare.
  }, [presetMode, presetRoles]);

  const [selected, setSelected] = useState<Record<CapabilityRole, boolean>>(initialSelection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<QuotaConflictDetail | null>(null);

  // Reset state every time the dialog opens for a new plan / preset set.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSelected(initialSelection);
      setBusy(false);
      setError(null);
      setConflict(null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, plan?.modelPath, initialSelection]);

  const chosenRoles = useMemo(
    () => CAPABILITY_ROLES.filter(role => selected[role]),
    [selected],
  );

  const close = () => {
    if (busy) return;
    onOpenChange(false);
    onCancel?.();
  };

  const launchWith = async (
    roles: readonly CapabilityRole[],
    onConflict: EngineStartPlan['onConflict'],
  ) => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const result = await startEngineForRoles({
        modelPath: plan.modelPath,
        format: plan.format,
        modelLabel: plan.modelLabel,
        engineLabel: plan.engineLabel,
        roles,
        onConflict,
      });
      onOpenChange(false);
      onSuccess?.(result);
    } catch (err) {
      if (err instanceof QuotaConflict) {
        setConflict(err.detail);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = () => {
    if (chosenRoles.length === 0 || !plan) return;
    void launchWith(chosenRoles, 'cancel');
  };

  const handleStopOthers = () => {
    if (!plan) return;
    void launchWith(chosenRoles, 'replace');
  };

  const handleReuse = () => {
    if (!plan) return;
    void launchWith(chosenRoles, 'reuse');
  };

  if (!plan) return null;

  return (
    <Dialog open={open} onOpenChange={value => (value ? onOpenChange(value) : close())}>
      <DialogContent>
        {conflict ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-book-danger" />
                <DialogTitle>{t.engineQuotaConflictTitle}</DialogTitle>
              </div>
              <DialogDescription>
                {t.engineQuotaConflictBody
                  .replace('{required}', formatBytes(conflict.requiredBytes))
                  .replace('{available}', formatBytes(conflict.availableBytes))}
              </DialogDescription>
            </DialogHeader>
            {conflict.conflicting.length > 0 && (
              <ul className="space-y-1 rounded-md border border-book-border bg-book-bg-secondary p-2 text-xs-tight text-book-ink-muted">
                {conflict.conflicting.map(r => (
                  <li key={r.engineId} className="truncate">
                    {r.modelPath} · {formatBytes(r.footprintBytes)}
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={close}
              >
                {t.engineQuotaActionCancel}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || conflict.conflicting.length === 0}
                onClick={handleReuse}
              >
                {t.engineQuotaActionReuse}
              </Button>
              <Button
                type="button"
                variant="accent"
                size="sm"
                disabled={busy || conflict.conflicting.length === 0}
                onClick={handleStopOthers}
              >
                {busy ? <Spinner size="sm" /> : null}
                {t.engineQuotaActionStop}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {presetMode
                  ? t.engineLaunchTitleForRole.replace(
                      '{role}',
                      presetRoles!.map(r => roleLabel(r, t)).join(' · '),
                    )
                  : t.engineLaunchTitle}
              </DialogTitle>
              <DialogDescription className="truncate">{plan.modelLabel}</DialogDescription>
            </DialogHeader>
            {presetMode ? (
              <p className="rounded-md border border-book-border bg-book-bg-secondary px-3 py-2 text-xs-tight text-book-ink-muted">
                {t.engineLaunchSingleRoleHint.replace(
                  '{role}',
                  presetRoles!.map(r => roleLabel(r, t)).join(' · '),
                )}
              </p>
            ) : (
              <div className="space-y-2">
                {CAPABILITY_ROLES.map(role => (
                  <label
                    key={role}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-book-border bg-book-bg-card px-3 py-2 hover:border-book-gold"
                  >
                    <Checkbox
                      checked={selected[role]}
                      onCheckedChange={checked =>
                        setSelected(prev => ({ ...prev, [role]: checked === true }))
                      }
                    />
                    <span className="text-sm text-book-ink-primary">{roleLabel(role, t)}</span>
                  </label>
                ))}
              </div>
            )}
            {error && <p className="text-xs-tight text-book-danger">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={close}
              >
                {t.engineLaunchCancel}
              </Button>
              <Button
                type="button"
                variant="accent"
                size="sm"
                disabled={busy || chosenRoles.length === 0}
                onClick={handleConfirm}
              >
                {busy ? <Spinner size="sm" /> : null}
                {t.engineLaunchConfirm}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Wave 4 commit C: per-role launch button on CapabilityBindingPanel pops this
 * thin convenience wrapper. The user already picked the role they want to
 * launch the model for; the dialog reuses the parent's state machine but hides
 * the multi-role checkbox UI and shows a single-role launch hint.
 */
export function RoleSpecificEngineLaunchDialog(
  props: Omit<EngineLaunchRoleDialogProps, 'presetRoles'> & {
    role: CapabilityRole;
  },
) {
  const { role, ...rest } = props;
  const presetRoles = useMemo(() => [role] as const, [role]);
  return <EngineLaunchRoleDialog {...rest} presetRoles={presetRoles} />;
}
