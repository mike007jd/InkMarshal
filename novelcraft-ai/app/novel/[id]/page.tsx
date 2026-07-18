'use client';

import { useParams } from 'next/navigation';

import { NovelWorkspace } from '@/components/NovelWorkspace';

// Wave 3 commit 1: per-novel route is now a thin wrapper. NovelWorkspace owns
// the 4-tab IA + manuscript session. The desktop chrome is provided by the
// route's layout (DesktopShell), which the SSR root layout already wraps in
// providers, so nothing else lives here.
export default function NovelPage() {
  const params = useParams();
  const novelId = params.id as string;
  return <NovelWorkspace novelId={novelId} initialView="agent" />;
}
