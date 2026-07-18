#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');
const rows = [];

for (const line of input.split(/\r?\n/)) {
  const match = line.match(
    /^(\d{2}:\d{2}:\d{2}\.\d+)\s+(\S+)\s+(\S+)\s+(?:(λ|ε|◇)\s+)?([A-Z]+)\s+(\S+)\s+(\d{3})\b/,
  );
  if (!match) continue;
  const [, time, host, level, source = 'plain', method, path, status] = match;
  rows.push({ time, host, level, source, method, path, status });
}

function countBy(keyFor, sourceRows = rows) {
  const counts = new Map();
  for (const row of sourceRows) {
    const key = keyFor(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function printSection(title, entries, limit = 20) {
  console.log(`\n${title}`);
  if (entries.length === 0) {
    console.log('  none');
    return;
  }
  for (const [key, count] of entries.slice(0, limit)) {
    console.log(`${String(count).padStart(5)}  ${key}`);
  }
}

console.log(`Parsed ${rows.length} request log rows.`);
printSection(
  'Top routes',
  countBy((row) => `${row.source} ${row.method} ${row.path} ${row.status}`),
);
printSection(
  'Top lambda routes',
  countBy(
    (row) => `${row.method} ${row.path} ${row.status}`,
    rows.filter((row) => row.source === 'λ'),
  ),
);
printSection(
  '404 routes',
  countBy(
    (row) => `${row.method} ${row.path}`,
    rows.filter((row) => row.status === '404'),
  ),
);
