import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getStoredSetting: vi.fn<() => string | null>(),
  setStoredSetting: vi.fn(),
}));

vi.mock('@/lib/app-settings-client', () => storage);

import {
  isAutomaticUpdateCheckEnabled,
  setAutomaticUpdateCheckEnabled,
} from '@/lib/desktop-update-preferences';
import { AUTOMATIC_UPDATE_CHECK_SETTING_KEY } from '@/lib/app-settings-keys';
import { isWritableAppSettingKey } from '@/lib/app-settings-keys';

describe('automatic desktop update preference', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to enabled when no preference has been saved', () => {
    storage.getStoredSetting.mockReturnValue(null);
    expect(isAutomaticUpdateCheckEnabled()).toBe(true);
  });

  it('disables startup checks only for the explicit off value', () => {
    storage.getStoredSetting.mockReturnValue('0');
    expect(isAutomaticUpdateCheckEnabled()).toBe(false);
  });

  it('persists both switch states through the allowlisted app setting key', () => {
    expect(isWritableAppSettingKey(AUTOMATIC_UPDATE_CHECK_SETTING_KEY)).toBe(true);
    setAutomaticUpdateCheckEnabled(false);
    setAutomaticUpdateCheckEnabled(true);
    expect(storage.setStoredSetting.mock.calls).toEqual([
      [AUTOMATIC_UPDATE_CHECK_SETTING_KEY, '0'],
      [AUTOMATIC_UPDATE_CHECK_SETTING_KEY, '1'],
    ]);
  });
});
