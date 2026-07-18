import { DesktopRuntimeGate } from '@/components/DesktopRuntimeGate';
import { DesktopShell } from '@/components/DesktopShellLayout';

// Wave 3 commit 1: every per-novel route is mounted inside the same
// DesktopShell so the sidebar (novel list, "new novel", models, settings)
// stays in the same DOM subtree across novel switches. This means switching
// books behaves as a main-pane swap, not a layout reflow.
export default function NovelLayout({ children }: { children: React.ReactNode }) {
  return (
    <DesktopRuntimeGate>
      <DesktopShell>{children}</DesktopShell>
    </DesktopRuntimeGate>
  );
}
