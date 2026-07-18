// Pure presentation helpers for the model manager / capability panels, lifted
// out of the LocalModelsPanel god component so they're independently unit-
// testable (especially recoveryMessage's error-string classification) and the
// panel shrinks toward view-only code.

import type { StringKey, Translations } from '@/lib/i18n';
import type { CapabilityRole, CuratedModelEntry } from '@/lib/model-supply/types';
import type { EngineFormat } from '@/lib/desktop-runtime';

export function roleSummary(entry: CuratedModelEntry, t: Translations): string {
  const roles = Array.isArray(entry.role) ? entry.role : [entry.role];
  return roles
    .map(role => {
      switch (role) {
        case 'draft':
          return t.modelManagerRoleDraft;
        case 'rewrite':
          return t.modelManagerRoleRewrite;
        case 'planning':
          return t.modelManagerRolePlanning;
        case 'recall':
          return t.modelManagerRoleRecall;
        default:
          return role;
      }
    })
    .join(' · ');
}

export function formatLabel(format: EngineFormat, t: Translations): string {
  return format === 'mlx' ? t.modelManagerFormatMlx : t.modelManagerFormatGguf;
}

/** Short label for a capability role, shared by the running-engine chips so the
 *  wording stays consistent across the Models panel and Settings. */
export function roleChipLabel(role: CapabilityRole, t: Translations): string {
  switch (role) {
    case 'draft':
      return t.modelManagerRoleDraft;
    case 'rewrite':
      return t.modelManagerRoleRewrite;
    case 'planning':
      return t.modelManagerRolePlanning;
    case 'recall':
      return t.modelManagerRoleRecall;
  }
}

export function installDate(value: number | undefined, t: Translations): string {
  if (!value) return t.modelManagerUnknown;
  return new Date(value * 1000).toLocaleDateString();
}

// Error-substring → recovery-hint buckets, in priority order (first match wins:
// e.g. a "model folder on disk" error resolves to the model-dir bucket).
const RECOVERY_BUCKETS: ReadonlyArray<{ keywords: readonly string[]; hint: StringKey }> = [
  { keywords: ['model_dir', 'model folder', 'models folder', 'app data dir'], hint: 'modelManagerModelDirUnavailable' },
  { keywords: ['space', 'disk', 'enospc'], hint: 'modelManagerRecoveryDisk' },
  { keywords: ['network', 'timeout', 'fetch', 'connection', 'http'], hint: 'modelManagerRecoveryNetwork' },
  { keywords: ['sha', 'hash', 'verify', 'corrupt', 'incomplete'], hint: 'modelManagerRecoveryCorrupt' },
  { keywords: ['engine', 'start', 'ready'], hint: 'modelManagerRecoveryEngine' },
  { keywords: ['unsupported', 'ram', 'memory', 'mlx', 'macos'], hint: 'modelManagerRecoveryFit' },
];

/** Map a raw download/engine error string to a user-actionable recovery hint. */
export function recoveryMessage(raw: string | undefined, t: Translations): string {
  const msg = (raw ?? '').toLowerCase();
  const bucket = RECOVERY_BUCKETS.find(b => b.keywords.some(k => msg.includes(k)));
  return t[bucket?.hint ?? 'modelManagerRecoveryGeneric'];
}
