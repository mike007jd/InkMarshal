// Wave 2 commit B — extract `[[Target]]` wikilinks from entry bodies.
//
// `parseWikilinks` is cheap, sync, and runs on the writer path so the editor
// stays snappy even when an entry has dozens of links. It is deliberately
// self-contained (no SQLite imports) so it stays client-safe — the editor form
// imports it directly. A server-side index-resolve step was prototyped but was
// never wired onto a read path, so it has been removed rather than left as
// dead code; reintroduce resolution as its own server-only module when a read
// path actually needs it.

import type { OutgoingLink } from '@/lib/vault/types';

// Allow nested brackets to be ignored — Obsidian only treats *exactly* `[[X]]`
// as a link; `[[[X]]]` is a literal `[` plus a link. Our regex matches the
// inner pair lazily so the outer brackets stay in the body text.
const WIKILINK_REGEX = /\[\[([^\]\n[]+?)\]\]/g;

export function parseWikilinks(body: string): OutgoingLink[] {
  const out: OutgoingLink[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_REGEX.exec(body)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    // Obsidian supports `[[Target|alias]]` — split and keep target portion as
    // the lookup key.
    const target = raw.split('|', 1)[0].trim();
    if (!target) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push({ raw: target });
  }
  return out;
}
