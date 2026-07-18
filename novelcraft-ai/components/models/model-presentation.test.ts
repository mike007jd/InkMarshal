import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/en';
import { recoveryMessage, roleSummary, installDate, formatLabel, roleChipLabel } from './model-presentation';
import type { CuratedModelEntry } from '@/lib/model-supply/types';

const t = en;

describe('recoveryMessage classification', () => {
  it.each([
    ['Failed to resolve model_dir', en.modelManagerModelDirUnavailable],
    ['ENOSPC: no space left on disk', en.modelManagerRecoveryDisk],
    ['network timeout while fetching', en.modelManagerRecoveryNetwork],
    ['sha256 hash mismatch, file corrupt', en.modelManagerRecoveryCorrupt],
    ['engine failed to start / not ready', en.modelManagerRecoveryEngine],
    ['unsupported: not enough RAM for MLX on macOS', en.modelManagerRecoveryFit],
    ['something totally unexpected', en.modelManagerRecoveryGeneric],
    [undefined, en.modelManagerRecoveryGeneric],
  ])('maps %s', (raw, expected) => {
    expect(recoveryMessage(raw as string | undefined, t)).toBe(expected);
  });

  it('prefers the earliest matching bucket (model_dir over disk)', () => {
    // Contains both "model folder" and "disk" — model-dir bucket comes first.
    expect(recoveryMessage('model folder missing on disk', t)).toBe(en.modelManagerModelDirUnavailable);
  });
});

describe('roleSummary', () => {
  it('joins multiple roles with the shared separator', () => {
    const entry = { role: ['draft', 'rewrite'] } as CuratedModelEntry;
    expect(roleSummary(entry, t)).toBe(`${en.modelManagerRoleDraft} · ${en.modelManagerRoleRewrite}`);
  });

  it('handles a single (non-array) role', () => {
    const entry = { role: 'recall' } as CuratedModelEntry;
    expect(roleSummary(entry, t)).toBe(en.modelManagerRoleRecall);
  });
});

describe('installDate / formatLabel / roleChipLabel', () => {
  it('returns the unknown label for a missing timestamp', () => {
    expect(installDate(undefined, t)).toBe(en.modelManagerUnknown);
  });
  it('formats a unix-seconds timestamp as a locale date', () => {
    expect(installDate(0, t)).toBe(en.modelManagerUnknown); // 0 is falsy → unknown
    expect(typeof installDate(1_700_000_000, t)).toBe('string');
  });
  it('labels engine formats', () => {
    expect(formatLabel('mlx', t)).toBe(en.modelManagerFormatMlx);
    expect(formatLabel('gguf', t)).toBe(en.modelManagerFormatGguf);
  });
  it('labels capability role chips', () => {
    expect(roleChipLabel('planning', t)).toBe(en.modelManagerRolePlanning);
  });
});
