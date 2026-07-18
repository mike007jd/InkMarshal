// GET /api/usage?novelId=&window=7d|30d|all
//   → { window, novelId, aggregate: AiRunAggregateRow[], costPerKWord: CostPerKWordRow[] }
//
// Read-only analytics over the local ai_runs ledger for the cost panel. Desktop-
// only: proxy.ts already 404s /api/* in the web runtime and timing-safe-
// authorizes desktop requests, and getDb() enforces the desktop-runtime DB
// guard — so, like /api/app-settings, no per-novel owner check is required here
// (the data is the single local user's own usage history). The query is a pure
// SQL aggregate; even a thousands-of-rows novel never loads individual rows.

import { NextResponse } from 'next/server';
import { sanitizeError } from '@/lib/utils';
import { aggregateAiRuns, costPerAcceptedKWord } from '@/lib/db/queries-ai-runs';

export const dynamic = 'force-dynamic';

type TimeWindow = '7d' | '30d' | 'all';

function sinceForWindow(window: TimeWindow): string | null {
  if (window === 'all') return null;
  const days = window === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function parseWindow(raw: string | null): TimeWindow {
  return raw === '7d' || raw === '30d' || raw === 'all' ? raw : '30d';
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const novelId = url.searchParams.get('novelId');
    const window = parseWindow(url.searchParams.get('window'));
    const since = sinceForWindow(window);

    const aggregate = aggregateAiRuns({ novelId, since });
    const costPerKWord = costPerAcceptedKWord(novelId, since);

    return NextResponse.json({ window, novelId: novelId ?? null, aggregate, costPerKWord });
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeError(error, 'Failed to read usage') },
      { status: 500 },
    );
  }
}
