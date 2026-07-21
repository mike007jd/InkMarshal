import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('LocalModelsPanel removal path', () => {
  it('does not use the legacy all-role local-engine rebinder after deleting a model', () => {
    const source = readFileSync(join(process.cwd(), 'components/LocalModelsPanel.tsx'), 'utf8');

    expect(source).not.toContain('startAndBindLocalEngine');
    expect(source).not.toContain('clearLocalEngineBindings');
    expect(source).toContain('stopEngineAndUnbind');
  });

  it('guards duplicate HF downloads before React progress state renders', () => {
    const source = readFileSync(join(process.cwd(), 'components/LocalModelsPanel.tsx'), 'utf8');

    expect(source).toContain('const activeDownloadTasksRef = useRef<Set<string>>(new Set())');
    expect(source.match(/activeDownloadTasksRef\.current\.has\(taskId\)/g)).toHaveLength(2);
    expect(source.match(/activeDownloadTasksRef\.current\.add\(taskId\)/g)).toHaveLength(2);
    expect(source.match(/activeDownloadTasksRef\.current\.delete\(taskId\)/g)).toHaveLength(2);
  });

  it('guards duplicate local model removal before React disabled state renders', () => {
    const source = readFileSync(join(process.cwd(), 'components/LocalModelsPanel.tsx'), 'utf8');

    expect(source).toContain('const removingModelPathsRef = useRef<Set<string>>(new Set())');
    expect(source).toContain('if (removingModelPathsRef.current.has(model.modelPath)) return;');
    expect(source).toContain('removingModelPathsRef.current.add(model.modelPath)');
    expect(source).toContain('removingModelPathsRef.current.delete(model.modelPath)');
  });

  it('exposes a user-changeable model folder instead of a raw read-only path', () => {
    const panel = readFileSync(join(process.cwd(), 'components/LocalModelsPanel.tsx'), 'utf8');
    const runtime = readFileSync(join(process.cwd(), 'lib/desktop-runtime.ts'), 'utf8');
    const rustPaths = readFileSync(join(process.cwd(), 'src-tauri/src/model_manager/paths.rs'), 'utf8');

    expect(panel).toContain('MODEL_ROOT_SETTING_KEY');
    expect(panel).toContain('pickModelDir(status?.model_dir)');
    expect(panel).toContain('setStoredSetting(MODEL_ROOT_SETTING_KEY, saved)');
    expect(panel).toContain('removeStoredSetting(MODEL_ROOT_SETTING_KEY)');
    expect(panel).toContain('t.modelManagerChangeFolder');
    expect(panel).toContain('t.modelManagerRevealFolder');
    expect(runtime).toContain("revealModelDir: 'reveal_model_dir'");
    expect(rustPaths).toContain('pub fn reveal_model_dir');
    expect(rustPaths).toContain('resolve_existing_model_dir_path');
  });
});

