'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { listHfGgufFiles } from '@/lib/model-supply/hf-hub';
import {
  repoForStarterEntry,
  resolveStarterFormat,
} from '@/lib/model-supply/starter-models';
import type { EngineFormat } from '@/lib/desktop-runtime';
import type { CuratedModelEntry, HfModelFile } from '@/lib/model-supply/types';

export function starterCatalogFilesKey(
  entry: CuratedModelEntry,
  activeFormat: EngineFormat,
): string {
  const format = resolveStarterFormat(entry, activeFormat);
  const repo = format ? repoForStarterEntry(entry, format) : null;
  return repo && format ? `${repo}:${format}` : '';
}

export function useStarterCatalogFiles(activeFormat: EngineFormat) {
  const [loadingByKey, setLoadingByKey] = useState<Record<string, boolean>>({});
  const cacheRef = useRef<Record<string, HfModelFile[]>>({});
  const inflightRef = useRef<Record<string, Promise<HfModelFile[]>>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const ensureCatalogFiles = useCallback(
    async (entry: CuratedModelEntry): Promise<HfModelFile[]> => {
      const format = resolveStarterFormat(entry, activeFormat);
      const repo = format ? repoForStarterEntry(entry, format) : null;
      if (!format || !repo) return [];
      const resolvedFormat: EngineFormat = format;
      const key = `${repo}:${format}`;
      const cached = cacheRef.current[key];
      if (cached) return cached;
      const inflight = inflightRef.current[key];
      if (inflight) return inflight;

      const fetchPromise = (async () => {
        try {
          const files = await listHfGgufFiles(repo, resolvedFormat);
          cacheRef.current[key] = files;
          return files;
        } catch {
          cacheRef.current[key] = [];
          return [];
        } finally {
          delete inflightRef.current[key];
          if (mountedRef.current) setLoadingByKey(s => ({ ...s, [key]: false }));
        }
      })();
      inflightRef.current[key] = fetchPromise;
      if (mountedRef.current) setLoadingByKey(s => ({ ...s, [key]: true }));
      return fetchPromise;
    },
    [activeFormat],
  );

  return {
    loadingByKey,
    ensureCatalogFiles,
  };
}
