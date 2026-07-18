'use client';

import { isTauriRuntime } from '@/lib/desktop-runtime';
import { isLoopbackHost } from '@/lib/loopback-hosts';

export function clientAllowsUserRuntimeHeaders(): boolean {
  if (isTauriRuntime()) return true;
  if (typeof window === 'undefined') return false;
  return isLoopbackHost(window.location.hostname);
}
