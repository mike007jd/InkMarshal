import { WorkflowStudioSurface } from '@/components/workflows/WorkflowStudioSurface';

// Desktop-only product surface (W3-2). The surrounding /desktop-studio layout
// owns the fixed shell chrome; this page is the main-pane workflow & template
// editor. Force-static like the models page — all data is fetched client-side
// via server actions against the local SQLite store.
//
// NAV MOUNT POINT: add a sidebar entry in components/DesktopShellLayout.tsx
// alongside the Models / Usage links (see the WORKSPACE_NAV block) pointing at
// `/desktop-studio/workflows`. That file is the studio shell (owned by the lead
// integration), so this feature leaves the link insertion to the shell owner.
export const dynamic = 'force-static';

export default function DesktopStudioWorkflowsPage() {
  return <WorkflowStudioSurface />;
}
