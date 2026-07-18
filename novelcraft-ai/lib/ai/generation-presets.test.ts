import { describe, expect, it } from 'vitest';
import {
  CREATIVITY_LEVELS,
  CREATIVITY_PRESETS,
  OPERATION_DEFAULT_CREATIVITY,
  isCreativityLevel,
  resolvePreset,
  withoutPenalties,
} from '@/lib/ai/generation-presets';

describe('generation-presets', () => {
  it('exposes the three locked baseline presets (temperature-only)', () => {
    // Steering is temperature-only by design: the AI SDK recommends setting
    // either temperature OR topP (not both), and penalties are left off so the
    // older-llama-server `presence_penalty` 422 can't fire. The temperature
    // values remain the user-visible 保守/平衡/放飞 contract.
    expect(CREATIVITY_PRESETS.conservative).toEqual({ temperature: 0.5 });
    expect(CREATIVITY_PRESETS.balanced).toEqual({ temperature: 0.75 });
    expect(CREATIVITY_PRESETS.wild).toEqual({ temperature: 0.95 });
  });

  it('lists creativity levels in stable UI order', () => {
    expect(CREATIVITY_LEVELS).toEqual(['conservative', 'balanced', 'wild']);
  });

  it('isCreativityLevel narrows arbitrary input safely', () => {
    expect(isCreativityLevel('conservative')).toBe(true);
    expect(isCreativityLevel('balanced')).toBe(true);
    expect(isCreativityLevel('wild')).toBe(true);
    expect(isCreativityLevel('aggressive')).toBe(false);
    expect(isCreativityLevel(null)).toBe(false);
    expect(isCreativityLevel(undefined)).toBe(false);
    expect(isCreativityLevel(0.95)).toBe(false);
  });

  it('resolvePreset falls back to OPERATION_DEFAULT_CREATIVITY when no override', () => {
    expect(resolvePreset('outline')).toEqual(CREATIVITY_PRESETS.conservative);
    expect(resolvePreset('chat')).toEqual(CREATIVITY_PRESETS.balanced);
    expect(resolvePreset('chapter')).toEqual(CREATIVITY_PRESETS.balanced);
    expect(resolvePreset('polish')).toEqual(CREATIVITY_PRESETS.conservative);
    // Sanity: default map covers every OperationKind. Presets steer on
    // temperature only; topP is intentionally absent.
    for (const op of Object.keys(OPERATION_DEFAULT_CREATIVITY)) {
      const out = resolvePreset(op as keyof typeof OPERATION_DEFAULT_CREATIVITY);
      expect(typeof out.temperature).toBe('number');
      expect(out.topP).toBeUndefined();
    }
  });

  it('resolvePreset honours an explicit override', () => {
    expect(resolvePreset('outline', 'wild')).toEqual(CREATIVITY_PRESETS.wild);
    expect(resolvePreset('chat', 'conservative')).toEqual(CREATIVITY_PRESETS.conservative);
  });

  it('resolvePreset returns a fresh object (no shared reference)', () => {
    const a = resolvePreset('chat');
    const b = resolvePreset('chat');
    expect(a).not.toBe(b);
    expect(a).not.toBe(CREATIVITY_PRESETS.balanced);
    a.seed = 42;
    expect(CREATIVITY_PRESETS.balanced.seed).toBeUndefined();
  });

  it('withoutPenalties strips presence/frequency but keeps the rest', () => {
    const base = { temperature: 0.7, topP: 0.9, presencePenalty: 0.5, frequencyPenalty: 0.3, seed: 7 };
    expect(withoutPenalties(base)).toEqual({ temperature: 0.7, topP: 0.9, seed: 7 });
  });
});
