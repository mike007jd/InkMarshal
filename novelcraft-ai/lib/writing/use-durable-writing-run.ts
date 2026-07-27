'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Chapter, Novel } from '@/lib/db-types';
import type { WritingJob } from '@/lib/db/queries-writing-jobs';
import {
  DurableWritingRunController,
  type DurableWritingLabels,
} from '@/lib/writing/durable-writing-run';
import type {
  DurableWritingRunResolution,
  WritingRunState,
} from '@/lib/writing/writing-run-reducer';

export interface DurableWritingRun {
  novel: Novel | null;
  chapters: Chapter[];
  fetchNovel(): Promise<Novel>;
  fetchChapters(): Promise<Chapter[]>;
  beginRun(): void;
  invalidateReads(): void;
  patchNovel(patch: Partial<Novel>): void;
  replaceNovel(novel: Novel): void;
  upsertChapter(chapter: Chapter): void;
  resolve(local: WritingRunState, labels: DurableWritingLabels): DurableWritingRunResolution | null;
}

export function useDurableWritingRun(novelId: string): DurableWritingRun {
  const controllerRef = useRef(new DurableWritingRunController(novelId));
  const [novel, setNovel] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [latestJob, setLatestJob] = useState<WritingJob | null>(null);

  useEffect(() => {
    controllerRef.current.resetScope(novelId);
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setNovel(null);
      setChapters([]);
      setLatestJob(null);
    });
    return () => {
      cancelled = true;
    };
  }, [novelId]);

  const fetchNovel = useCallback(async () => {
    const controller = controllerRef.current;
    const token = controller.captureRead();
    const response = await fetch(`/api/novels/${novelId}`);
    if (!response.ok) throw new Error(`Failed to fetch novel (HTTP ${response.status})`);
    const data = await response.json() as Novel & { writingJob?: WritingJob | null };
    if (controller.canCommit(token)) {
      const job = data.writingJob ?? null;
      controller.acceptJob(job);
      setLatestJob(job);
      setNovel(data);
    }
    return data;
  }, [novelId]);

  const fetchChapters = useCallback(async () => {
    const controller = controllerRef.current;
    const token = controller.captureRead();
    const response = await fetch(`/api/novels/${novelId}/chapters`);
    if (!response.ok) throw new Error('Failed to fetch chapters');
    const data = await response.json() as Chapter[];
    if (controller.canCommit(token)) setChapters(data);
    return data;
  }, [novelId]);

  const beginRun = useCallback(() => {
    controllerRef.current.invalidateForNewRun();
    setLatestJob(null);
  }, []);

  const invalidateReads = useCallback(() => {
    controllerRef.current.invalidateReads();
  }, []);

  const patchNovel = useCallback((patch: Partial<Novel>) => {
    setNovel(current => current ? { ...current, ...patch } : current);
  }, []);

  const replaceNovel = useCallback((next: Novel) => {
    setNovel(next);
  }, []);

  const upsertChapter = useCallback((chapter: Chapter) => {
    controllerRef.current.invalidateReads();
    setChapters(current => {
      const withoutChapter = current.filter(
        existing => existing.chapterNumber !== chapter.chapterNumber,
      );
      return [...withoutChapter, chapter].sort(
        (left, right) => left.chapterNumber - right.chapterNumber,
      );
    });
  }, []);

  const resolve = useCallback((
    local: WritingRunState,
    labels: DurableWritingLabels,
  ) => {
    if (!novel) return null;
    return controllerRef.current.resolve(
      { novel, chapterCount: chapters.length, job: latestJob },
      local,
      labels,
    );
  }, [chapters.length, latestJob, novel]);

  return {
    novel,
    chapters,
    fetchNovel,
    fetchChapters,
    beginRun,
    invalidateReads,
    patchNovel,
    replaceNovel,
    upsertChapter,
    resolve,
  };
}
