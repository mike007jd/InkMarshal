import { UsagePanel } from '@/components/studio/usage-panel';

// Desktop-only analytics surface: the local AI usage & cost panel. The
// surrounding /desktop-studio layout owns the fixed shell chrome; this page is
// just the main-pane mount for the self-contained client panel (which fetches
// /api/usage and /api/novels itself). Static like the sibling models page — no
// SEO/crawl surface inside the Tauri webview.
export const dynamic = 'force-static';

export default function DesktopStudioUsagePage() {
  return <UsagePanel />;
}
