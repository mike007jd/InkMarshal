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
import { useConnectionHealth } from '@/components/writing-model-health';
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

function useConnectionsSnapshot(): {
  configuredModelsByConnection: Record<string, string[]>;
  connections: RuntimeConnection[];
  mounted: boolean;
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
        configuredModelsByConnection[binding.connectionId] = Array.from(new Set([
          ...(configuredModelsByConnection[binding.connectionId] ?? []),
          binding.modelId,
        ]));
        if (binding.fallback) {
          configuredModelsByConnection[binding.fallback.connectionId] = Array.from(new Set([
            ...(configuredModelsByConnection[binding.fallback.connectionId] ?? []),
            binding.fallback.modelId,
          ]));
        }
      }
      return {
        configuredModelsByConnection,
        connections: parsed.connections,
        mounted: true,
      };
    } catch {
      return {
        configuredModelsByConnection: {},
        connections: [],
        mounted: true,
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
      return configuredModelIds.filter(modelId => tags.includes(modelId));
    }
  }

  const health = await checkConnectionHealth(connection);
  if (!health.reachable || !health.transportOk) return [];
  if (health.models.length > 0) {
    return configuredModelIds.filter(modelId => health.models.includes(modelId));
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
  } = useConnectionsSnapshot();
  const { binding, conn } = resolved;
  const { health } = useConnectionHealth(conn);

  const connectionsKey = useMemo(() => JSON.stringify(connections), [connections]);
  const configuredModelsKey = useMemo(
    () => JSON.stringify(configuredModelsByConnection),
    [configuredModelsByConnection],
  );
  const resolutionKey = `${connectionsKey}:${configuredModelsKey}`;
  const [resolvedOptions, setResolvedOptions] = useState<{
    connectionsKey: string;
    modelsByConnection: Record<string, string[]>;
  }>({ connectionsKey: '', modelsByConnection: {} });
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
        connectionsKey: resolutionKey,
        modelsByConnection: Object.fromEntries(entries),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    configuredModelsByConnection,
    configuredModelsKey,
    connections,
    connectionsKey,
    connectionsMounted,
    resolutionKey,
  ]);

  const loadingOptions = resolvedOptions.connectionsKey !== resolutionKey;

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

  const selectableOptions = options.filter(option => option.selectable);
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

  if (!bound && !loadingOptions && selectableOptions.length === 0) {
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

  const dotClass =
    currentModelUnavailable
      ? 'bg-book-danger'
      : health === 'ok'
      ? 'bg-book-success'
      : health === 'down'
        ? 'bg-book-danger'
        : bound
          ? 'bg-book-ink-muted'
          : 'bg-book-gold';
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
  const healthLabel =
    currentModelUnavailable
      ? t.chatModelPickerUnavailable
      : health === 'ok'
      ? t.statusBarHealthOk
      : health === 'down'
        ? t.statusBarHealthDown
        : t.statusBarHealthChecking;
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
