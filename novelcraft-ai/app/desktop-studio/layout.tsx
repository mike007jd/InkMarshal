import { DesktopRuntimeGate } from '@/components/DesktopRuntimeGate';
import { DesktopShell } from '@/components/DesktopShellLayout';

// Wave 3 commit 1: /desktop-studio shares the same shell chrome as /novel/[id]
// so switching between the home screen and a novel does not unmount the
// sidebar. The page body is just the Studio HOME content.
export default function DesktopStudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <DesktopRuntimeGate>
      <DesktopShell>{children}</DesktopShell>
    </DesktopRuntimeGate>
  );
}
