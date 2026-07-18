import type { DesktopStatus, EngineFormat, EngineInfo } from '@/lib/desktop-runtime';
import {
  normalizeModelPathForCompare,
} from '@/lib/model-supply/orchestrator';
import { formatBytes } from '@/lib/model-supply/format';
import { repoDirCandidates } from '@/lib/model-supply/repo-paths';
import {
  classifyStarterFit,
  repoForStarterEntry,
  resolveStarterFormat,
} from '@/lib/model-supply/starter-models';
import type {
  CapabilityRole,
  CuratedModelEntry,
  InstalledLocalModel,
} from '@/lib/model-supply/types';

export type FitState = 'good' | 'tight' | 'bad' | 'unknown';

export interface FitCopy {
  bad: string;
  badDetail: string;
  tight: string;
  tightDetail: string;
  good: string;
  goodDetail: string;
  unknown: string;
  unknownDetail: string;
}

export interface FitResult {
  state: FitState;
  label: string;
  detail: string;
}

export interface HardwareLabelCopy {
  mac: string;
  device: string;
  unknown: string;
}

export interface RoleBindingInfo {
  engineId: string;
  connectionId: string;
  modelId: string;
}

export function groupRunningEnginesByModelPath(
  runningEngines: readonly EngineInfo[],
): Map<string, EngineInfo[]> {
  const map = new Map<string, EngineInfo[]>();
  for (const engine of runningEngines) {
    const key = normalizeModelPathForCompare(engine.modelPath);
    const engines = map.get(key) ?? [];
    engines.push(engine);
    map.set(key, engines);
  }
  return map;
}

export function groupRolesByEngineId(
  roleBindings: ReadonlyMap<CapabilityRole, RoleBindingInfo>,
): Map<string, CapabilityRole[]> {
  const map = new Map<string, CapabilityRole[]>();
  for (const [role, info] of roleBindings.entries()) {
    const existing = map.get(info.engineId);
    if (existing) existing.push(role);
    else map.set(info.engineId, [role]);
  }
  return map;
}

export function localModelHardwareLabel({
  isMac,
  status,
  copy,
}: {
  isMac: boolean;
  status: Pick<DesktopStatus, 'arch' | 'total_memory_bytes'> | null;
  copy: HardwareLabelCopy;
}): string {
  const parts = [
    isMac ? copy.mac : copy.device,
    status?.arch ? status.arch : null,
    status?.total_memory_bytes ? formatBytes(status.total_memory_bytes) : null,
  ].filter(Boolean);
  return parts.join(' · ') || copy.unknown;
}

export function fitForStarterEntry(
  entry: CuratedModelEntry,
  totalMemoryBytes: number | null | undefined,
  copy: FitCopy,
): FitResult {
  const state = classifyStarterFit(entry, totalMemoryBytes);
  switch (state) {
    case 'bad':
      return { state, label: copy.bad, detail: copy.badDetail };
    case 'tight':
      return { state, label: copy.tight, detail: copy.tightDetail };
    case 'good':
      return { state, label: copy.good, detail: copy.goodDetail };
    default:
      return { state, label: copy.unknown, detail: copy.unknownDetail };
  }
}

export function repoForStarterFormat(
  entry: CuratedModelEntry,
  activeFormat: EngineFormat,
): string | null {
  const format = resolveStarterFormat(entry, activeFormat);
  return format ? repoForStarterEntry(entry, format) : null;
}

export function findInstalledStarterModel({
  entry,
  activeFormat,
  installed,
}: {
  entry: CuratedModelEntry;
  activeFormat: EngineFormat;
  installed: readonly InstalledLocalModel[];
}): InstalledLocalModel | null {
  const repo = repoForStarterFormat(entry, activeFormat);
  if (!repo) return null;
  const repoDirs = repoDirCandidates(repo);
  const format = resolveStarterFormat(entry, activeFormat);
  if (!format) return null;
  return (
    installed.find(model => {
      if (model.format !== format) return false;
      if (model.sourceRepo === repo) return true;
      if (format === 'mlx' && repoDirs.some(repoDir => model.modelPath.includes(repoDir))) return true;
      return model.label === entry.name;
    }) ?? null
  );
}
