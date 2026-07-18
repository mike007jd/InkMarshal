import { ModelsPanelSurface } from '@/components/ModelsPanel';

// Desktop-only product surface. The surrounding /desktop-studio layout owns the
// fixed shell chrome; this page is the main-pane version of model management.
export const dynamic = 'force-static';

export default function DesktopStudioModelsPage() {
  return <ModelsPanelSurface defaultTab="local" />;
}