describe('Models surface IA', () => {
  it('exposes models as a first-class desktop-studio route while preserving the drawer surface', () => {
    const modelsPanel = readFileSync(join(process.cwd(), 'components/ModelsPanel.tsx'), 'utf8');
    const page = readFileSync(join(process.cwd(), 'app/desktop-studio/models/page.tsx'), 'utf8');
    const shell = readFileSync(join(process.cwd(), 'components/DesktopShellLayout.tsx'), 'utf8');

    expect(modelsPanel).toContain('export function ModelsPanelSurface');
    expect(page).toContain("import { ModelsPanelSurface } from '@/components/ModelsPanel';");
    expect(page).toContain('<ModelsPanelSurface defaultTab="local" />');
    expect(shell).toContain("router.push('/desktop-studio/models')");
    expect(shell).toContain('href="/desktop-studio/models"');
  });

  it('keeps local LLM setup as the primary path instead of leading with admin diagnostics', () => {
    const modelsPanel = readFileSync(join(process.cwd(), 'components/ModelsPanel.tsx'), 'utf8');
    const localModels = readFileSync(join(process.cwd(), 'components/LocalModelsPanel.tsx'), 'utf8');
    const localControls = readFileSync(join(process.cwd(), 'components/models/LocalModelControls.tsx'), 'utf8');
    const shell = readFileSync(join(process.cwd(), 'components/DesktopShellLayout.tsx'), 'utf8');
    const studio = readFileSync(join(process.cwd(), 'components/DesktopStudioShell.tsx'), 'utf8');

    expect(modelsPanel).toContain('<DiagnosticsPanel includeNoModels={false} />');
    expect(localModels).toContain('<StudioFirstRunWizard');
    expect(localModels).toContain('onBrowseAllModels={() => setShowAdvancedManager(true)}');
    expect(localModels).toContain("import {\n  Collapsible,\n  CollapsibleContent,\n  CollapsibleTrigger,\n} from '@/components/ui/collapsible';");
    expect(localModels.indexOf('<Collapsible className="rounded-md')).toBeLessThan(
      localModels.indexOf('{t.modelManagerSearchTitle}'),
    );
    expect(localModels.indexOf('{t.modelManagerCapabilityTitle}')).toBeLessThan(
      localModels.indexOf('<HardDrive className="h-3.5 w-3.5 text-book-ink-muted" />'),
    );
    expect(localModels.indexOf('<HardDrive className="h-3.5 w-3.5 text-book-ink-muted" />')).toBeLessThan(
      localModels.indexOf('<Layers className="h-3.5 w-3.5 text-book-ink-muted" />'),
    );
    expect(localModels).toContain('t.localModelsUnassigned');
    expect(localControls).toContain('t.modelManagerStartAndAssign');
    expect(localControls).not.toContain('t.modelManagerUse');
    expect(shell).not.toContain("router.push('/desktop-studio/models');\n      return;\n    }");
    expect(shell).not.toContain("creationMode: 'blank'");
    expect(shell).toContain('{t.newNovel}');
    // Model setup stays discoverable without blocking manual writing. Every
    // New Novel entry opens the shared idea / blank / import chooser, and the
    // explicit Blank manuscript choice still reaches the editor directly.
    expect(shell).not.toContain('const newNovelActionLabel');
    expect(shell).toContain('modelReadinessCoverageTooltip');
    expect(shell).toContain("router.push('/desktop-studio')");
    expect(shell).not.toContain('?view=read-edit&chapter=1&edit=1');
    expect(shell).toContain('onClick={isActive ? event => event.preventDefault() : undefined}');
    expect(studio).not.toContain('handleAgentSubmit');
    expect(studio).not.toContain('initialPrompt');
    expect(studio).toContain('handleCreateNovel');
    expect(studio).toContain('openingAssistantMessage: t.agentOpeningMessage');
    expect(studio).toContain("creationMode: 'blank'");
    expect(studio).toContain('{t.startWithIdea}');
    expect(studio).toContain('{t.blankManuscript}');
    expect(studio).toContain('{t.agentNewChatTitle}');
  });

  it('makes own-model import first-class and keeps format filters scoped to HF search', () => {
    const localModels = readFileSync(join(process.cwd(), 'components/LocalModelsPanel.tsx'), 'utf8');
    const wizard = readFileSync(join(process.cwd(), 'components/StudioFirstRunWizard.tsx'), 'utf8');

    expect(localModels).toContain("const RECOMMENDED_FORMAT: EngineFormat = 'gguf'");
    expect(localModels).toContain("onImportGguf={() => void importExistingModel('gguf')}");
    expect(localModels).toContain("onImportMlx={isMac ? () => void importExistingModel('mlx') : undefined}");
    expect(localModels.indexOf("setFormat('gguf')")).toBeGreaterThan(
      localModels.indexOf('<CollapsibleContent className="mt-3 space-y-3">'),
    );
    expect(localModels).toContain('presetRoles ?? (coverage.notReadyRoles.length > 0');
    expect(wizard).toContain('{t.firstRunUseOwnModel}');
    expect(wizard).toContain('{t.modelManagerLocalFormatHelp}');
  });

  it('lets repair links open the routing tab without breaking default local opens', () => {
    const modelsPanel = readFileSync(join(process.cwd(), 'components/ModelsPanel.tsx'), 'utf8');
    const statusBar = readFileSync(join(process.cwd(), 'components/WritingModelStatusBar.tsx'), 'utf8');

    expect(modelsPanel).toContain("export type ModelsPanelTab = 'local' | 'providers';");
    expect(modelsPanel).toContain("new CustomEvent(OPEN_MODELS_EVENT, { detail: { defaultTab } })");
    expect(statusBar).toContain("openModelsPanel('providers')");
  });

  it('keeps healthy manuscript model status silent and collapses its empty wrappers', () => {
    const notice = readFileSync(join(process.cwd(), 'components/WritingModelDotBadge.tsx'), 'utf8');
    const manuscript = readFileSync(join(process.cwd(), 'components/ManuscriptShell.tsx'), 'utf8');

    expect(notice).toContain("health === 'down'");
    expect(notice).toContain('return null;');
    expect(notice).not.toContain('model-health-dot');
    expect(manuscript.match(/empty:hidden/g)).toHaveLength(2);
  });
});
