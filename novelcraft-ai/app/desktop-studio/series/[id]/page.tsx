'use client';

import { useParams } from 'next/navigation';

import { SeriesWorkspace } from '@/components/studio/series-workspace';

// Desktop-only product surface (W3-3 series / shared worldbuilding). Thin
// client wrapper (same shape as app/novel/[id]/page.tsx) — the series id is a
// runtime UUID unknown at build time, so the route reads it client-side and the
// self-contained SeriesWorkspace fetches everything via server actions against
// the local SQLite store. The surrounding /desktop-studio layout owns the fixed
// shell chrome.
//
// NAV MOUNT POINTS (left to the studio-shell owner):
//   1. A series index / picker in components/DesktopShellLayout.tsx WORKSPACE_NAV
//      alongside Models / Usage / Workflows, deep-linking here.
//   2. A "归属系列 / Belongs to series" selector in the novel settings surface
//      wired to the `addNovelToSeries` / `removeNovelFromSeries` server actions
//      in app/actions/series.ts.
export default function DesktopStudioSeriesPage() {
  const params = useParams();
  const seriesId = params.id as string;
  return <SeriesWorkspace seriesId={seriesId} />;
}
