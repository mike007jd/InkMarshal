'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listHfGgufFiles, searchHfModels } from '@/lib/model-supply/hf-hub';
import { recoveryMessage } from '@/components/models/model-presentation';
import type { EngineFormat } from '@/lib/desktop-runtime';
import type { Translations } from '@/lib/i18n';
import type { HfModelFile, HfSearchResult } from '@/lib/model-supply/types';

export function useHfModelSearch({
  activeFormat,
  t,
}: {
  activeFormat: EngineFormat;
  t: Translations;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<HfSearchResult[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [files, setFiles] = useState<HfModelFile[]>([]);
  const [filename, setFilename] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  const mountedRef = useRef(true);
  const searchSeqRef = useRef(0);
  const filesSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resetSelection = useCallback(() => {
    searchSeqRef.current += 1;
    filesSeqRef.current += 1;
    setResults([]);
    setRepo(null);
    setFiles([]);
    setFilename('');
    setSearchError(null);
    setFilesError(null);
    setFilesLoading(false);
  }, []);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const seq = ++searchSeqRef.current;
    filesSeqRef.current += 1;
    const isCurrent = () => mountedRef.current && searchSeqRef.current === seq;
    setSearching(true);
    setRepo(null);
    setFiles([]);
    setFilename('');
    setSearchError(null);
    setFilesError(null);
    try {
      const nextResults = await searchHfModels(trimmed, 20, activeFormat);
      if (isCurrent()) setResults(nextResults);
    } catch (err) {
      if (isCurrent()) {
        setResults([]);
        setSearchError(recoveryMessage(err instanceof Error ? err.message : String(err), t));
      }
    } finally {
      if (isCurrent()) setSearching(false);
    }
  }, [activeFormat, query, t]);

  const pickRepo = useCallback(
    async (nextRepo: string) => {
      const seq = ++filesSeqRef.current;
      const isCurrent = () => mountedRef.current && filesSeqRef.current === seq;
      setRepo(nextRepo);
      setFiles([]);
      setFilename('');
      setFilesError(null);
      setFilesLoading(true);
      try {
        const nextFiles = await listHfGgufFiles(nextRepo, activeFormat);
        if (isCurrent()) {
          setFiles(nextFiles);
          if (nextFiles.length > 0) setFilename(nextFiles[0].filename);
        }
      } catch (err) {
        if (isCurrent()) {
          setFiles([]);
          setFilesError(recoveryMessage(err instanceof Error ? err.message : String(err), t));
        }
      } finally {
        if (isCurrent()) setFilesLoading(false);
      }
    },
    [activeFormat, t],
  );

  const selectedFile = useMemo(
    () => files.find(file => file.filename === filename) ?? null,
    [files, filename],
  );

  return {
    open,
    setOpen,
    query,
    setQuery,
    searching,
    results,
    repo,
    files,
    filename,
    setFilename,
    searchError,
    filesError,
    filesLoading,
    selectedFile,
    resetSelection,
    runSearch,
    pickRepo,
  };
}
