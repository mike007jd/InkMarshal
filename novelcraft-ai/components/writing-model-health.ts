'use client';

import { useEffect, useRef, useState } from 'react';

import { checkConnectionHealth } from '@/lib/model-supply/runtime-health';
import type { RuntimeConnection } from '@/lib/model-supply/types';

export type WritingModelHealth = 'unknown' | 'ok' | 'down';

export function useConnectionHealth(conn: RuntimeConnection | undefined): {
  health: WritingModelHealth;
  latencyMs: number | null;
} {
  const [health, setHealth] = useState<WritingModelHealth>('unknown');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const healthSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const seq = ++healthSeqRef.current;
    const reset = () => {
      queueMicrotask(() => {
        if (cancelled || healthSeqRef.current !== seq) return;
        setHealth('unknown');
        setLatencyMs(null);
      });
    };

    reset();
    if (!conn) {
      return () => {
        cancelled = true;
      };
    }

    void checkConnectionHealth(conn).then(h => {
      if (cancelled || healthSeqRef.current !== seq) return;
      setHealth(h.reachable && h.transportOk ? 'ok' : 'down');
      setLatencyMs(h.latencyMs > 0 ? h.latencyMs : null);
    });

    return () => {
      cancelled = true;
    };
  }, [conn]);

  return { health, latencyMs };
}
