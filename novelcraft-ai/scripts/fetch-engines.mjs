/**
 * fetch-engines.mjs
 *
 * Downloads pinned llama-server release archives for each supported target
 * and extracts ALL files into src-tauri/resources/engines/<target>/.
 *
 * Launch is macOS-only (Apple Silicon); when Windows joins the roadmap, add
 * its EngineSpec back here together with the nsis bundle target.
 *
 * The macOS build uses @rpath-linked dylibs that must live alongside the
 * llama-server binary — so we extract the full archive, not just the binary.
 *
 * Idempotency: a sidecar <target>/.archive-sha256 file stores the archive
 * hash. If it matches the pinned value the whole target dir is considered
 * up-to-date and the download is skipped.
 *
 * Usage:  node scripts/fetch-engines.mjs
 *         pnpm fetch-engines
 *
 * ── Pinned release ──────────────────────────────────────────────────────────
 * Tag:      b9209
 * Date:     2026-05-18
 * Page:     https://github.com/ggml-org/llama.cpp/releases/tag/b9209
 * ────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import {
  chmod, cp, mkdir, readdir, readFile, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ENGINE_MANIFEST_FILENAME,
  validateEngineManifest,
  writeEngineManifest,
} from './engine-manifest.mjs';

// ---------------------------------------------------------------------------
// Pinned asset table
// ---------------------------------------------------------------------------
// archiveSha256 is the sha256 of the downloaded archive file.
// Computed on 2026-05-18 by downloading and running `shasum -a 256`.
//
//   macos-arm64.tar.gz : bcc6eb8d9482ddd2885a52f6c25ded76eb655b70916c35bf70ab54f01b1d91bb
//
// INTEGRITY NOTE: these pins are *self-computed integrity-in-transit* hashes —
// they guarantee the downloaded bytes match what we hashed once, but carry NO
// upstream signature / provenance (llama.cpp releases are not GPG/cosign
// signed). They protect against a corrupted/MITM'd download, NOT against the
// upstream asset being re-tagged or replaced. When bumping RELEASE_TAG these
// values SHOULD be cross-checked against llama.cpp's own published release
// checksums (the release page / `gh release view`) before committing, and not
// merely re-derived from whatever we happened to download.

const RELEASE_TAG = 'b9209';
const BASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE_TAG}`;

/**
 * @typedef {{
 *   target: string,
 *   assetName: string,
 *   archiveSha256: string,
 *   stripComponents: number,   // tar --strip-components
 *   mainBinary: string,        // filename of the server binary after extraction
 * }} EngineSpec
 */

