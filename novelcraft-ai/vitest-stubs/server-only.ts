// Test stub for the `server-only` package. The real package throws on import in
// any non-React-Server-Component environment — including the vitest node runtime
// — which would break every test that transitively loads the DB layer. vitest
// aliases `server-only` to this no-op (see vitest.config.ts). The production
// `next build` still uses the real package, so the client/server boundary stays
// enforced where it matters.
export {};
