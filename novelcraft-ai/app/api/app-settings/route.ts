// GET  /api/app-settings           → { settings: Record<string,string> }
// PATCH /api/app-settings { key, value }   (value === null → delete row)
//
// Desktop-only durable config KV (theme, connections, capability bindings,
// engine launch plans) that must survive a runtime-port change — see
// lib/db/schema/0011_app_settings.ts. No novel-owner check is needed: proxy.ts
// already 404s /api/* in the web runtime and timing-safe-authorizes desktop
// requests, and getDb() enforces the desktop-runtime DB guard. The key
// allowlist (isWritableAppSettingKey) is the write-side guard so a compromised
// renderer can't persist arbitrary rows.

import { NextResponse } from 'next/server';
import { safeParseJsonObject, sanitizeError } from '@/lib/utils';
import {
  deleteAppSetting,
  getAllAppSettings,
  setAppSetting,
} from '@/lib/db/queries-app-settings';
import { isWritableAppSettingKey } from '@/lib/app-settings-keys';

export async function GET() {
  try {
    return NextResponse.json({ settings: getAllAppSettings() });
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeError(error, 'Failed to read app settings') },
      { status: 500 },
    );
  }
}

interface PatchAppSettingBody {
  key?: unknown;
  value?: unknown;
}

export async function PATCH(request: Request) {
  const parsed = await safeParseJsonObject<PatchAppSettingBody>(request, {
    errorMessage: 'app-settings body must be an object',
  });
  if (parsed.error) return parsed.error;

  const { key, value } = parsed.data;
  if (typeof key !== 'string' || !isWritableAppSettingKey(key)) {
    return NextResponse.json({ error: 'unsupported app-settings key' }, { status: 400 });
  }
  if (value !== null && typeof value !== 'string') {
    return NextResponse.json(
      { error: 'app-settings value must be a string or null' },
      { status: 400 },
    );
  }

  try {
    if (value === null) {
      deleteAppSetting(key);
      return NextResponse.json({ key, value: null });
    }
    setAppSetting(key, value);
    return NextResponse.json({ key, value });
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeError(error, 'Failed to write app settings') },
      { status: 500 },
    );
  }
}
