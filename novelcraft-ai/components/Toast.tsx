'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, CheckCircle, Info } from 'lucide-react';

import { Button } from '@/components/ui/button';

type ToastType = 'error' | 'success' | 'info';

/** Optional action attached to a toast. Renders as an inline link button next
 *  to the close icon. When `onClick` runs, the toast auto-dismisses. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Inline action button (e.g. "Retry", "Undo"). */
  action?: ToastAction;
  /** Override the default dismiss delay (default 5000 ms). */
  durationMs?: number;
}

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  action?: ToastAction;
  leaving: boolean;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

const MAX_TOASTS = 5;
const DEFAULT_DURATION_MS = 5000;
// Toasts carrying an action (Undo / Retry) stay longer so the link doesn't
// vanish before the user can react.
const ACTION_DURATION_MS = 9000;

const borderMap: Record<ToastType, string> = {
  error: 'border-l-4 border-l-book-danger border-book-border',
  success: 'border-l-4 border-l-book-success border-book-border',
  info: 'border-l-4 border-l-book-gold border-book-border',
};

const iconClassMap: Record<ToastType, string> = {
  error: 'w-4 h-4 text-book-danger shrink-0 mt-0.5',
  success: 'w-4 h-4 text-book-success shrink-0 mt-0.5',
  info: 'w-4 h-4 text-book-gold shrink-0 mt-0.5',
};

const IconComponent = { error: AlertTriangle, success: CheckCircle, info: Info };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Tracks each live toast's deadline so hover can pause/resume the countdown.
  const expiryRef = useRef<Map<string, { expiresAt: number; remaining: number | null }>>(new Map());
  // Discover the optional `#toast-anchor` element rendered by the desktop
  // shell. When present, toasts portal into it so they stay clear of the
  // persistent StageBar / ManuscriptSidebar. The anchor belongs to routed
  // layout content, so retaining it in state can leave portals attached to a
  // detached node after navigation. Resolve it afresh whenever toast state
  // renders and fall back to the fixed container when it is absent or stale.

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    expiryRef.current.delete(id);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    clearTimer(id);
  }, [clearTimer]);

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
  }, [clearTimer]);

  const scheduleDismiss = useCallback((id: string, ms: number) => {
    const existing = timersRef.current.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      expiryRef.current.delete(id);
      setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
    }, ms);
    timersRef.current.set(id, timer);
    expiryRef.current.set(id, { expiresAt: Date.now() + ms, remaining: null });
  }, []);

  // Pause the countdown while the pointer/focus is on the toast so an actionable
  // toast (Undo / Retry) can't expire out from under the user mid-reach.
  const pauseToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    const e = expiryRef.current.get(id);
    if (e) e.remaining = Math.max(0, e.expiresAt - Date.now());
  }, []);

  const resumeToast = useCallback((id: string) => {
    const e = expiryRef.current.get(id);
    if (e && e.remaining != null) scheduleDismiss(id, e.remaining);
  }, [scheduleDismiss]);

  const toast = useCallback((message: string, type: ToastType = 'error', options?: ToastOptions) => {
    const id = crypto.randomUUID();
    const item: ToastItem = { id, message, type, action: options?.action, leaving: false };
    setToasts(prev => {
      const next = [...prev, item];
      if (next.length <= MAX_TOASTS) return next;
      const evicted = next.slice(0, next.length - MAX_TOASTS);
      for (const toast of evicted) {
        const timer = timersRef.current.get(toast.id);
        if (timer) clearTimeout(timer);
        timersRef.current.delete(toast.id);
        expiryRef.current.delete(toast.id);
      }
      return next.slice(next.length - MAX_TOASTS);
    });
    const duration = options?.durationMs ?? (options?.action ? ACTION_DURATION_MS : DEFAULT_DURATION_MS);
    scheduleDismiss(id, duration);
  }, [scheduleDismiss]);

  const handleAction = useCallback((id: string, onClick: () => void) => {
    try {
      onClick();
    } finally {
      dismiss(id);
    }
  }, [dismiss]);

  const candidateAnchorEl = toasts.length > 0 && typeof document !== 'undefined'
    ? document.getElementById('toast-anchor')
    : null;
  const anchorEl = candidateAnchorEl?.isConnected ? candidateAnchorEl : null;

  const toastList = (
    <div
      className={
        anchorEl
          ? 'absolute bottom-3 right-3 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none'
          : 'fixed bottom-6 right-6 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none'
      }
    >
      {toasts.map(t => {
        const Icon = IconComponent[t.type];
        return (
          <div
            key={t.id}
            onMouseEnter={() => { if (!t.leaving) pauseToast(t.id); }}
            onMouseLeave={() => { if (!t.leaving) resumeToast(t.id); }}
            onFocusCapture={() => { if (!t.leaving) pauseToast(t.id); }}
            onBlurCapture={() => { if (!t.leaving) resumeToast(t.id); }}
            onAnimationEnd={event => {
              if (event.target === event.currentTarget && t.leaving) removeToast(t.id);
            }}
            className={`${t.leaving ? 'pointer-events-none animate-toast-out' : 'pointer-events-auto animate-toast-in'} bg-book-bg-card border ${borderMap[t.type]} rounded-lg shadow-lg p-4 flex items-start gap-3`}
          >
            <Icon className={iconClassMap[t.type]} />
            <p className="text-sm text-book-ink-primary flex-1">{t.message}</p>
            {t.action && (
              <Button
                type="button"
                variant="unstyled"
                size="unstyled"
                onClick={() => handleAction(t.id, t.action!.onClick)}
                className="shrink-0 text-sm font-medium text-book-gold hover:text-book-gold-light underline-offset-2 hover:underline"
              >
                {t.action.label}
              </Button>
            )}
            <Button
              type="button"
              variant="unstyled"
              size="unstyled"
              onClick={() => dismiss(t.id)}
              className="text-book-ink-muted hover:text-book-ink-primary shrink-0"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 && (
        anchorEl
          ? createPortal(toastList, anchorEl)
          : toastList
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
