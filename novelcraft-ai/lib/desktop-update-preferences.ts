'use client';

import { getStoredSetting, setStoredSetting } from '@/lib/app-settings-client';
import { AUTOMATIC_UPDATE_CHECK_SETTING_KEY } from '@/lib/app-settings-keys';

export const DESKTOP_UPDATE_MANUAL_CHECK_EVENT = 'inkmarshal:check-for-updates';
export const DESKTOP_UPDATE_CHECK_RESULT_EVENT = 'inkmarshal:update-check-result';

export type DesktopUpdateCheckResult = 'checking' | 'up-to-date' | 'update-available' | 'failed';

export function isAutomaticUpdateCheckEnabled(): boolean {
  return getStoredSetting(AUTOMATIC_UPDATE_CHECK_SETTING_KEY) !== '0';
}

export function setAutomaticUpdateCheckEnabled(enabled: boolean): void {
  setStoredSetting(AUTOMATIC_UPDATE_CHECK_SETTING_KEY, enabled ? '1' : '0');
}

export function requestManualDesktopUpdateCheck(): void {
  window.dispatchEvent(new Event(DESKTOP_UPDATE_MANUAL_CHECK_EVENT));
}

export function publishDesktopUpdateCheckResult(result: DesktopUpdateCheckResult): void {
  window.dispatchEvent(new CustomEvent<DesktopUpdateCheckResult>(
    DESKTOP_UPDATE_CHECK_RESULT_EVENT,
    { detail: result },
  ));
}
