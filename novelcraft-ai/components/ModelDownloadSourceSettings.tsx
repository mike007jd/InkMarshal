'use client';

import { useEffect, useState } from 'react';
import { Globe2, Save } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import {
  hfGetEndpoint,
  hfSetEndpoint,
  isTauriRuntime,
  type HfEndpointStatus,
} from '@/lib/desktop-runtime';

const OFFICIAL_ENDPOINT = 'https://huggingface.co';
const MIRROR_ENDPOINT = 'https://hf-mirror.com';

type DownloadSourceChoice = 'official' | 'mirror' | 'custom';

function choiceFor(status: HfEndpointStatus): DownloadSourceChoice {
  if (!status.configuredEndpoint || status.configuredEndpoint === OFFICIAL_ENDPOINT) return 'official';
  if (status.configuredEndpoint === MIRROR_ENDPOINT) return 'mirror';
  return 'custom';
}

export function ModelDownloadSourceSettings() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<HfEndpointStatus | null>(null);
  const [choice, setChoice] = useState<DownloadSourceChoice>('official');
  const [customEndpoint, setCustomEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void hfGetEndpoint().then(next => {
      if (cancelled) return;
      setAvailable(true);
      setStatus(next);
      setChoice(choiceFor(next));
      if (next.configuredEndpoint && next.configuredEndpoint !== MIRROR_ENDPOINT) {
        setCustomEndpoint(next.configuredEndpoint);
      }
    }).catch(() => {
      if (!cancelled) {
        setAvailable(true);
        setError(t.modelDownloadSourceLoadFailed);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [t.modelDownloadSourceLoadFailed]);

  if (!available) return null;

  const persist = async (nextChoice: DownloadSourceChoice) => {
    if (busy) return;
    const endpoint = nextChoice === 'official'
      ? null
      : nextChoice === 'mirror'
        ? MIRROR_ENDPOINT
        : customEndpoint.trim();
    if (nextChoice === 'custom' && !endpoint) {
      setError(t.modelDownloadSourceInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await hfSetEndpoint(endpoint);
      setStatus(next);
      setChoice(choiceFor(next));
      toast(t.modelDownloadSourceSaved, 'success');
    } catch (caught) {
      if (status) setChoice(choiceFor(status));
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : t.modelDownloadSourceInvalid,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleChoice = (value: string) => {
    const nextChoice = value as DownloadSourceChoice;
    setChoice(nextChoice);
    setError(null);
    if (nextChoice !== 'custom') void persist(nextChoice);
  };

  return (
    <section className="flex flex-col gap-3 border-t border-book-border pt-5">
      <div className="flex items-start gap-2">
        <Globe2 className="mt-0.5 size-4 shrink-0 text-book-ink-muted" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold text-book-ink-secondary">
            {t.modelDownloadSourceTitle}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-book-ink-secondary">
            {t.modelDownloadSourceDescription}
          </p>
        </div>
      </div>

      <Select value={choice} onValueChange={handleChoice} disabled={busy}>
        <SelectTrigger aria-label={t.modelDownloadSourceLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="official">{t.modelDownloadSourceOfficial}</SelectItem>
          <SelectItem value="mirror">{t.modelDownloadSourceMirror}</SelectItem>
          <SelectItem value="custom">{t.modelDownloadSourceCustom}</SelectItem>
        </SelectContent>
      </Select>

      {choice === 'custom' && (
        <div className="flex gap-2">
          <Input
            type="url"
            value={customEndpoint}
            placeholder={t.modelDownloadSourceCustomPlaceholder}
            aria-invalid={Boolean(error)}
            onChange={event => {
              setCustomEndpoint(event.target.value);
              setError(null);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || !customEndpoint.trim()}
            onClick={() => void persist('custom')}
          >
            {busy ? <Spinner size="sm" /> : <Save className="size-4" aria-hidden />}
            {t.modelDownloadSourceSave}
          </Button>
        </div>
      )}

      {status && (
        <p className="break-all text-xs text-book-ink-muted" role="status">
          {t.modelDownloadSourceEffective.replace('{endpoint}', status.effectiveEndpoint)}
        </p>
      )}
      {status?.source === 'environment' && (
        <p className="text-xs text-book-gold" role="status">
          {t.modelDownloadSourceEnvironmentOverride}
        </p>
      )}
      {error && <p className="text-xs text-book-danger" role="alert">{error}</p>}
    </section>
  );
}
