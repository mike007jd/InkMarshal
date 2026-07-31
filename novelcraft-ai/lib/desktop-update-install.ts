import type { DownloadEvent } from '@tauri-apps/plugin-updater';

import type { Translations } from '@/lib/i18n';

interface DownloadableUpdate {
  download(onEvent?: (event: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
}

interface DurableFlushOutcome {
  ok: boolean;
}

interface InstallDesktopUpdateOptions {
  update: DownloadableUpdate;
  session?: DesktopUpdateInstallSession;
  flush: () => Promise<DurableFlushOutcome>;
  relaunch: () => Promise<void>;
  onDownloadEvent?: (event: DownloadEvent) => void;
  saveFailedMessage: string;
}

export interface DesktopUpdateInstallSession {
  downloaded: boolean;
  installed: boolean;
}

/** Canonical verified Apple Silicon DMG — allowlisted for shell-open recovery. */
export const VERIFIED_MAC_DMG_DOWNLOAD_URL =
  'https://github.com/mike007jd/InkMarshal/releases/latest/download/InkMarshal-mac-aarch64.dmg';

export type DesktopUpdateFailureCategory =
  | 'corrupt-package'
  | 'network'
  | 'permission'
  | 'save-failed'
  | 'generic';

/**
 * Downloading is safe while the current app is still running. Installing is
 * not: it may replace the bundle that owns the active process. Keep the
 * durable manuscript barrier strictly between those two official updater
 * operations so a failed save leaves the old version intact and runnable.
 */
export async function installDesktopUpdate({
  update,
  session = { downloaded: false, installed: false },
  flush,
  relaunch,
  onDownloadEvent,
  saveFailedMessage,
}: InstallDesktopUpdateOptions): Promise<void> {
  if (!session.downloaded) {
    await update.download(onDownloadEvent);
    session.downloaded = true;
  }
  if (!session.installed) {
    const save = await flush();
    if (!save.ok) throw new Error(saveFailedMessage);
    await update.install();
    session.installed = true;
  }
  await relaunch();
}

/**
 * Normalize Error and Tauri-serialized string failures into safe UI categories.
 * Never return or embed local paths — callers must render localized copy only.
 */
export function categorizeDesktopUpdateFailure(
  cause: unknown,
  saveFailedMessage?: string,
): DesktopUpdateFailureCategory {
  const text = causeText(cause);
  if (!text) return 'generic';
  if (saveFailedMessage && text === saveFailedMessage) return 'save-failed';

  const lower = text.toLowerCase();

  if (
    /failed to unpack|tauri_updated_app|corrupt|invalid updater|invalid archive|appledouble|\._|\.ds_store|minisign|signature|gzip|tar\b|code signature|codesign/i.test(
      lower,
    )
  ) {
    return 'corrupt-package';
  }

  if (
    /permission denied|authentication failed|failed to move the new app|administrator privileges|operation not permitted|eacces|eperm/i.test(
      lower,
    )
  ) {
    return 'permission';
  }

  if (
    /network|timed out|timeout|could not fetch|release not found|connection|dns|econnreset|enotfound|econnrefused|fetch failed|http\b/i.test(
      lower,
    )
  ) {
    return 'network';
  }

  return 'generic';
}

/** Localized product copy for a categorized updater failure — never raw paths. */
export function desktopUpdateFailureMessage(
  category: DesktopUpdateFailureCategory,
  t: Pick<
    Translations,
    | 'updateInstallFailed'
    | 'updateInstallCorruptPackage'
    | 'updateInstallNetworkFailed'
    | 'updateInstallPermissionFailed'
    | 'updateSaveFailed'
  >,
): string {
  switch (category) {
    case 'corrupt-package':
      return t.updateInstallCorruptPackage;
    case 'network':
      return t.updateInstallNetworkFailed;
    case 'permission':
      return t.updateInstallPermissionFailed;
    case 'save-failed':
      return t.updateSaveFailed;
    default:
      return t.updateInstallFailed;
  }
}

function causeText(cause: unknown): string {
  if (typeof cause === 'string') return cause.trim();
  if (cause instanceof Error) return cause.message.trim();
  if (cause && typeof cause === 'object' && 'message' in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string') return message.trim();
  }
  return '';
}