/** @type {EngineSpec[]} */
const ENGINES = [
  {
    // macOS Apple Silicon — Metal-accelerated build
    // The archive contains llama-b9209/{llama-server,*.dylib,...}
    // We strip 1 component so everything lands flat in <target>/
    target: 'aarch64-apple-darwin',
    assetName: `llama-${RELEASE_TAG}-bin-macos-arm64.tar.gz`,
    archiveSha256: 'bcc6eb8d9482ddd2885a52f6c25ded76eb655b70916c35bf70ab54f01b1d91bb',
    stripComponents: 1,
    mainBinary: 'llama-server',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ENGINES_DIR = join(REPO_ROOT, 'src-tauri', 'resources', 'engines');

/** Sha256 of a file on disk → lowercase hex. */
async function sha256File(filePath) {
  const hash = createHash('sha256');
  const data = await readFile(filePath);
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Stream-download a URL to a local path with a bounded retry + per-attempt
 * timeout. GitHub release URLs redirect to objects.githubusercontent.com; a
 * transient 5xx / connection reset on a single un-retried fetch would abort
 * the whole desktop build (this runs inside `beforeBuildCommand`), so we make
 * a few attempts with backoff before giving up.
 */
async function downloadTo(url, dest, assetName = url) {
  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 120_000;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      if (!res.body) throw new Error(`Empty response body fetching ${url}`);
      await pipeline(res.body, createWriteStream(dest));
      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        console.warn(
          `[download] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${assetName}: ${err?.message ?? err}; retrying in ${backoffMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw new Error(
    `Failed to download ${assetName} from ${url} after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? lastError}`
  );
}

/**
 * Extract a .tar.gz archive into destDir, stripping `strip` leading path
 * components (equivalent to tar --strip-components=N).
 *
 * SECURITY INVARIANT (Zip-Slip): this shells out to the system extractor,
 * which does NOT sanitize `../` / absolute member paths. The load-bearing
 * defense is that the caller verifies the archive sha256 against the pinned
 * value BEFORE calling the extractor (see fetchEngine: the sha256 gate runs
 * first, and on mismatch we throw without extracting). Do not move extraction
 * ahead of that check, and do not extract any archive whose digest was not
 * verified.
 */
function extractTarGz(archivePath, destDir, strip) {
  const result = spawnSync(
    'tar',
    ['-xzf', archivePath, `--strip-components=${strip}`, '-C', destDir],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error(`tar extraction failed (status ${result.status})`);
  }
}

// ---------------------------------------------------------------------------
// Per-engine fetch
// ---------------------------------------------------------------------------

/** @param {EngineSpec} engine */
async function fetchEngine(engine) {
  const destDir = join(ENGINES_DIR, engine.target);
  const sidecar = join(destDir, '.archive-sha256');
  const destBin = join(destDir, engine.mainBinary);

  // Idempotency check: trust the sidecar only when the hash matches AND the
  // main binary actually exists on disk. A crashed prior run can leave a
  // matching sidecar over a partially-extracted dir; mirroring the MLX path
  // (which checks existsSync on its products), we force a refetch when the
  // binary is missing rather than shipping an incomplete engine.
  if (existsSync(sidecar)) {
    const stored = (await readFile(sidecar, 'utf8')).trim();
    if (stored === engine.archiveSha256 && existsSync(destBin)) {
      const validation = await validateEngineManifest(destDir, engine.archiveSha256);
      if (validation.ok) {
        console.log(`[${engine.target}] cached — ${validation.entries} manifest entries verified`);
        return;
      }
      console.log(`[${engine.target}] cached manifest invalid (${validation.reason}) — re-downloading`);
    }
    if (stored === engine.archiveSha256) {
      console.log(`[${engine.target}] sidecar matches but ${engine.mainBinary} missing — re-downloading`);
    } else {
      console.log(`[${engine.target}] hash changed — re-downloading`);
    }
    // Wipe stale / partial extracted files
    await rm(destDir, { recursive: true, force: true });
  }

  await mkdir(destDir, { recursive: true });

  const tmpArchive = join(tmpdir(), `llama-engine-${engine.target}-${Date.now()}.tar.gz`);

  try {
    const url = `${BASE_URL}/${engine.assetName}`;
    console.log(`[${engine.target}] downloading ${url}`);
    await downloadTo(url, tmpArchive, engine.assetName);

    // Verify archive integrity before extracting
    const gotHash = await sha256File(tmpArchive);
    if (gotHash !== engine.archiveSha256) {
      throw new Error(
        `[${engine.target}] archive sha256 MISMATCH\n  expected: ${engine.archiveSha256}\n  got:      ${gotHash}`
      );
    }
    console.log(`[${engine.target}] archive sha256 OK`);

    // Extract full archive
    extractTarGz(tmpArchive, destDir, engine.stripComponents);

    // Ensure main binary is executable
    await chmod(join(destDir, engine.mainBinary), 0o755);

    // Record every extracted file and symlink, not merely the main binary.
    // Cache reuse is allowed only after the complete archive shape and digests
    // validate, so a missing dylib can never slip into a desktop package.
    await writeEngineManifest(destDir, engine.archiveSha256);

    // Write sidecar so next run is idempotent
    await writeFile(sidecar, engine.archiveSha256 + '\n', 'utf8');

    console.log(`[${engine.target}] installed with ${ENGINE_MANIFEST_FILENAME} → ${destDir}`);
  } finally {
    try { await unlink(tmpArchive); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// macOS-only: build + vendor the slim MLX OpenAI-compatible Swift server
// ---------------------------------------------------------------------------
//
// This is an ADDITIVE Apple-Silicon-accelerated engine. GGUF via the bundled
// llama-server (above) remains the always-available fallback on macOS, so a
// failure here is logged and tolerated — it must never block the product.
//
// IMPORTANT — build tool: the package is built with `xcodebuild`, NOT
// `swift build`. mlx-swift's own README states "SwiftPM (command line)
// cannot build the Metal shaders" — a plain `swift build` links the
// libraries but omits `default.metallib`, so the binary aborts on the first
// GPU op. `xcodebuild` runs the Metal toolchain and emits
// `mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib`. MLX locates
// that bundle relative to the executable, so we vendor the bundle ALONGSIDE
// the `mlx-server` binary.
//
// Idempotency: a sidecar `.mlx-src-sha256` in the target dir stores a hash
// over the package source (Package.swift + Sources/**). If the hash matches
// AND the vendored binary + bundle exist, the (slow) xcodebuild is skipped.

const MLX_PKG_DIR = join(REPO_ROOT, 'src-tauri', 'engines', 'mlx-server');
const MLX_TARGET = 'aarch64-apple-darwin';

/** Recursively list files under `dir`, returning absolute paths, sorted. */
async function listFilesRecursive(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

/** Hash of the MLX package inputs for idempotency. */
async function mlxSourceHash() {
  const hash = createHash('sha256');
  const roots = [
    join(MLX_PKG_DIR, 'Package.swift'),
    join(MLX_PKG_DIR, 'Package.resolved'),
    join(MLX_PKG_DIR, 'Sources'),
  ];
  const files = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const st = await stat(r);
    if (st.isDirectory()) files.push(...(await listFilesRecursive(r)));
    else files.push(r);
  }
  files.sort();
  for (const f of files) {
    hash.update(relative(MLX_PKG_DIR, f));
    hash.update(await readFile(f));
  }
  return hash.digest('hex');
}

async function buildMlxServer() {
  if (process.platform !== 'darwin') {
    console.log('[mlx-server] skipping (macOS-only engine)');
    return;
  }
  if (!existsSync(join(MLX_PKG_DIR, 'Package.swift'))) {
    console.log('[mlx-server] skipping (package source not found)');
    return;
  }

  const destDir = join(ENGINES_DIR, MLX_TARGET);
  const destBin = join(destDir, 'mlx-server');
  const destBundle = join(destDir, 'mlx-swift_Cmlx.bundle');
  const marker = join(destDir, '.mlx-src-sha256');

  const srcHash = await mlxSourceHash();

  // Idempotency: skip the (slow) xcodebuild if the source is unchanged AND
  // both the binary and its Metal bundle are already vendored.
  if (
    existsSync(marker) &&
    existsSync(destBin) &&
    existsSync(destBundle) &&
    (await readFile(marker, 'utf8')).trim() === srcHash
  ) {
    console.log('[mlx-server] cached — ok');
    return;
  }

  // A source/dependency hash mismatch means the vendored engine is no longer
  // valid for this build. Remove it before invoking xcodebuild so a transient
  // dependency failure cannot silently package yesterday's binary.
  await rm(destBin, { force: true });
  await rm(destBundle, { recursive: true, force: true });
  await rm(marker, { force: true });

  console.log('[mlx-server] building via xcodebuild (Release, arm64)…');
  const derivedData = join(MLX_PKG_DIR, '.build', 'xcode');
  const build = spawnSync(
    'xcodebuild',
    [
      'build',
      '-scheme', 'mlx-server',
      '-configuration', 'Release',
      '-destination', 'platform=macOS,arch=arm64',
      '-derivedDataPath', derivedData,
      '-skipPackagePluginValidation',
      '-skipMacroValidation',
      'ARCHS=arm64',
      'ONLY_ACTIVE_ARCH=YES',
      'CODE_SIGNING_ALLOWED=NO',
    ],
    { cwd: MLX_PKG_DIR, stdio: 'inherit' }
  );
  if (build.status !== 0) {
    // Non-fatal: GGUF/llama-server is the working mac fallback.
    console.warn(
      `[mlx-server] xcodebuild FAILED (status ${build.status}) — ` +
        'skipping MLX engine; GGUF via llama-server remains available.'
    );
    return;
  }

  const productsDir = join(derivedData, 'Build', 'Products', 'Release');
  const builtBin = join(productsDir, 'mlx-server');
  const builtBundle = join(productsDir, 'mlx-swift_Cmlx.bundle');
  if (!existsSync(builtBin) || !existsSync(builtBundle)) {
    console.warn(
      '[mlx-server] build succeeded but expected products missing ' +
        `(${builtBin} / ${builtBundle}) — skipping MLX engine.`
    );
    return;
  }

  await mkdir(destDir, { recursive: true });
  // Vendor the newly built binary + Metal bundle together.
  await cp(builtBin, destBin);
  await cp(builtBundle, destBundle, { recursive: true });
  await chmod(destBin, 0o755);
  await writeFile(marker, srcHash + '\n', 'utf8');

  console.log(`[mlx-server] installed → ${destBin} (+ mlx-swift_Cmlx.bundle)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  for (const engine of ENGINES) {
    await fetchEngine(engine);
  }

  // macOS-only additive MLX engine. Runs AFTER llama-server fetch and is
  // independently fault-tolerant so it can never break the GGUF path.
  try {
    await buildMlxServer();
  } catch (err) {
    console.warn('[mlx-server] unexpected error (non-fatal):', err);
  }

  console.log('fetch-engines done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
