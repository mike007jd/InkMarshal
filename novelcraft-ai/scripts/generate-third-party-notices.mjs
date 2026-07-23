import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(APP_ROOT, '..');
const OUTPUT_PATH = join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');
const PACKAGE_JSON_PATH = join(APP_ROOT, 'package.json');
const CARGO_ROOT = join(APP_ROOT, 'src-tauri');
const SWIFT_ROOT = join(CARGO_ROOT, 'engines', 'mlx-server');
const SWIFT_RESOLVED_PATH = join(SWIFT_ROOT, 'Package.resolved');
const CACHE_ROOT = join(APP_ROOT, 'node_modules', '.cache', 'inkmarshal-third-party-notices');
const CHECK_MODE = process.argv.includes('--check');

const EXTRA_ARGS = process.argv.slice(2).filter((arg) => arg !== '--check');
if (EXTRA_ARGS.length > 0) {
  throw new Error(`Unknown arguments: ${EXTRA_ARGS.join(', ')}`);
}

const MIT_TEXT = `MIT License

Copyright (c) <copyright holders listed in the attribution list above>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ISC_TEXT = `ISC License

Copyright (c) <copyright holders listed in the attribution list above>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

const ZLIB_TEXT = `zlib License

Copyright (c) <copyright holders listed in the attribution list above>

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use
of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a
   product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`;

const ZERO_BSD_TEXT = `BSD Zero Clause License

Copyright (C) <copyright holders listed in the attribution list above>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

const BSD_TWO_CLAUSE_TEXT = `BSD 2-Clause License

Copyright (c) <copyright holders listed in the attribution list above>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.`;

const BSD_THREE_CLAUSE_TEXT = `BSD 3-Clause License

Copyright (c) <copyright holders listed in the attribution list above>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.`;

const STANDARD_LICENSE_TEXTS = {
  MIT: MIT_TEXT,
  ISC: ISC_TEXT,
  Zlib: ZLIB_TEXT,
  '0BSD': ZERO_BSD_TEXT,
  'BSD-2-Clause': BSD_TWO_CLAUSE_TEXT,
  'BSD-3-Clause': BSD_THREE_CLAUSE_TEXT,
  'Apache-2.0': readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8').trim(),
};

// This list is based on the Release mlx-server LinkFileList produced by
// xcodebuild. Package.resolved contains additional build-only packages, which
// are deliberately excluded from the distributed-binary inventory.
const BUNDLED_SWIFT_IDENTITIES = new Map([
  ['eventsource', { license: 'MIT', attribution: 'Copyright 2025 Mattt (https://mat.tt)' }],
  ['mlx-swift', { license: 'MIT', attribution: 'Copyright (c) 2023 ml-explore' }],
  ['mlx-swift-lm', { license: 'MIT', attribution: 'Copyright (c) 2024 ml-explore' }],
  ['swift-argument-parser', { license: 'Apache-2.0' }],
  ['swift-atomics', { license: 'Apache-2.0' }],
  ['swift-collections', { license: 'Apache-2.0' }],
  ['swift-crypto', { license: 'Apache-2.0' }],
  ['swift-huggingface', { license: 'Apache-2.0' }],
  ['swift-jinja', { license: 'Apache-2.0' }],
  ['swift-nio', { license: 'Apache-2.0' }],
  ['swift-numerics', { license: 'Apache-2.0' }],
  ['swift-transformers', { license: 'Apache-2.0' }],
  ['yyjson', { license: 'MIT', attribution: 'Copyright (c) 2020 YaoYuan <ibireme@gmail.com>' }],
]);

const SWIFT_NOTICE_ARTIFACTS = {
  'swift-crypto': {
    revision: '1b6b2e274e85105bfa155183145a1dcfd63331f1',
    sha256: '821a918b1851c9309e88578a74f845303ac5ef4485a5497b95f68b20ac15c0e4',
    path: 'NOTICE.txt',
  },
  'swift-nio': {
    revision: 'cd3e1152083706d77b223fb29110e590efcc70c0',
    sha256: '697353cddfce615927de34f0dd0803dabc19f578db8d241e7341c515100a9606',
    path: 'NOTICE.txt',
  },
};

const SPDX_LICENSE_LIST_COMMIT = '5bf6d9610255540bfbee6890765a616042bf1e11';
const LGPL_ARTIFACT = {
  url:
    `https://raw.githubusercontent.com/spdx/license-list-data/${SPDX_LICENSE_LIST_COMMIT}` +
    '/text/LGPL-3.0-only.txt',
  sha256: '6a6609aa2ab575dfd896d395b3bebc4c06937b10fcfdc818c9de25bb7def157b',
};

