const DESKTOP_SESSION_ENV = 'INKMARSHAL_DESKTOP_SESSION';
export const DESKTOP_SESSION_COOKIE = 'inkmarshal_desktop_session';

function desktopSessionToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.INKMARSHAL_RUNTIME !== 'desktop') return null;
  const token = env[DESKTOP_SESSION_ENV]?.trim();
  return token && token.length >= 32 ? token : null;
}

function timingSafeEqualString(candidate: string | undefined, expected: string): boolean {
  if (!candidate || candidate.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

export function hasValidDesktopSessionCredential(
  credentials: { header?: string; cookie?: string },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.INKMARSHAL_RUNTIME !== 'desktop') return true;
  const expected = desktopSessionToken(env);
  if (!expected) return false;
  return timingSafeEqualString(credentials.header?.trim(), expected)
    || timingSafeEqualString(credentials.cookie?.trim(), expected);
}
