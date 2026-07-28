import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const excludedDirectories = new Set([
  '.git',
  '.next',
  'dist',
  'node_modules',
  'target',
]);
const englishExceptions = new Set([
  'PRIVACY.md',
  'README_zh-CN.md',
  'THIRD_PARTY_NOTICES.md',
]);
const proseLineLimit = 240;
const nonblankLineLimit = 160;
const wordLimit = 800;

function collectMarkdown(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdown(absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function isEnglishDeveloperDoc(file) {
  return !englishExceptions.has(relative(file));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function validateEnglishAndSize(file, failures) {
  const rel = relative(file);
  const text = readFileSync(file, 'utf8');
  const han = text.match(/\p{Script=Han}/u);
  if (han?.index !== undefined) {
    failures.push(`${rel}:${lineNumberAt(text, han.index)} contains Han text`);
  }

  const lines = text.split(/\r?\n/);
  const nonblank = lines.filter(line => line.trim()).length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (nonblank > nonblankLineLimit) {
    failures.push(`${rel} has ${nonblank} nonblank lines; limit is ${nonblankLineLimit}`);
  }
  if (words > wordLimit) {
    failures.push(`${rel} has ${words} words; limit is ${wordLimit}`);
  }

  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    const trimmed = line.trim();
    if (!inFence && trimmed && !trimmed.startsWith('|') && line.length > proseLineLimit) {
      failures.push(`${rel}:${index + 1} has a ${line.length}-character prose line; limit is ${proseLineLimit}`);
    }
  });
}

function validateLocalLinks(file, failures) {
  const rel = relative(file);
  const text = readFileSync(file, 'utf8');
  const linkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#|\/)/.test(target)) continue;
    target = target.split('#', 1)[0];
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      failures.push(`${rel}:${lineNumberAt(text, match.index ?? 0)} has an invalid encoded link`);
      continue;
    }
    const absolute = path.resolve(path.dirname(file), target);
    const insideRepo = absolute === repoRoot || absolute.startsWith(`${repoRoot}${path.sep}`);
    if (insideRepo && !existsSync(absolute)) {
      failures.push(`${rel}:${lineNumberAt(text, match.index ?? 0)} links to missing ${target}`);
    }
  }
}

const markdownFiles = collectMarkdown(repoRoot).sort();
const englishDocs = markdownFiles.filter(isEnglishDeveloperDoc);
const failures = [];

for (const file of englishDocs) validateEnglishAndSize(file, failures);
for (const file of markdownFiles) {
  if (relative(file) !== 'THIRD_PARTY_NOTICES.md') validateLocalLinks(file, failures);
}

const claudeImport = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8').trim();
if (claudeImport !== '@AGENTS.md') {
  failures.push('CLAUDE.md must contain only @AGENTS.md so agent rules have one source');
}

for (const file of markdownFiles) {
  if (statSync(file).size === 0) failures.push(`${relative(file)} is empty`);
}

if (failures.length) {
  console.error(`Documentation checks failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`Documentation checks passed: ${englishDocs.length} English developer docs, ${markdownFiles.length} Markdown files.`);
