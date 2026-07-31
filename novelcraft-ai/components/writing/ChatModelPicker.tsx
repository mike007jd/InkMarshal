'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAuiState } from '@assistant-ui/react';
import { ChevronDown, Settings2 } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { openModelsPanel } from '@/components/ModelsPanel';
import { useCapabilityBinding } from '@/components/WritingModelStatusBar';
import {
  useConnectionHealth,
  type WritingModelHealth,
} from '@/components/writing-model-health';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { engineStatus, isTauriRuntime, ollamaListTags } from '@/lib/desktop-runtime';
import {
  getCapabilityProfile,
  getConnections,
  saveCapabilityBindingDurable,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import { isLocalEngineConnectionId } from '@/lib/model-supply/local-engine';
import { isOnDeviceRuntimeConnection } from '@/lib/model-supply/readiness';
import { checkConnectionHealth } from '@/lib/model-supply/runtime-health';
import {
  CAPABILITY_ROLES,
  type CapabilityBinding,
  type RuntimeConnection,
} from '@/lib/model-supply/types';

const CONNECTIONS_SSR = '__chat-model-picker-ssr__';
const OPTION_SEPARATOR = '\u001f';

interface ChatModelOption {
  connectionId: string;
  connectionLabel: string;
  isLocal: boolean;
  modelId: string;
  selectable: boolean;
  value: string;
}

function optionValue(connectionId: string, modelId: string): string {
  return `${connectionId}${OPTION_SEPARATOR}${modelId}`;
}

function rememberConfiguredModel(
  target: Record<string, string[]>,
  connectionId: string,
  modelId: string,
): void {
  const existing = target[connectionId];
  if (!existing) {
    target[connectionId] = [modelId];
    return;
  }
  if (!existing.includes(modelId)) {
    existing.push(modelId);
  }
}

function filterConfiguredModels(
  configuredModelIds: readonly string[],
  available: readonly string[],
): string[] {
  return configuredModelIds.filter(modelId => available.includes(modelId));
}

function useConnectionsSnapshot(): {
  configuredModelsByConnection: Record<string, string[]>;
  connections: RuntimeConnection[];
  mounted: boolean;
  resolutionKey: string;
} {
  const snapshot = useSyncExternalStore(
    subscribeConnectionsStore,
    () => JSON.stringify({
      connections: getConnections(),
      profile: getCapabilityProfile(),
    }),
    () => CONNECTIONS_SSR,
  );

  return useMemo(() => {
    if (snapshot === CONNECTIONS_SSR) {
      return {
        configuredModelsByConnection: {},
        connections: [],
        mounted: false,
        resolutionKey: '',
      };
    }
    try {
      const parsed = JSON.parse(snapshot) as {
        connections: RuntimeConnection[];
        profile: ReturnType<typeof getCapabilityProfile>;
      };
      const configuredModelsByConnection: Record<string, string[]> = {};
      for (const role of CAPABILITY_ROLES) {
        const binding = parsed.profile[role];
        if (!binding) continue;
        rememberConfiguredModel(
          configuredModelsByConnection,
          binding.connectionId,
          binding.modelId,
        );
        if (binding.fallback) {
          rememberConfiguredModel(
            configuredModelsByConnection,
            binding.fallback.connectionId,
            binding.fallback.modelId,
          );
        }
      }
      return {
        configuredModelsByConnection,
        connections: parsed.connections,
        mounted: true,
        // Snapshot is already the durable identity for connections + profile.
        resolutionKey: snapshot,
      };
    } catch {
      return {
        configuredModelsByConnection: {},
        connections: [],
        mounted: true,
        resolutionKey: snapshot,
      };
    }
  }, [snapshot]);
}

async function listSelectableModels(
  connection: RuntimeConnection,
  configuredModelIds: readonly string[],
): Promise<string[]> {
  if (isLocalEngineConnectionId(connection.id)) {
    if (!isTauriRuntime()) return [];
    const engineId = connection.id.slice('local-engine:'.length);
    const engines = await engineStatus().catch(() => []);
    if (!engines.some(engine => engine.engineId === engineId)) return [];
    const label = connection.label.replace(/^Local engine · /, '').trim();
    return label ? [label] : [];
  }

  if (connection.transport === 'ollama-native' && isTauriRuntime()) {
    const tags: string[] = await ollamaListTags(connection.baseUrl)
      .catch((): string[] => []);
    if (tags.length > 0) {
      return filterConfiguredModels(configuredModelIds, tags);
    }
  }

  const health = await checkConnectionHealth(connection);
  if (!health.reachable || !health.transportOk) return [];
  if (health.models.length > 0) {
    return filterConfiguredModels(configuredModelIds, health.models);
  }
  return [...configuredModelIds];
}

function fallbackForSelection(
  binding: CapabilityBinding | null,
  connectionId: string,
): CapabilityBinding['fallback'] {
  if (!binding?.fallback || binding.fallback.connectionId === connectionId) {
    return undefined;
  }
  return binding.fallback;
}

function pickerStatusPresentation(
  unavailable: boolean,
  health: WritingModelHealth,
  bound: boolean,
  labels: {
    checking: string;
    down: string;
    ok: string;
    unavailable: string;
  },
): { dotClass: string; healthLabel: string } {
  if (unavailable) {
    return { dotClass: 'bg-book-danger', healthLabel: labels.unavailable };
  }
  if (health === 'ok') {
    return { dotClass: 'bg-book-success', healthLabel: labels.ok };
  }
  if (health === 'down') {
    return { dotClass: 'bg-book-danger', healthLabel: labels.down };
  }
  return {
    dotClass: bound ? 'bg-book-ink-muted' : 'bg-book-gold',
    healthLabel: labels.checking,
  };
}

export function ChatModelPicker({
  onSavingChange,
}: {
  onSavingChange?: (saving: boolean) => void;
}) {
  const { t } = useLanguage();
  const isRunning = useAuiState(state => state.thread.isRunning);
  const { mounted: bindingMounted, resolved } = useCapabilityBinding('chat');
  const {
    configuredModelsByConnection,
    connections,
    mounted: connectionsMounted,
    resolutionKey,
  } = useConnectionsSnapshot();
  const { binding, conn } = resolved;
  const { health } = useConnectionHealth(conn);

  const [resolvedOptions, setResolvedOptions] = useState<{
    modelsByConnection: Record<string, string[]>;
    resolutionKey: string;
  }>({ modelsByConnection: {}, resolutionKey: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);

  useEffect(() => {
    if (!connectionsMounted) return;
    let cancelled = false;
    const sequence = ++loadSequenceRef.current;

    void Promise.all(
      connections.map(async connection => [
        connection.id,
        await listSelectableModels(
          connection,
          configuredModelsByConnection[connection.id] ?? [],
        ),
      ] as const),
    ).then(entries => {
      if (cancelled || loadSequenceRef.current !== sequence) return;
      setResolvedOptions({
        modelsByConnection: Object.fromEntries(entries),
        resolutionKey,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    configuredModelsByConnection,
    connections,
    connectionsMounted,
    resolutionKey,
  ]);

  const loadingOptions = resolvedOptions.resolutionKey !== resolutionKey;

  const options = useMemo<ChatModelOption[]>(() => {
    const next: ChatModelOption[] = [];
    const modelsByConnection = loadingOptions
      ? {}
      : resolvedOptions.modelsByConnection;
    for (const connection of connections) {
      const verified = new Set(modelsByConnection[connection.id] ?? []);
      const modelIds = new Set(verified);
      if (binding?.connectionId === connection.id) {
        modelIds.add(binding.modelId);
      }
      for (const modelId of modelIds) {
        next.push({
          connectionId: connection.id,
          connectionLabel: connection.label,
          isLocal: isOnDeviceRuntimeConnection(connection),
          modelId,
          selectable: verified.has(modelId),
          value: optionValue(connection.id, modelId),
        });
      }
    }
    return next;
  }, [binding, connections, loadingOptions, resolvedOptions.modelsByConnection]);

  const hasSelectableOptions = options.some(option => option.selectable);
  const bound = Boolean(binding && conn);
  const currentValue = binding
    ? optionValue(binding.connectionId, binding.modelId)
    : '';
  const currentModelSelectable = binding
    ? options.some(option => option.value === currentValue && option.selectable)
    : false;
  const currentModelUnavailable = bound
    && !loadingOptions
    && !currentModelSelectable;

  const handleSelect = useCallback((value: string) => {
    if (isRunning || saving) return;
    const option = options.find(candidate => candidate.value === value);
    if (!option?.selectable) return;
    if (
      binding?.connectionId === option.connectionId
      && binding.modelId === option.modelId
    ) {
      return;
    }

    setSaveError(null);
    setSaving(true);
    onSavingChange?.(true);
    void saveCapabilityBindingDurable(
      'draft',
      option.connectionId,
      option.modelId,
      fallbackForSelection(binding, option.connectionId),
    )
      .catch(() => {
        setSaveError(t.capabilitySaveFailed);
      })
      .finally(() => {
        setSaving(false);
        onSavingChange?.(false);
      });
  }, [
    binding,
    isRunning,
    onSavingChange,
    options,
    saving,
    t.capabilitySaveFailed,
  ]);

  const mounted = bindingMounted && connectionsMounted;
  if (!mounted) {
    return (
      <span
        aria-hidden
        className="inline-flex h-7 w-28 rounded-md bg-book-bg-secondary/50"
      />
    );
  }

  if (!bound && !loadingOptions && !hasSelectableOptions) {
    return (
      <Button
        type="button"
        variant="unstyled"
        size="unstyled"
        onClick={() => openModelsPanel()}
        disabled={isRunning}
        className="inline-flex max-w-full items-center gap-1.5 px-2 py-1 text-xs-tight font-medium text-book-ink-secondary transition hover:bg-book-gold/10 hover:text-book-ink-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-book-gold" aria-hidden />
        <span className="truncate">{t.chatModelPickerSetup}</span>
        <Settings2 className="h-3 w-3 shrink-0" aria-hidden />
      </Button>
    );
  }

  const { dotClass, healthLabel } = pickerStatusPresentation(
    currentModelUnavailable,
    health,
    bound,
    {
      checking: t.statusBarHealthChecking,
      down: t.statusBarHealthDown,
      ok: t.statusBarHealthOk,
      unavailable: t.chatModelPickerUnavailable,
    },
  );
  const triggerLabel = bound
    ? binding!.modelId
    : loadingOptions
      ? t.statusBarHealthChecking
      : t.chatModelPickerSetup;
  const connectionLabel = bound
    ? isOnDeviceRuntimeConnection(conn!)
      ? t.statusLocalPrefix
      : conn!.label
    : null;
  const accessibleTriggerLabel = [
    t.chatModelPickerLabel,
    triggerLabel,
    connectionLabel,
    bound ? healthLabel : null,
  ].filter(Boolean).join(' · ');

  return (
    <div data-testid="chat-model-picker" className="flex min-w-0 flex-col items-start gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="unstyled"
            size="unstyled"
            disabled={isRunning || saving || loadingOptions}
            aria-label={accessibleTriggerLabel}
            className="inline-flex max-w-full items-center gap-1.5 px-2 py-1 text-xs-tight text-book-ink-secondary transition hover:bg-book-bg-secondary hover:text-book-ink-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden />
            <span className="max-w-36 truncate font-medium sm:max-w-48">
              {triggerLabel}
            </span>
            {connectionLabel ? (
              <span className="hidden max-w-32 truncate text-book-ink-muted sm:inline">
                · {connectionLabel}
              </span>
            ) : null}
            <ChevronDown className="h-3 w-3 shrink-0 text-book-ink-muted" aria-hidden />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" side="top" className="w-72">
          <DropdownMenuLabel>{t.chatModelPickerLabel}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={currentValue} onValueChange={handleSelect}>
            {options.map(option => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                disabled={!option.selectable || isRunning || saving}
                className="items-start py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{option.modelId}</div>
                  <div className="mt-0.5 truncate text-xs text-book-ink-muted">
                    {option.isLocal ? t.statusLocalPrefix : option.connectionLabel}
                    {!option.selectable ? ` · ${t.chatModelPickerUnavailable}` : ''}
                  </div>
                </div>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openModelsPanel()}>
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
            {t.chatModelPickerManage}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {saveError ? (
        <p role="alert" className="max-w-md text-2xs text-book-danger">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}