const SHARP_LIBVIPS_ARTIFACTS = {
  '1.3.2': {
    url: 'https://raw.githubusercontent.com/lovell/sharp-libvips/v1.3.2/THIRD-PARTY-NOTICES.md',
    sha256: '5362d1fe182e15e8a11df1e511ce8e64a7be5e2db34ce0f6690e6140173b3a6a',
  },
};

const NATIVE_NPM_PACKAGES = new Set([
  'better-sqlite3',
  'sharp',
  '@img/sharp-darwin-arm64',
  '@img/sharp-libvips-darwin-arm64',
]);

const LICENSE_IDS = [
  'LGPL-3.0-or-later',
  'GPL-3.0-or-later',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'CDLA-Permissive-2.0',
  'Unicode-3.0',
  'MPL-2.0',
  'CC0-1.0',
  'MIT-0',
  'Unlicense',
  'WTFPL',
  'AFL-2.1',
  'BSL-1.0',
  '0BSD',
  'Zlib',
  'ISC',
  'MIT',
  'BSD',
];

const LICENSE_CHOICE_ORDER = [
  'Apache-2.0',
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Zlib',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'MPL-2.0',
  'Unicode-3.0',
  'CC-BY-4.0',
  'CDLA-Permissive-2.0',
  'LGPL-3.0-or-later',
  'GPL-3.0-or-later',
  'BSL-1.0',
  'AFL-2.1',
  'WTFPL',
  'BSD',
];

const FORCE_PER_COMPONENT_IDS = new Set([
  'BSD',
  'MPL-2.0',
  'LGPL-3.0-or-later',
  'GPL-3.0-or-later',
  'CC-BY-4.0',
]);

function normalizeText(text) {
  return text.replaceAll('\r\n', '\n').replace(/[ \t]+$/gm, '').trim();
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runJson(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? 'unknown'}):\n` +
        `${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Could not parse JSON from ${command} ${args.join(' ')}: ${error.message}\n${result.stdout}`,
    );
  }
}

function normalizeRepository(repository, homepage) {
  let value = typeof repository === 'string' ? repository : repository?.url;
  value ||= homepage;
  if (!value) return null;
  value = value
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git(#.*)?$/, '$1');
  return value.startsWith('http://') || value.startsWith('https://') ? value : null;
}

function authorText(author, fallback = null) {
  if (typeof author === 'string' && author.trim()) return author.trim();
  if (author && typeof author === 'object') {
    const name = author.name?.trim();
    const email = author.email?.trim();
    if (name && email) return `${name} <${email}>`;
    if (name) return name;
  }
  if (Array.isArray(author) && author.length > 0) return author.join(', ');
  return fallback;
}

function legalFiles(packageDir, explicitLicenseFile = null) {
  const files = [];
  if (explicitLicenseFile && existsSync(explicitLicenseFile)) {
    files.push(explicitLicenseFile);
  }
  for (const name of readdirSync(packageDir, { withFileTypes: true })) {
    if (!name.isFile()) continue;
    if (!/^(licen[cs]e|copying|copyright|notice)([-_.].*)?$/i.test(name.name)) continue;
    files.push(join(packageDir, name.name));
  }
  const unique = [...new Set(files)].sort();
  const licenses = [];
  const notices = [];
  for (const path of unique) {
    const item = { name: path.slice(packageDir.length + 1), text: normalizeText(readFileSync(path, 'utf8')) };
    if (/^notice/i.test(item.name)) notices.push(item);
    else licenses.push(item);
  }
  return { licenses, notices };
}

function extractAttributions(licenseTexts, fallback) {
  const lines = [];
  for (const item of licenseTexts) {
    for (const line of item.text.split('\n')) {
      const compact = line.trim().replace(/^[#/*\s-]+/, '').trim();
      if (/copyright|©|\(c\)/i.test(compact) && compact.length <= 300) {
        lines.push(compact);
      }
    }
  }
  if (lines.length === 0 && fallback) lines.push(fallback);
  return [...new Set(lines)].sort((a, b) => a.localeCompare(b, 'en'));
}

function stripOuterParens(value) {
  let output = value.trim();
  while (output.startsWith('(') && output.endsWith(')')) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < output.length; index += 1) {
      if (output[index] === '(') depth += 1;
      if (output[index] === ')') depth -= 1;
      if (depth === 0 && index < output.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression) break;
    output = output.slice(1, -1).trim();
  }
  return output;
}

function splitTopLevelAnd(expression) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === '(') depth += 1;
    if (expression[index] === ')') depth -= 1;
    if (depth === 0 && expression.slice(index, index + 5) === ' AND ') {
      parts.push(expression.slice(start, index));
      start = index + 5;
      index += 4;
    }
  }
  parts.push(expression.slice(start));
  return parts.map(stripOuterParens).filter(Boolean);
}

function idsInExpression(expression) {
  return LICENSE_IDS.filter((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9.-])${escaped}([^A-Za-z0-9.-]|$)`).test(expression);
  });
}

