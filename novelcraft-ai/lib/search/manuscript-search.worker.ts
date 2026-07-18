/// <reference lib="webworker" />

import { searchManuscriptSync, type SearchRequest, type SearchResponse } from './manuscript-search';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<SearchRequest>) => {
  const { id, chapters, query } = event.data;
  const results = searchManuscriptSync(chapters, query);
  const response: SearchResponse = { id, results };
  ctx.postMessage(response);
});

export {};
