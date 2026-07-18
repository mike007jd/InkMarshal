'use client';

import { useSyncExternalStore } from 'react';

import { isMacPlatform } from '@/lib/desktop-runtime';

const subscribe = () => () => undefined;
const serverSnapshot = () => false;

export function useClientMacPlatform(): boolean {
  return useSyncExternalStore(subscribe, isMacPlatform, serverSnapshot);
}
