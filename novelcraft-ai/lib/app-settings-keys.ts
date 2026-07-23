// Allowlist of durable client-config keys mirrored from localStorage into
// SQLite (`app_settings`). Shared by the client cache layer
// (lib/app-settings-client.ts) and the API route (app/api/app-settings) so the
// set of writable keys has a single source of truth — a compromised renderer
// cannot write arbitrary rows.
//
// NOTE on `locale`: it is intentionally NOT here. The locale cookie is scoped
// by host+path (NOT port), so it already survives a runtime-port change; the
// locale store keeps its existing cookie + localStorage + native locale.txt
// mirrors and needs no SQLite backing.
//
// This module is client-safe: no server-only imports, so the renderer cache
// layer can import it directly.

export const AUTOMATIC_UPDATE_CHECK_SETTING_KEY = 'inkmarshal_auto_update_check_v1';

export const APP_SETTINGS_KEYS = [
  'inkmarshal_settings', // theme / fontSize / lineSpacing / chineseTextIndent
  'inkmarshal_connections_v1', // non-secret connection metadata
  'inkmarshal_capability_profile_v1', // role → connection binding
  'inkmarshal_engine_launch_plans_v1', // local-engine relaunch plans
  'inkmarshal_model_root_v1', // optional custom local model download folder
] as const;

export const APP_SETTINGS_CURRENT_ONLY_KEYS = [
  'inkmarshal_workspace_views_v1', // last top-level workspace mode per novel
  AUTOMATIC_UPDATE_CHECK_SETTING_KEY, // default-on startup update checks
  'inkmarshal_manuscript_recovery_v1', // unsaved chapter recovery across runtime ports
] as const;

export type AppSettingKey =
  | (typeof APP_SETTINGS_KEYS)[number]
  | (typeof APP_SETTINGS_CURRENT_ONLY_KEYS)[number];

const WRITABLE_KEYS: ReadonlySet<string> = new Set<string>([
  ...APP_SETTINGS_KEYS,
  ...APP_SETTINGS_CURRENT_ONLY_KEYS,
]);

/** True for any key the API route is allowed to persist (config keys + sentinel). */
export function isWritableAppSettingKey(key: string): boolean {
  return WRITABLE_KEYS.has(key);
}
