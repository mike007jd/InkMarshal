import type { LanguageModel } from 'ai';

import type { RuntimeModelDescriptor } from '@/lib/runtime-models';
import { isLoopbackHost, isLoopbackHttpUrl } from '@/lib/loopback-hosts';

export interface ResolvedModel {
  model: LanguageModel;
  runtimeModel: RuntimeModelDescriptor;
}

/**
 * The SINGLE localhost gate. server-resolve.ts imports this exact impl so the
 * non-local-request guard is never duplicated/diverged. A non-local request
 * can never carry or honor a user runtime / `x-im-secret`.
 */
export function requestAllowsUserRuntime(req: Request): boolean {
  if (process.env.NODE_ENV === 'production' && process.env.INKMARSHAL_RUNTIME !== 'desktop') {
    return false;
  }
  const url = new URL(req.url);
  return isLoopbackHost(url.hostname);
}

export function headerValue(req: Request, name: string): string | null {
  const value = req.headers.get(name)?.trim();
  return value ? value : null;
}

export function parseUserRuntimeBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function runtimeBaseUrlCanCarrySecret(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return url.protocol === 'https:' || isLoopbackHttpUrl(url);
  } catch {
    return false;
  }
}
