// SQLite-backed durable app-settings KV (Phase 1). Stores the exact string the
// client store serializes — symmetric with localStorage — so each client store
// keeps its own encode/decode. Server-only: loads the native better-sqlite3
// addon via getDb(), which also enforces the desktop-runtime DB guard.

import { getDb } from '@/lib/db/connection';
import { nowIso } from '@/lib/utils';

interface AppSettingRow {
  key: string;
  value: string;
}

/** All persisted settings as a flat record (used for one-shot boot hydration). */
export function getAllAppSettings(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT key, value FROM app_settings')
    .all() as AppSettingRow[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export function getAppSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as Pick<AppSettingRow, 'value'> | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}

export function deleteAppSetting(key: string): void {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}
