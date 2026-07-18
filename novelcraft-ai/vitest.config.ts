import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Many route tests lazily `await import('./route')` inside the test body, which
    // triggers first-time transform/compile of heavy modules (Next.js, AI SDK,
    // better-sqlite3) under full-suite worker contention. The 5s default times out
    // non-deterministically even though the work itself completes in well under a
    // second once compiled. Give cold imports room so `pnpm test`/`pnpm verify` stay
    // deterministic; a genuine hang still trips at 30s.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Desktop packaging copies the full Next server into both the staged
    // resources tree and the Rust target bundle. Those are release artifacts,
    // not additional test projects; scanning them runs identical suites in
    // parallel against the same test DB and makes post-package verification
    // nondeterministic.
    exclude: [
      ...configDefaults.exclude,
      '.next/**',
      'src-tauri/resources/**',
      'src-tauri/target/**',
    ],
  },
  resolve: {
    alias: {
      '@': new URL('.', import.meta.url).pathname,
      // `server-only` throws on import in any non-RSC env (incl. this node
      // runtime), which would break every test that loads the DB layer. Stub it
      // to a no-op for tests; the real `next build` still enforces the boundary.
      'server-only': new URL('./vitest-stubs/server-only.ts', import.meta.url).pathname,
    },
  },
});
