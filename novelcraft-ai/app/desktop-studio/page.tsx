import DesktopStudioShell from '@/components/DesktopStudioShell';

// The desktop Studio is only ever rendered inside the Tauri webview — it is not
// crawlable and has no SEO surface, so there is no generateMetadata / noindex
// dance here (those exist for the web acquisition pages, not the fixed window).
export const dynamic = 'force-static';

export default function DesktopStudioPage() {
  return <DesktopStudioShell />;
}
