import type { DownloadEvent } from '@tauri-apps/plugin-updater';

interface DownloadableUpdate {
  download(onEvent?: (event: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
}

interface DurableFlushOutcome {
  ok: boolean;
}

interface InstallDesktopUpdateOptions {
  update: DownloadableUpdate;
  flush: () => Promise<DurableFlushOutcome>;
  relaunch: () => Promise<void>;
  onDownloadEvent?: (event: DownloadEvent) => void;
  saveFailedMessage: string;
}

/**
 * Downloading is safe while the current app is still running. Installing is
 * not: it may replace the bundle that owns the active process. Keep the
 * durable manuscript barrier strictly between those two official updater
 * operations so a failed save leaves the old version intact and runnable.
 */
export async function installDesktopUpdate({
  update,
  flush,
  relaunch,
  onDownloadEvent,
  saveFailedMessage,
}: InstallDesktopUpdateOptions): Promise<void> {
  await update.download(onDownloadEvent);
  const save = await flush();
  if (!save.ok) throw new Error(saveFailedMessage);
  await update.install();
  await relaunch();
}