function chooseComplianceLicenses(expression) {
  const normalized = stripOuterParens(expression.replace(/\s*\/\s*/g, ' OR '));
  const andParts = splitTopLevelAnd(normalized);
  if (andParts.length > 1) {
    return [...new Set(andParts.flatMap(chooseComplianceLicenses))];
  }
  const candidates = idsInExpression(normalized);
  const selected = LICENSE_CHOICE_ORDER.find((id) => candidates.includes(id));
  if (!selected) {
    throw new Error(`No supported compliance license choice for expression: ${expression}`);
  }
  return [selected];
}

function npmEntries() {
  const packageJson = readJson(PACKAGE_JSON_PATH);
  const expectedPnpm = packageJson.packageManager?.split('@').at(-1);
  const versionResult = spawnSync('pnpm', ['--version'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  if (versionResult.status !== 0) {
    throw new Error(`pnpm --version failed: ${versionResult.stderr || versionResult.stdout}`);
  }
  const actualPnpm = versionResult.stdout.trim();
  if (actualPnpm !== expectedPnpm) {
    throw new Error(`Expected pnpm ${expectedPnpm}, got ${actualPnpm}. Activate the project Corepack pin.`);
  }

  const report = runJson('pnpm', ['licenses', 'list', '--prod', '--json'], APP_ROOT);
  const entries = [];
  for (const [reportedLicense, packages] of Object.entries(report)) {
    for (const packageReport of packages) {
      for (const packagePath of packageReport.paths) {
        const metadata = readJson(join(packagePath, 'package.json'));
        const license = metadata.license || reportedLicense;
        const files = legalFiles(packagePath);
        entries.push({
          ecosystem: 'npm',
          name: metadata.name || packageReport.name,
          version: metadata.version,
          declaredLicense: license,
          complianceLicenses: chooseComplianceLicenses(license),
          sourceUrl:
            normalizeRepository(metadata.repository, metadata.homepage) ||
            `https://www.npmjs.com/package/${encodeURIComponent(metadata.name || packageReport.name)}/v/${metadata.version}`,
          licenseTexts: files.licenses,
          notices: files.notices,
          attributions: extractAttributions(
            files.licenses,
            authorText(metadata.author, authorText(packageReport.author)),
          ),
          manualCategory: NATIVE_NPM_PACKAGES.has(metadata.name) ? 'Native Node component' : null,
        });
      }
    }
  }
  return deduplicateEntries(entries);
}

function cargoEntries() {
  const metadata = runJson(
    'cargo',
    ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin'],
    CARGO_ROOT,
  );
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodesById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const included = new Set();
  const queue = [metadata.resolve.root];
  while (queue.length > 0) {
    const id = queue.shift();
    const node = nodesById.get(id);
    if (!node) continue;
    for (const dependency of node.deps) {
      if (!dependency.dep_kinds.some((kind) => kind.kind === null)) continue;
      if (included.has(dependency.pkg)) continue;
      included.add(dependency.pkg);
      queue.push(dependency.pkg);
    }
  }

  return deduplicateEntries(
    [...included].map((id) => {
      const metadataPackage = packagesById.get(id);
      if (!metadataPackage?.license) {
        throw new Error(`Cargo package ${metadataPackage?.name || id} has no declared license.`);
      }
      const packageDir = dirname(metadataPackage.manifest_path);
      const explicitLicenseFile = metadataPackage.license_file
        ? resolve(packageDir, metadataPackage.license_file)
        : null;
      const files = legalFiles(packageDir, explicitLicenseFile);
      return {
        ecosystem: 'Cargo',
        name: metadataPackage.name,
        version: metadataPackage.version,
        declaredLicense: metadataPackage.license,
        complianceLicenses: chooseComplianceLicenses(metadataPackage.license),
        sourceUrl:
          normalizeRepository(metadataPackage.repository, metadataPackage.homepage) ||
          `https://crates.io/crates/${metadataPackage.name}/${metadataPackage.version}`,
        licenseTexts: files.licenses,
        notices: files.notices,
        attributions: extractAttributions(files.licenses, authorText(metadataPackage.authors)),
        manualCategory: null,
      };
    }),
  );
}

async function cachedRemoteText({ url, sha256: expectedSha }) {
  await mkdir(CACHE_ROOT, { recursive: true });
  const cachePath = join(CACHE_ROOT, `${expectedSha}.txt`);
  if (existsSync(cachePath)) {
    const cached = normalizeText(await readFile(cachePath, 'utf8'));
    if (sha256(cached) === expectedSha) return cached;
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = normalizeText(await response.text());
      const actualSha = sha256(text);
      if (actualSha !== expectedSha) {
        throw new Error(`sha256 mismatch: expected ${expectedSha}, got ${actualSha}`);
      }
      await writeFile(cachePath, `${text}\n`, 'utf8');
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((done) => setTimeout(done, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(`Could not fetch pinned license artifact ${url}: ${lastError?.message || lastError}`);
}

async function swiftEntries() {
  const resolved = readJson(SWIFT_RESOLVED_PATH);
  const pins = new Map(resolved.pins.map((pin) => [pin.identity.toLowerCase(), pin]));
  const entries = [];
  for (const [identity, manual] of BUNDLED_SWIFT_IDENTITIES) {
    const pin = pins.get(identity);
    if (!pin) throw new Error(`Bundled Swift dependency ${identity} is absent from Package.resolved.`);
    const sourceBase = pin.location.replace(/\.git$/, '');
    const revision = pin.state.revision;
    const noticeSpec = SWIFT_NOTICE_ARTIFACTS[identity];
    const notices = [];
    if (noticeSpec) {
      if (noticeSpec.revision !== revision) {
        throw new Error(
          `${identity} revision changed to ${revision}; refresh its pinned NOTICE artifact and sha256.`,
        );
      }
      notices.push({
        name: noticeSpec.path,
        text: await cachedRemoteText({
          url: `${sourceBase.replace('https://github.com', 'https://raw.githubusercontent.com')}/${revision}/${noticeSpec.path}`,
          sha256: noticeSpec.sha256,
        }),
      });
    }
    entries.push({
      ecosystem: 'SwiftPM',
      name: identity,
      version: pin.state.version || revision.slice(0, 12),
      declaredLicense: manual.license,
      complianceLicenses: [manual.license],
      sourceUrl: `${sourceBase}/tree/${revision}`,
      licenseTexts: [],
      notices,
      attributions: manual.attribution ? [manual.attribution] : [identity],
      manualCategory: 'MLX Swift linked dependency',
    });
  }
  return entries;
}

function nodeRuntimeEntry() {
  const version = process.versions.node;
  const localLicensePath = resolve(dirname(process.execPath), '..', 'LICENSE');
  if (!existsSync(localLicensePath)) {
    throw new Error(`Node.js ${version} LICENSE not found beside the runtime: ${localLicensePath}`);
  }
  return {
    ecosystem: 'Runtime',
    name: 'Node.js',
    version,
    declaredLicense: 'MIT + bundled third-party terms',
    complianceLicenses: [],
    sourceUrl: `https://github.com/nodejs/node/tree/v${version}`,
    licenseTexts: [],
    notices: [],
    attributions: ['Copyright Node.js contributors. All rights reserved.'],
    specificLicenseText: normalizeText(readFileSync(localLicensePath, 'utf8')),
    specificLicenseLabel: 'Node.js LICENSE and bundled third-party terms',
    manualCategory: 'Bundled runtime',
  };
}

function llamaEntry() {
  const version = 'b9209';
  const fetchScript = readFileSync(join(APP_ROOT, 'scripts', 'fetch-engines.mjs'), 'utf8');
  if (!fetchScript.includes(`const RELEASE_TAG = '${version}'`)) {
    throw new Error(`llama.cpp release pin changed; update the manual notice entry from ${version}.`);
  }
  const licensePath = join(
    CARGO_ROOT,
    'resources',
    'engines',
    'aarch64-apple-darwin',
    'LICENSE',
  );
  if (!existsSync(licensePath)) throw new Error(`Vendored llama.cpp LICENSE is missing: ${licensePath}`);
  const text = normalizeText(readFileSync(licensePath, 'utf8'));
  return {
    ecosystem: 'Engine',
    name: 'llama.cpp / llama-server',
    version,
    declaredLicense: 'MIT',
    complianceLicenses: ['MIT'],
    sourceUrl: `https://github.com/ggml-org/llama.cpp/tree/${version}`,
    licenseTexts: [{ name: 'LICENSE', text }],
    notices: [],
    attributions: extractAttributions([{ name: 'LICENSE', text }], 'The ggml authors'),
    manualCategory: 'Bundled GGUF engine',
  };
}

async function enrichSharpLibvips(entries) {
  const entry = entries.find(
    (candidate) =>
      candidate.ecosystem === 'npm' && candidate.name === '@img/sharp-libvips-darwin-arm64',
  );
  if (!entry) {
    throw new Error('Expected bundled native package @img/sharp-libvips-darwin-arm64 is missing.');
  }
  const noticeArtifact = SHARP_LIBVIPS_ARTIFACTS[entry.version];
  if (!noticeArtifact) {
    throw new Error(
      `sharp-libvips ${entry.version} has no reviewed third-party-notice artifact mapping.`,
    );
  }
  entry.specificLicenseText = await cachedRemoteText(LGPL_ARTIFACT);
  entry.specificLicenseLabel = 'LGPL-3.0-only full text (selected for LGPL-3.0-or-later)';
  entry.notices.push({
    name: `sharp-libvips v${entry.version} THIRD-PARTY-NOTICES.md`,
    text: await cachedRemoteText(noticeArtifact),
  });
}

function deduplicateEntries(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.ecosystem}:${entry.name}@${entry.version}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    existing.licenseTexts.push(...entry.licenseTexts);
    existing.notices.push(...entry.notices);
    existing.attributions = [...new Set([...existing.attributions, ...entry.attributions])];
  }
  return [...byKey.values()];
}

function entryKey(entry) {
  return `${entry.ecosystem}:${entry.name}@${entry.version}`;
}

function entryLabel(entry) {
  return `${entry.ecosystem} \`${entry.name}\` ${entry.version}`;
}

function markdownEscape(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function sourceLink(entry) {
  return `[source](${entry.sourceUrl})`;
}

function textFence(text) {
  return `\`\`\`\`text\n${normalizeText(text)}\n\`\`\`\``;
}

function specificTextFor(entry, licenseId) {
  if (entry.specificLicenseText) return entry.specificLicenseText;
  const tokenById = {
    'BSD-2-Clause': /bsd[-_. ]?2/i,
    'BSD-3-Clause': /bsd[-_. ]?3/i,
    'MPL-2.0': /mpl/i,
    'CC-BY-4.0': /cc[-_. ]?by/i,
    'Unicode-3.0': /unicode/i,
    'CC0-1.0': /cc0/i,
    'CDLA-Permissive-2.0': /cdla/i,
    'BlueOak-1.0.0': /blueoak/i,
    BSL: /boost|bsl/i,
  };
  const matcher = tokenById[licenseId];
  const matched = matcher && entry.licenseTexts.find((item) => matcher.test(item.name));
  return matched?.text || entry.licenseTexts[0]?.text || null;
}

function renderInventory(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.declaredLicense) || [];
    group.push(entry);
    groups.set(entry.declaredLicense, group);
  }
  const sections = [];
  for (const license of [...groups.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const rows = groups
      .get(license)
      .sort(compareEntries)
      .map(
        (entry) =>
          `| ${markdownEscape(entry.ecosystem)} | \`${markdownEscape(entry.name)}\` | ` +
          `${markdownEscape(entry.version)} | ${sourceLink(entry)} |`,
      );
    sections.push(
      `### ${license}\n\n| Ecosystem | Name | Version | Source |\n|---|---|---:|---|\n${rows.join('\n')}`,
    );
  }
  return sections.join('\n\n');
}

function compareEntries(a, b) {
  return (
    a.ecosystem.localeCompare(b.ecosystem, 'en') ||
    a.name.localeCompare(b.name, 'en') ||
    a.version.localeCompare(b.version, 'en', { numeric: true })
  );
}

function renderStandardLicenses(entries) {
  const sections = [];
  for (const [licenseId, licenseText] of Object.entries(STANDARD_LICENSE_TEXTS)) {
    const owners = entries
      .filter((entry) => entry.complianceLicenses.includes(licenseId))
      .sort(compareEntries);
    if (owners.length === 0) continue;
    const attributionLines = owners.map((entry) => {
      const attribution =
        entry.attributions.length > 0 ? entry.attributions.join('; ') : 'See linked source';
      return `- ${entryLabel(entry)} — ${attribution}`;
    });
    sections.push(
      `### ${licenseId}\n\nApplied to:\n\n${attributionLines.join('\n')}\n\n${textFence(licenseText)}`,
    );
  }
  return sections.join('\n\n');
}

function renderSpecificLicenses(entries) {
  const specific = [];
  const fallbackTextByLicense = new Map();
  for (const entry of entries) {
    for (const licenseId of entry.complianceLicenses) {
      if (STANDARD_LICENSE_TEXTS[licenseId]) continue;
      const text = specificTextFor(entry, licenseId);
      if (text && !fallbackTextByLicense.has(licenseId)) {
        fallbackTextByLicense.set(licenseId, text);
      }
    }
  }
  for (const entry of entries.sort(compareEntries)) {
    if (entry.specificLicenseText) {
      specific.push({
        id: entry.specificLicenseLabel || entry.declaredLicense,
        entry,
        text: entry.specificLicenseText,
        force: true,
      });
    }
    for (const licenseId of entry.complianceLicenses) {
      if (STANDARD_LICENSE_TEXTS[licenseId]) continue;
      if (entry.specificLicenseText && licenseId === 'LGPL-3.0-or-later') continue;
      const text = specificTextFor(entry, licenseId) || fallbackTextByLicense.get(licenseId);
      if (!text) {
        throw new Error(
          `No full text available for ${licenseId}: ${entryKey(entry)} (${entry.declaredLicense})`,
        );
      }
      specific.push({
        id: licenseId,
        entry,
        text,
        force: FORCE_PER_COMPONENT_IDS.has(licenseId),
      });
    }
  }

  const sections = [];
  const grouped = new Map();
  for (const item of specific) {
    const key = item.force ? `${entryKey(item.entry)}:${item.id}` : `${item.id}:${sha256(item.text)}`;
    const group = grouped.get(key) || [];
    group.push(item);
    grouped.set(key, group);
  }
  for (const group of [...grouped.values()].sort((a, b) => {
    return a[0].id.localeCompare(b[0].id, 'en') || compareEntries(a[0].entry, b[0].entry);
  })) {
    const first = group[0];
    const owners = group.map((item) => `- ${entryLabel(item.entry)} — ${sourceLink(item.entry)}`);
    sections.push(
      `### ${first.id}\n\nApplies to:\n\n${owners.join('\n')}\n\n${textFence(first.text)}`,
    );
  }
  return sections.join('\n\n');
}

function renderPreservedNotices(entries) {
  const sections = [];
  for (const entry of entries.sort(compareEntries)) {
    for (const notice of entry.notices) {
      sections.push(
        `### ${entryLabel(entry)} — ${notice.name}\n\n${sourceLink(entry)}\n\n${textFence(notice.text)}`,
      );
    }
  }
  return sections.length > 0 ? sections.join('\n\n') : '_No additional NOTICE files._';
}

function renderManualComponents(entries) {
  const rows = entries
    .filter((entry) => entry.manualCategory)
    .sort(compareEntries)
    .map(
      (entry) =>
        `| ${markdownEscape(entry.manualCategory)} | \`${markdownEscape(entry.name)}\` | ` +
        `${markdownEscape(entry.version)} | ${markdownEscape(entry.declaredLicense)} | ${sourceLink(entry)} |`,
    );
  return `| Distribution role | Name | Version | Declared license | Source |
|---|---|---:|---|---|
${rows.join('\n')}`;
}

function renderDocument(entries, counts) {
  return `# InkMarshal Third-Party Notices

> Generated by \`novelcraft-ai/scripts/generate-third-party-notices.mjs\`.
> Do not edit this file by hand. Run the generator after dependency, runtime,
> engine, or desktop packaging changes.

InkMarshal is distributed under Apache-2.0. This document records third-party
software included in the macOS Apple Silicon desktop application. The inventory
contains production npm dependencies, normal Cargo dependencies linked for
\`aarch64-apple-darwin\`, the linked MLX Swift dependency closure, native Node
components, the bundled Node.js runtime, and the bundled llama.cpp engine.
Development-only npm dependencies and Cargo build/dev dependencies are excluded.

Inventory totals: ${counts.npm} npm packages, ${counts.cargo} Cargo crates,
${counts.swift} linked Swift packages, and ${counts.manualOnly} standalone
runtime/engine entries.

## Bundled runtimes, engines, and native components

${renderManualComponents(entries)}

## Inventory by declared license

License expressions are preserved as published by each dependency. Where an
expression offers alternatives, the full-text section uses a compatible
permissive branch (preferring Apache-2.0, then MIT); every conjunctive license
requirement is retained.

${renderInventory(entries)}

## Consolidated standard license texts and attributions

The following identical standard texts are included once, with the complete
component and attribution list immediately above each text.

${renderStandardLicenses(entries)}

## Component-specific and non-standard license texts

BSD variants, MPL, copyleft, content licenses, composite runtime licenses, and
other non-standard terms are preserved with the component(s) to which the exact
text applies.

${renderSpecificLicenses(entries)}

## Preserved upstream NOTICE and attribution files

${renderPreservedNotices(entries)}
`;
}

async function main() {
  if (Number.parseInt(process.versions.node.split('.')[0], 10) !== 24) {
    throw new Error(`Node 24 is required; current runtime is ${process.version}.`);
  }

  const npm = npmEntries();
  const cargo = cargoEntries();
  const swift = await swiftEntries();
  await enrichSharpLibvips(npm);
  const manualOnly = [nodeRuntimeEntry(), llamaEntry()];
  const entries = deduplicateEntries([...npm, ...cargo, ...swift, ...manualOnly]).sort(compareEntries);
  const generated = renderDocument(entries, {
    npm: npm.length,
    cargo: cargo.length,
    swift: swift.length,
    manualOnly: manualOnly.length,
  }).replaceAll('\t', '    ');

  if (CHECK_MODE) {
    if (!existsSync(OUTPUT_PATH)) {
      throw new Error(`Missing ${OUTPUT_PATH}; run the generator without --check.`);
    }
    const current = normalizeText(await readFile(OUTPUT_PATH, 'utf8'));
    if (current !== normalizeText(generated)) {
      throw new Error(
        'THIRD_PARTY_NOTICES.md is stale. Run node scripts/generate-third-party-notices.mjs.',
      );
    }
    console.log(
      `THIRD_PARTY_NOTICES.md is current (${npm.length} npm, ${cargo.length} Cargo, ` +
        `${swift.length} Swift, ${manualOnly.length} runtime/engine).`,
    );
    return;
  }

  await writeFile(OUTPUT_PATH, generated, 'utf8');
  console.log(
    `Generated ${OUTPUT_PATH} (${npm.length} npm, ${cargo.length} Cargo, ` +
      `${swift.length} Swift, ${manualOnly.length} runtime/engine).`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
